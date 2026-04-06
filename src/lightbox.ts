import { springStep, SPRING_MORPH, SPRING_OPEN, SPRING_CLOSE } from './physics/spring';
import type { SpringConfig, SpringState, SpringStepResult } from './physics/spring';
// Note: easing.ts is no longer used — all animations are rAF + spring physics

export type LightboxEventType =
  | 'open'
  | 'opened'
  | 'close'
  | 'closed'
  | 'navigate'
  | 'zoomIn'
  | 'zoomOut';

export interface LightboxEventDetail {
  /** The full-res image URL */
  src: string;
  /** The trigger element (anchor or element with data-lightbox) */
  triggerEl: HTMLElement;
  /** Current index in the gallery (0 for standalone images) */
  index: number;
  /** Total items in the gallery (1 for standalone images) */
  total: number;
}

export type LightboxEventCallback = (detail: LightboxEventDetail) => void;

export interface LightboxOptions {
  selector?: string;
  springOpen?: SpringConfig;
  springClose?: SpringConfig;
  padding?: number;
  debug?: boolean;
}

const DEFAULTS: Required<LightboxOptions> = {
  selector: '[data-lightbox]',
  springOpen: SPRING_OPEN,
  springClose: SPRING_CLOSE,
  padding: 40,
  debug: false,
};

// Spinner shown while loading an image triggered from a text link.
const SPINNER_DELAY_MS = 300;

// For text-link triggers, the image stays fully opaque until the backdrop
// drops below this threshold, then fades proportionally. Keeps the image
// visible through ~80% of the close animation and fades quickly at the end.
const TEXT_LINK_OPACITY_THRESHOLD = 0.2;

// Default border-radius for lightbox images on desktop (px).
// On mobile (≤600px) the image goes edge-to-edge, so radius is 0.
const DESKTOP_BORDER_RADIUS = 24;

interface LightboxState {
  isOpen: boolean;
  isAnimating: boolean;
  isClosing: boolean;
  triggerEl: HTMLElement | null;
  currentSrc: string;
}

interface ZoomState {
  zoomed: boolean;
  zoomingOut: boolean;
  fitRect: DOMRect;
  naturalWidth: number;
  naturalHeight: number;
  scale: number;
  panX: number;
  panY: number;
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  dragStartPanX: number;
  dragStartPanY: number;
  dragMoved: boolean;
}

interface AnimState {
  translateX: number;
  translateY: number;
  scale: number;
  opacity: number;
  crop: number;
  borderRadius: number;
}

interface PinchState {
  active: boolean;
  initialDistance: number;
  initialScale: number;
  initialPanX: number;
  initialPanY: number;
  initialMidX: number;
  initialMidY: number;
  prevScale: number;
  prevScaleTime: number;
}

interface VelocitySample {
  x: number;
  y: number;
  t: number;
}

interface DismissState {
  tracking: boolean; // Pointer down at scale=1, waiting to determine axis
  active: boolean; // Vertical axis confirmed, dismiss gesture in progress
  fromOverlay: boolean; // Gesture started on overlay (not image) — tap should close
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  opacity: number;
}

interface GalleryItem {
  triggerEl: HTMLElement;
  src: string;
  thumbSrc: string;
  caption: string;
  alt: string;
}

interface SwipeNavState {
  active: boolean;
  startX: number;
  offsetX: number;
  initialOffset: number; // Strip offset when swipe started (for interrupted springs)
}

const PRELOAD_DELAY = 80;
const DRAG_THRESHOLD = 4;
const AXIS_LOCK_THRESHOLD = 10;
const RUBBER_BAND_FACTOR = 0.35;
const VELOCITY_WINDOW = 80;
const PAN_SPRING: SpringConfig = { stiffness: 170, damping: 26, mass: 1 };
const SNAP_SPRING: SpringConfig = { stiffness: 300, damping: 30, mass: 1 };
const PINCH_RUBBER_BAND_FACTOR = 0.4;
const PINCH_DISMISS_RUBBER_BAND_FACTOR = 0.65;
const PINCH_CLOSE_SCALE = 0.8; // Displayed scale below which pinch commits close
const PINCH_CLOSE_VELOCITY = -2; // Scale/s velocity that commits close regardless of scale
const SLIDE_GAP = 16;
const SWIPE_VELOCITY_THRESHOLD = 300;
const SWIPE_DISTANCE_THRESHOLD = 0.3;
const PRESS_SPRING: SpringConfig = { stiffness: 300, damping: 20, mass: 1 };

// Wheel scroll thresholds
const WHEEL_NAV_THRESHOLD = 60; // Accumulated horizontal px to commit navigate
const WHEEL_DISMISS_THRESHOLD = 150; // Accumulated vertical px to commit dismiss
const WHEEL_DISMISS_VELOCITY = 600; // Simulated velocity for wheel-driven dismiss close

export class Lightbox {
  private static instance: Lightbox | null = null;
  private opts: Required<LightboxOptions>;
  private listeners = new Map<LightboxEventType, Set<LightboxEventCallback>>();
  private state: LightboxState = {
    isOpen: false,
    isAnimating: false,
    isClosing: false,
    triggerEl: null,
    currentSrc: '',
  };

  private zoom: ZoomState = this.defaultZoomState();

  // DOM
  private overlay: HTMLDivElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private imgEl: HTMLImageElement | null = null;

  // Strip DOM (gallery slide container)
  private stripEl: HTMLDivElement | null = null;
  private currentSlideEl: HTMLDivElement | null = null;
  private prevSlideEl: HTMLDivElement | null = null;
  private prevSlideImg: HTMLImageElement | null = null;
  private nextSlideEl: HTMLDivElement | null = null;
  private nextSlideImg: HTMLImageElement | null = null;

  // Gallery
  private gallery: GalleryItem[] = [];
  private currentIndex: number = 0;
  private userHasNavigated: boolean = false;

  // Strip animation
  private stripRafId: number | null = null;
  private stripOffset: number = 0;
  private pendingNavDirection: (1 | -1) | null = null;
  private swipeNav: SwipeNavState = this.defaultSwipeNavState();

  // Preload
  private preloadCache = new Map<string, HTMLImageElement>();
  private preloadTimer: ReturnType<typeof setTimeout> | null = null;
  private preloadQueue: string[] = [];
  private preloadingActive: boolean = false;

  // Velocity tracking
  private velocitySamples: VelocitySample[] = [];

  // Pointer cache for multi-touch (pinch)
  private pointerCache: PointerEvent[] = [];
  private pinch: PinchState = this.defaultPinchState();
  private dismiss: DismissState = this.defaultDismissState();

  // rAF animation handle (single loop for all spring animations)
  private rafId: number | null = null;
  // Separate rAF for trigger bounce (runs independently after close)
  private bounceRafId: number | null = null;

  // Crop insets for object-fit:cover thumbnail animation (pixels in lightbox image space)
  private cropInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  // Border-radius of the thumbnail trigger (px), read on open for close morph
  private thumbBorderRadius: number = 0;

  // Text-link trigger: no FLIP morph, load then fade in
  private isTextLink = false;
  private spinnerEl: HTMLDivElement | null = null;
  private spinnerTimer: ReturnType<typeof setTimeout> | null = null;

  // Chrome UI (caption bar, arrows, close button)
  private chromeBar: HTMLDivElement | null = null;
  private chromeCounter: HTMLSpanElement | null = null;
  private chromeCaption: HTMLSpanElement | null = null;
  private chromeClose: HTMLButtonElement | null = null;
  private chromePrev: HTMLButtonElement | null = null;
  private chromeNext: HTMLButtonElement | null = null;
  private chromeRafId: number | null = null;
  private chromeSpring: SpringState = { position: 0, velocity: 0 };
  private chromeBaseOpacity: number = 0;
  private chromeDriftProgress: number = 0;
  private chromeDriftVectors: {
    bar: { x: number; y: number };
    prev: { x: number; y: number };
    next: { x: number; y: number };
  } = { bar: { x: 0, y: 0 }, prev: { x: 0, y: 0 }, next: { x: 0, y: 0 } };
  private chromeFadeSwapped: boolean = false;

  // Spring-driven button press (scale down on press, bounce back on release)
  private pressSprings = new Map<HTMLButtonElement, { state: SpringState; target: number }>();
  private pressRafId: number | null = null;

  // Spring-driven fit-rect transition (aspect ratio change on full-res swap)
  private fitRafId: number | null = null;

  // Focus trap
  private previouslyFocusedEl: HTMLElement | null = null;

  // Scroll lock state
  private savedBodyOverflow: string = '';
  private savedHtmlPaddingRight: string = '';

  // Wheel gesture state
  private wheelDismissY: number = 0;
  private wheelGestureTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelSnapBackTimer: ReturnType<typeof setTimeout> | null = null;

  // Wheel-driven gallery navigation
  private wheelNavCommitted: boolean = false;
  private wheelNavTotalDelta: number = 0;

  // Reduced motion: skip spring animations, snap to final state
  private reducedMotion: boolean = false;
  private reducedMotionQuery: MediaQueryList | null = null;

  constructor(opts: LightboxOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };

    // Listen for reduced-motion preference changes
    this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.reducedMotionQuery.matches;
    this.reducedMotionQuery.addEventListener('change', (e) => {
      this.reducedMotion = e.matches;
    });

    this.handleClick = this.handleClick.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
    this.handlePointerEnter = this.handlePointerEnter.bind(this);
    this.handlePointerLeave = this.handlePointerLeave.bind(this);
    this.handleImagePointerDown = this.handleImagePointerDown.bind(this);
    this.handleOverlayPointerDown = this.handleOverlayPointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.close = this.close.bind(this);

    this.attach();
  }

  static init(opts?: LightboxOptions): Lightbox {
    if (Lightbox.instance) return Lightbox.instance;
    Lightbox.instance = new Lightbox(opts);
    return Lightbox.instance;
  }

  on(event: LightboxEventType, callback: LightboxEventCallback): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
    return this;
  }

  off(event: LightboxEventType, callback: LightboxEventCallback): this {
    this.listeners.get(event)?.delete(callback);
    return this;
  }

  private emit(event: LightboxEventType): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    const detail: LightboxEventDetail = {
      src: this.state.currentSrc,
      triggerEl: this.state.triggerEl!,
      index: this.currentIndex,
      total: Math.max(this.gallery.length, 1),
    };
    for (const cb of set) {
      cb(detail);
    }
  }

  private attach(): void {
    document.addEventListener('click', this.handleClick);
    document.addEventListener('pointerenter', this.handlePointerEnter, true);
    document.addEventListener('pointerleave', this.handlePointerLeave, true);
  }

  destroy(): void {
    this.stopDebugPanel();
    document.removeEventListener('click', this.handleClick);
    document.removeEventListener('pointerenter', this.handlePointerEnter, true);
    document.removeEventListener('pointerleave', this.handlePointerLeave, true);
    this.cancelPreload();
    this.stopSpring();
    this.stopStripSpring();
    this.stopFitTransition();
    this.removeOverlay();
    this.listeners.clear();
    if (Lightbox.instance === this) Lightbox.instance = null;
  }

  private defaultZoomState(): ZoomState {
    return {
      zoomed: false,
      zoomingOut: false,
      fitRect: new DOMRect(),
      naturalWidth: 0,
      naturalHeight: 0,
      scale: 1,
      panX: 0,
      panY: 0,
      isDragging: false,
      dragStartX: 0,
      dragStartY: 0,
      dragStartPanX: 0,
      dragStartPanY: 0,
      dragMoved: false,
    };
  }

  private defaultPinchState(): PinchState {
    return {
      active: false,
      initialDistance: 0,
      initialScale: 1,
      initialPanX: 0,
      initialPanY: 0,
      initialMidX: 0,
      initialMidY: 0,
      prevScale: 1,
      prevScaleTime: 0,
    };
  }

  private defaultDismissState(): DismissState {
    return {
      tracking: false,
      active: false,
      fromOverlay: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      opacity: 1,
    };
  }

  private defaultSwipeNavState(): SwipeNavState {
    return {
      active: false,
      startX: 0,
      offsetX: 0,
      initialOffset: 0,
    };
  }

  // ─── Preloading ────────────────────────────────────────────

  private handlePointerEnter(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (!(e.target instanceof Element)) return;
    const trigger = e.target.closest(this.opts.selector) as HTMLElement | null;
    if (!trigger) return;
    const src = this.getSrcFromTrigger(trigger);
    if (!src || this.preloadCache.has(src)) return;
    this.preloadTimer = setTimeout(() => this.preloadImage(src), PRELOAD_DELAY);
  }

  private handlePointerLeave(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (!(e.target instanceof Element)) return;
    const trigger = e.target.closest(this.opts.selector) as HTMLElement | null;
    if (!trigger) return;
    this.cancelPreload();
  }

  private cancelPreload(): void {
    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
  }

  private preloadImage(src: string): void {
    if (this.preloadCache.has(src)) return;
    const img = new Image();
    img.src = src;
    this.preloadCache.set(src, img);
  }

  // ─── Gallery preloading ─────────────────────────────────────

  private schedulePreloads(): void {
    // Tier 1: always preload immediate neighbors
    if (this.currentIndex > 0) {
      this.preloadImage(this.gallery[this.currentIndex - 1].src);
    }
    if (this.currentIndex < this.gallery.length - 1) {
      this.preloadImage(this.gallery[this.currentIndex + 1].src);
    }

    // Tier 2+: after first navigation, preload remaining in travel direction
    if (this.userHasNavigated) {
      this.enqueueRemainingPreloads();
    }
  }

  private enqueueRemainingPreloads(): void {
    // Build queue outward from current position
    const queue: string[] = [];
    for (let offset = 2; offset < this.gallery.length; offset++) {
      const fwd = this.currentIndex + offset;
      const bwd = this.currentIndex - offset;
      if (fwd < this.gallery.length) queue.push(this.gallery[fwd].src);
      if (bwd >= 0) queue.push(this.gallery[bwd].src);
    }
    this.preloadQueue = queue.filter((src) => !this.preloadCache.has(src));
    this.processPreloadQueue();
  }

  private processPreloadQueue(): void {
    if (this.preloadingActive || this.preloadQueue.length === 0) return;
    const src = this.preloadQueue.shift()!;
    if (this.preloadCache.has(src)) {
      this.processPreloadQueue();
      return;
    }
    this.preloadingActive = true;
    const img = new Image();
    img.onload = img.onerror = () => {
      this.preloadingActive = false;
      this.processPreloadQueue();
    };
    img.src = src;
    this.preloadCache.set(src, img);
  }

  // ─── Gallery ────────────────────────────────────────────────

  private buildGallery(triggerEl: HTMLElement): void {
    const galleryName = triggerEl.getAttribute('data-lightbox');

    // No value or empty → standalone, no gallery
    if (!galleryName) {
      this.gallery = [];
      this.currentIndex = 0;
      return;
    }

    // Find all siblings with same gallery name, in DOM order
    const elements = document.querySelectorAll(`[data-lightbox="${CSS.escape(galleryName)}"]`);
    this.gallery = Array.from(elements).map((el) => {
      const htmlEl = el as HTMLElement;
      const img = htmlEl.querySelector('img') as HTMLImageElement | null;
      return {
        triggerEl: htmlEl,
        src: this.getSrcFromTrigger(htmlEl),
        thumbSrc: img?.currentSrc || img?.src || '',
        caption: htmlEl.getAttribute('data-caption') || htmlEl.getAttribute('data-title') || '',
        alt: htmlEl.getAttribute('data-alt') || img?.alt || '',
      };
    });

    this.currentIndex = this.gallery.findIndex((item) => item.triggerEl === triggerEl);
    if (this.currentIndex === -1) this.currentIndex = 0;
    this.userHasNavigated = false;
  }

  // ─── Event Handlers ──────────────────────────────────────────

  private handleClick(e: MouseEvent): void {
    const trigger = (e.target as HTMLElement).closest(this.opts.selector) as HTMLElement | null;
    if (!trigger) return;
    e.preventDefault();
    const src = this.getSrcFromTrigger(trigger);
    if (!src) return;

    // If lightbox is open, closing, or animating, clean up then open the new one
    if (this.state.isOpen || this.state.isAnimating || this.state.isClosing) {
      this.stopSpring();
      this.stopFitTransition();
      this.stopStripSpring();
      this.state.isAnimating = false;
      this.state.isClosing = false;
      this.finishClose();
    }

    this.buildGallery(trigger);
    this.open(trigger, src);
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      this.trapFocus(e);
      return;
    }

    if (e.key === 'Escape') {
      if (this.dismiss.active) {
        // Dismiss gesture in progress — complete the close
        this.dismissClose(0, 0);
        return;
      }
      if (this.zoom.zoomingOut) {
        // Zoom-out already in progress — close the lightbox
        this.close();
      } else if (this.zoom.zoomed || this.zoom.scale !== 1) {
        // Zoomed in (idle or animating in) — zoom out first
        this.zoomOut();
      } else {
        this.close();
      }
    } else if (e.key === 'ArrowRight') {
      if (this.zoom.scale === 1 && !this.swipeNav.active) {
        this.next();
      }
    } else if (e.key === 'ArrowLeft') {
      if (this.zoom.scale === 1 && !this.swipeNav.active) {
        this.prev();
      }
    }
  }

  private trapFocus(e: KeyboardEvent): void {
    if (!this.overlay) return;
    const focusable = this.overlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([style*="display: none"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first || !this.overlay.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last || !this.overlay.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  private getSrcFromTrigger(trigger: HTMLElement): string {
    const anchor = trigger.closest('a') || trigger;
    return anchor.getAttribute('href') || anchor.querySelector('img')?.src || '';
  }

  // ─── Open / Close ────────────────────────────────────────────

  open(triggerEl: HTMLElement, src: string): void {
    if (this.state.isOpen || this.state.isAnimating) return;
    this.debugLog('open');

    // Cancel any in-progress trigger bounce from a previous close
    if (this.bounceRafId !== null) {
      cancelAnimationFrame(this.bounceRafId);
      this.bounceRafId = null;
    }

    this.state.isOpen = true;
    this.state.isAnimating = true;
    this.state.triggerEl = triggerEl;
    this.state.currentSrc = src;
    this.previouslyFocusedEl = document.activeElement as HTMLElement | null;
    this.lockBodyScroll();
    this.startDebugPanel();
    this.emit('open');

    const thumbImg = triggerEl.querySelector('img') as HTMLImageElement | null;
    const thumbSrc = thumbImg?.currentSrc || thumbImg?.src || '';
    this.isTextLink = !thumbImg;

    if (this.isTextLink) {
      this.thumbBorderRadius = 0;
      this.openTextLink(triggerEl, src);
      return;
    }

    const thumbRect = this.getThumbRect(triggerEl);
    this.thumbBorderRadius = this.getThumbBorderRadius(triggerEl);

    this.createOverlay(thumbSrc || src);
    this.createChrome();
    this.computeChromeDrift(
      thumbRect.x + thumbRect.width / 2,
      thumbRect.y + thumbRect.height / 2,
    );
    document.addEventListener('keydown', this.handleKeydown);
    this.setThumbVisibility(false);

    const thumbNatW = thumbImg!.naturalWidth || thumbRect.width;
    const thumbNatH = thumbImg!.naturalHeight || thumbRect.height;

    const cached = this.preloadCache.get(src);
    const fullResReady = cached?.complete && cached.naturalWidth > 0;

    const natW = fullResReady ? cached!.naturalWidth : thumbNatW;
    const natH = fullResReady ? cached!.naturalHeight : thumbNatH;
    // When full-res dimensions are unknown, use thumbnail aspect ratio to fill
    // the viewport. Without this, the "never upscale" cap in computeTargetRect
    // keeps the image at the thumbnail's small pixel size.
    const targetRect = fullResReady
      ? this.computeTargetRect(natW, natH)
      : this.computeTargetRectFromAspectRatio(natW, natH);

    // Place image at final size/position, then FLIP from thumbnail
    this.positionImage(targetRect);

    this.zoom = this.defaultZoomState();
    this.zoom.fitRect = targetRect;
    this.zoom.naturalWidth = natW;
    this.zoom.naturalHeight = natH;

    // Compute the FLIP transform: what transform makes the image look like it's at thumbRect?
    const flipX = thumbRect.x + thumbRect.width / 2 - (targetRect.x + targetRect.width / 2);
    const flipY = thumbRect.y + thumbRect.height / 2 - (targetRect.y + targetRect.height / 2);

    // Compute FLIP scale and crop insets (handles CSS cover + server-side crop)
    const { flipScale, hasCrop } = this.computeFlipCrop(
      thumbRect,
      targetRect,
      triggerEl,
      false,
    );

    // Start full-res load immediately so it continues regardless of animation interrupts
    if (thumbSrc && thumbSrc !== src) {
      this.swapToFullRes(src);
    }

    // Preload neighbor images BEFORE populating adjacent slides — this ensures
    // the preload cache has Image objects that setupSlideImage can attach load
    // listeners to. Without this, adjacent slides fall back to thumbnails because
    // the cache entry doesn't exist yet when the slide is created.
    if (this.gallery.length > 1) {
      this.schedulePreloads();
    }

    // Populate adjacent gallery slides (off-screen, ready for swipe)
    this.populateAdjacentSlides();

    // Start spring from FLIP position → identity.
    // earlyComplete fires when visually done — don't wait for the spring tail
    // to clear isAnimating, or dismiss tracking will be blocked.
    const openVisuallyDone = (s: AnimState) => s.opacity > 0.99;
    this.animateSpring(
      { translateX: flipX, translateY: flipY, scale: flipScale, opacity: 0, crop: hasCrop ? 1 : 0, borderRadius: this.thumbBorderRadius },
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: this.getTargetBorderRadius() },
      SPRING_MORPH,
      () => {
        this.state.isAnimating = false;
        this.updateCursorState();
        this.emit('opened');
      },
      openVisuallyDone,
    );
  }

  private openTextLink(triggerEl: HTMLElement, src: string): void {
    const cached = this.preloadCache.get(src);
    const fullResReady = cached?.complete && cached.naturalWidth > 0;

    if (fullResReady) {
      // Image already loaded — run the normal FLIP morph using image aspect ratio
      this.openTextLinkWithImage(triggerEl, src, cached!.naturalWidth, cached!.naturalHeight);
      return;
    }

    // Image not ready — show overlay + spinner, load, then morph
    this.createOverlay('');
    this.createChrome();
    const triggerRect = triggerEl.getBoundingClientRect();
    this.computeChromeDrift(
      triggerRect.x + triggerRect.width / 2,
      triggerRect.y + triggerRect.height / 2,
    );
    document.addEventListener('keydown', this.handleKeydown);
    if (this.imgEl) this.imgEl.style.opacity = '0';

    // Show spinner after a short delay (skip if image loads fast)
    this.spinnerTimer = setTimeout(() => {
      if (this.overlay && this.state.currentSrc === src) {
        const spinner = document.createElement('div');
        spinner.className = 'lightbox3-spinner';
        this.overlay.appendChild(spinner);
        this.spinnerEl = spinner;
      }
    }, SPINNER_DELAY_MS);

    // Fade in backdrop
    const targetBR = this.getTargetBorderRadius();
    this.animateSpring(
      { translateX: 0, translateY: 0, scale: 1, opacity: 0, crop: 0, borderRadius: targetBR },
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR },
      this.opts.springOpen,
      () => {},
      undefined,
    );

    // Load image, then run the FLIP morph
    this.loadImage(src).then((size) => {
      if (!this.imgEl || this.state.currentSrc !== src) return;
      if (this.state.isClosing || !this.state.isOpen) return;
      this.removeSpinner();
      this.openTextLinkWithImage(triggerEl, src, size.width, size.height);
    });
  }

  /** Run the FLIP morph for a text-link trigger once image dimensions are known. */
  private openTextLinkWithImage(
    triggerEl: HTMLElement,
    src: string,
    natW: number,
    natH: number,
  ): void {
    const thumbRect = this.getThumbRect(triggerEl);
    const targetRect = this.computeTargetRect(natW, natH);

    // If overlay wasn't created yet (preloaded path), create it now
    if (!this.overlay) {
      this.createOverlay(src);
      this.createChrome();
      this.computeChromeDrift(
        thumbRect.x + thumbRect.width / 2,
        thumbRect.y + thumbRect.height / 2,
      );
      document.addEventListener('keydown', this.handleKeydown);
    } else {
      this.imgEl!.src = src;
    }

    this.positionImage(targetRect);

    this.zoom = this.defaultZoomState();
    this.zoom.fitRect = targetRect;
    this.zoom.naturalWidth = natW;
    this.zoom.naturalHeight = natH;

    // Build a FLIP origin rect centered on the text link but with the image's
    // aspect ratio, so the morph scales uniformly instead of stretching.
    const flipRect = this.textLinkFlipRect(thumbRect, natW, natH);

    const scaleX = flipRect.width / targetRect.width;
    const scaleY = flipRect.height / targetRect.height;
    const flipScale = Math.min(scaleX, scaleY);
    const flipX = flipRect.x + flipRect.width / 2 - (targetRect.x + targetRect.width / 2);
    const flipY = flipRect.y + flipRect.height / 2 - (targetRect.y + targetRect.height / 2);

    const openVisuallyDone = (s: AnimState) => s.opacity > 0.99;
    const targetBR = this.getTargetBorderRadius();
    this.animateSpring(
      { translateX: flipX, translateY: flipY, scale: flipScale, opacity: 0, crop: 0, borderRadius: 0 },
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR },
      SPRING_MORPH,
      () => {
        this.state.isAnimating = false;
        this.updateCursorState();
        this.emit('opened');
      },
      openVisuallyDone,
    );
  }

  /**
   * Build a rect centered on the text link with the image's aspect ratio.
   * Sized so the shorter dimension matches the text link's height.
   */
  private textLinkFlipRect(linkRect: DOMRect, natW: number, natH: number): DOMRect {
    const aspect = natW / natH;
    const h = linkRect.height;
    const w = h * aspect;
    const cx = linkRect.x + linkRect.width / 2;
    const cy = linkRect.y + linkRect.height / 2;
    return new DOMRect(cx - w / 2, cy - h / 2, w, h);
  }

  private removeSpinner(): void {
    if (this.spinnerTimer) {
      clearTimeout(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerEl) {
      this.spinnerEl.remove();
      this.spinnerEl = null;
    }
  }

  private swapToFullRes(src: string): void {
    this.loadImage(src).then((size) => {
      if (!this.imgEl || this.state.currentSrc !== src) return;
      // Full-res loaded after close started — don't reposition the image
      if (this.state.isClosing || !this.state.isOpen) return;

      this.imgEl.src = src;
      this.zoom.naturalWidth = size.width;
      this.zoom.naturalHeight = size.height;

      if (!this.zoom.zoomed) {
        const targetRect = this.computeTargetRect(size.width, size.height);
        const currentRect = this.zoom.fitRect;

        // If size/position changed meaningfully, spring-animate the transition
        const dx = Math.abs(targetRect.x - currentRect.x);
        const dy = Math.abs(targetRect.y - currentRect.y);
        const dw = Math.abs(targetRect.width - currentRect.width);
        const dh = Math.abs(targetRect.height - currentRect.height);

        if (dx > 1 || dy > 1 || dw > 1 || dh > 1) {
          this.animateFitTransition(currentRect, targetRect);
        } else {
          this.zoom.fitRect = targetRect;
          this.positionImage(targetRect);
        }
      }

      this.updateCursorState();
    });
  }

  /** Spring-animate the image from one fit rect to another (aspect ratio change). */
  private animateFitTransition(from: DOMRect, to: DOMRect): void {
    this.stopFitTransition();

    if (this.reducedMotion) {
      this.zoom.fitRect = to;
      this.positionImage(to);
      return;
    }

    const img = this.imgEl!;
    const config = PAN_SPRING; // Soft spring for a gentle settle
    const springs = {
      x: { position: from.x, velocity: 0, settled: false } as SpringStepResult,
      y: { position: from.y, velocity: 0, settled: false } as SpringStepResult,
      w: { position: from.width, velocity: 0, settled: false } as SpringStepResult,
      h: { position: from.height, velocity: 0, settled: false } as SpringStepResult,
    };

    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      springs.x = springStep(config, springs.x, to.x, dt);
      springs.y = springStep(config, springs.y, to.y, dt);
      springs.w = springStep(config, springs.w, to.width, dt);
      springs.h = springStep(config, springs.h, to.height, dt);

      Object.assign(img.style, {
        left: `${springs.x.position}px`,
        top: `${springs.y.position}px`,
        width: `${springs.w.position}px`,
        height: `${springs.h.position}px`,
      });

      const settled =
        springs.x.settled && springs.y.settled && springs.w.settled && springs.h.settled;

      if (settled) {
        this.zoom.fitRect = to;
        this.positionImage(to);
        this.fitRafId = null;
        return;
      }

      // Keep fitRect in sync so zoom/pan reads live values
      this.zoom.fitRect = new DOMRect(
        springs.x.position,
        springs.y.position,
        springs.w.position,
        springs.h.position,
      );

      this.fitRafId = requestAnimationFrame(tick);
    };

    this.fitRafId = requestAnimationFrame(tick);
  }

  private stopFitTransition(): void {
    if (this.fitRafId !== null) {
      cancelAnimationFrame(this.fitRafId);
      this.fitRafId = null;
    }
  }

  close(): void {
    if (this.state.isClosing) return;
    if (!this.state.isOpen && !this.state.isAnimating) return;

    // If dismiss gesture is in progress, close from the current dismiss position
    if (this.dismiss.active) {
      this.dismissClose(0, 0);
      return;
    }

    // If pinch is active below fit scale, bridge into pinch close
    if (this.pinch.active && this.zoom.scale < 1) {
      this.pinch.active = false;
      this.pinchClose();
      return;
    }

    // Stop any strip animation and reset
    this.stopStripSpring();
    this.stripOffset = 0;
    if (this.stripEl) this.stripEl.style.transform = '';
    this.swipeNav = this.defaultSwipeNavState();

    this.state.isClosing = true;
    this.emit('close');
    this.stopSpring();
    this.stopFitTransition();
    this.stopChromeSpring();
    this.chromeSpring = { position: 0, velocity: 0 };
    this.state.isAnimating = false;
    this.dismiss = this.defaultDismissState();

    // Let clicks pass through to thumbnails underneath during close.
    // Delayed so the overlay still blocks the synthetic click that mobile browsers
    // dispatch after pointerup (which can arrive after rAF on mobile Safari).
    if (this.overlay) {
      const ov = this.overlay;
      setTimeout(() => {
        ov.style.pointerEvents = 'none';
      }, 80);
    }

    // If zoomed (idle or mid-animation), reset zoom first then close
    if (this.zoom.zoomed || this.zoom.zoomingOut || this.zoom.scale !== 1) {
      this.zoom.scale = 1;
      this.zoom.panX = 0;
      this.zoom.panY = 0;
      this.zoom.zoomed = false;
      this.zoom.zoomingOut = false;
      this.imgEl!.style.transform = '';
    }

    this.state.isAnimating = true;

    const thumbRect = this.state.triggerEl ? this.getThumbRect(this.state.triggerEl) : null;

    if (thumbRect) {
      this.computeChromeDrift(
        thumbRect.x + thumbRect.width / 2,
        thumbRect.y + thumbRect.height / 2,
      );
    }

    const closeWhenInvisible = (s: AnimState) => s.opacity < 0.01;

    const currentBR = this.getTargetBorderRadius();

    if (!thumbRect || !this.isInViewport(thumbRect)) {
      this.animateSpring(
        { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: currentBR },
        { translateX: 0, translateY: 0, scale: 1, opacity: 0, crop: 0, borderRadius: currentBR },
        this.opts.springClose,
        () => this.finishClose(),
        closeWhenInvisible,
      );
      return;
    }

    const { fitRect } = this.zoom;

    // For text links, build a target rect with the image's aspect ratio
    // centered on the link, instead of morphing to the text's shape.
    const morphRect = this.isTextLink
      ? this.textLinkFlipRect(thumbRect, this.zoom.naturalWidth, this.zoom.naturalHeight)
      : thumbRect;

    const flipX = morphRect.x + morphRect.width / 2 - (fitRect.x + fitRect.width / 2);
    const flipY = morphRect.y + morphRect.height / 2 - (fitRect.y + fitRect.height / 2);

    // Recompute crop insets for close (thumb may have moved since open).
    // Handles both CSS object-fit:cover and server-side aspect ratio mismatches.
    const { flipScale, hasCrop } = this.computeFlipCrop(
      morphRect,
      fitRect,
      this.state.triggerEl,
      this.isTextLink,
    );

    this.animateSpring(
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: currentBR },
      { translateX: flipX, translateY: flipY, scale: flipScale, opacity: 0, crop: hasCrop ? 1 : 0, borderRadius: this.thumbBorderRadius },
      this.opts.springClose,
      () => this.finishClose(),
      closeWhenInvisible,
    );
  }

  private finishClose(): void {
    this.debugLog('finishClose');
    this.stopDebugPanel();
    this.removeSpinner();
    this.stopFitTransition();
    this.stopChromeSpring();
    this.chromeSpring = { position: 0, velocity: 0 };
    this.chromeBaseOpacity = 0;
    this.resetChromeDrift();
    this.setThumbVisibility(true);
    this.removeOverlay();
    this.unlockBodyScroll();
    document.removeEventListener('keydown', this.handleKeydown);

    if (this.previouslyFocusedEl) {
      this.previouslyFocusedEl.focus();
      this.previouslyFocusedEl = null;
    }

    if (this.state.triggerEl) {
      this.bounceTrigger(this.state.triggerEl);
    }

    this.emit('closed');

    this.state.isOpen = false;
    this.state.isAnimating = false;
    this.state.isClosing = false;
    this.state.triggerEl = null;
    this.zoom = this.defaultZoomState();
    this.pointerCache = [];
    this.pinch = this.defaultPinchState();
    this.dismiss = this.defaultDismissState();
    this.swipeNav = this.defaultSwipeNavState();
    this.pendingNavDirection = null;
    this.gallery = [];
    this.currentIndex = 0;
    this.userHasNavigated = false;
    this.stripOffset = 0;
    this.preloadQueue = [];
    this.preloadingActive = false;
    this.wheelDismissY = 0;
    this.wheelNavCommitted = false;
    this.wheelNavTotalDelta = 0;
    if (this.wheelGestureTimer !== null) {
      clearTimeout(this.wheelGestureTimer);
      this.wheelGestureTimer = null;
    }
    if (this.wheelSnapBackTimer !== null) {
      clearTimeout(this.wheelSnapBackTimer);
      this.wheelSnapBackTimer = null;
    }
  }

  /**
   * "Catch" bounce: the trigger element squishes down slightly then
   * springs back to normal scale, as if catching the lightbox image.
   * Runs on its own rAF loop so it doesn't interfere with the main spring.
   */
  private bounceTrigger(el: HTMLElement): void {
    if (this.reducedMotion) return; // Skip decorative bounce

    if (this.bounceRafId !== null) {
      cancelAnimationFrame(this.bounceRafId);
      this.bounceRafId = null;
    }

    const config = { stiffness: 900, damping: 80, mass: 1 };
    const spring: SpringState = { position: 0.98, velocity: 0 };
    const target = 1;
    let lastTime = performance.now();

    el.style.transform = `scale(${spring.position})`;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const result = springStep(config, spring, target, dt);
      spring.position = result.position;
      spring.velocity = result.velocity;

      el.style.transform = result.settled ? '' : `scale(${result.position})`;

      if (result.settled) {
        this.bounceRafId = null;
        return;
      }

      this.bounceRafId = requestAnimationFrame(tick);
    };

    this.bounceRafId = requestAnimationFrame(tick);
  }

  // ─── Gallery navigation ────────────────────────────────────

  next(): void {
    if (this.gallery.length <= 1) return;
    if (this.zoom.scale !== 1) return;
    this.forceCompleteStripAnimation();
    if (this.currentIndex >= this.gallery.length - 1) {
      this.bounceStrip(-1);
      return;
    }
    this.navigateTo(1);
  }

  prev(): void {
    if (this.gallery.length <= 1) return;
    if (this.zoom.scale !== 1) return;
    this.forceCompleteStripAnimation();
    if (this.currentIndex <= 0) {
      this.bounceStrip(1);
      return;
    }
    this.navigateTo(-1);
  }

  private navigateTo(direction: 1 | -1): void {
    this.debugLog(`navigateTo(${direction > 0 ? 'next' : 'prev'})`);
    this.userHasNavigated = true;
    this.pendingNavDirection = direction;

    // Enable pointer events on the destination slide so it can receive clicks
    // while animating into view, instead of falling through to the backdrop.
    const destSlide = direction === 1 ? this.nextSlideEl : this.prevSlideEl;
    if (destSlide) destSlide.style.pointerEvents = 'auto';

    const slideWidth = window.innerWidth + SLIDE_GAP;
    const targetX = -direction * slideWidth;

    this.animateStrip(this.stripOffset, targetX, this.opts.springOpen, 0, () =>
      this.completeNavigation(direction),
    );
  }

  private completeNavigation(direction: 1 | -1): void {
    this.debugLog(`completeNavigation(${direction > 0 ? 'next' : 'prev'})`);
    this.pendingNavDirection = null;

    // Show old thumbnail
    this.setThumbVisibility(true);

    // Update index and trigger
    this.currentIndex += direction;
    const item = this.gallery[this.currentIndex];
    this.state.triggerEl = item.triggerEl;
    this.state.currentSrc = item.src;
    this.thumbBorderRadius = this.getThumbBorderRadius(item.triggerEl);

    // Hide new thumbnail
    this.setThumbVisibility(false);

    this.emit('navigate');

    // Update chrome UI — cross-fade already swapped caption/counter text,
    // so just ensure it's correct for the new index and reset fade state.
    this.updateChromeContent();
    this.chromeFadeSwapped = false;
    if (this.chromeCaption) this.chromeCaption.style.opacity = '';
    if (this.chromeCounter) this.chromeCounter.style.opacity = '';

    // Reset strip BEFORE recycling — recycleSlots creates a new adjacent slide
    // and appends it to the strip. If the strip still has its animation transform
    // (-slideWidth), the new slide at left:slideWidth appears at visual position 0
    // (center) for one frame before the transform is cleared.
    this.stripOffset = 0;
    if (this.stripEl) this.stripEl.style.transform = '';

    // Schedule preloads BEFORE recycling — recycleSlots creates a new adjacent
    // slide, and it needs the preload cache entry to exist so it can attach a
    // load listener for the full-res upgrade.
    this.schedulePreloads();

    // Recycle DOM slots
    this.recycleSlots(direction);

    // Set up new current image (zoom state, full-res swap)
    this.setupCurrentImage();

    // Wheel navigation: ready for new gesture now that the image has landed
    this.wheelNavCommitted = false;
    this.wheelNavTotalDelta = 0;
  }

  /**
   * After strip animation completes, reposition slide elements so the new
   * current image is at left:0. Remove the old far slide, create a new one
   * at the opposite edge.
   */
  private recycleSlots(direction: 1 | -1): void {
    const slideWidth = window.innerWidth + SLIDE_GAP;

    if (direction === 1) {
      // Forward: prev is removed, current→prev, next→current, create new next
      if (this.prevSlideEl) this.prevSlideEl.remove();

      this.prevSlideEl = this.currentSlideEl;
      this.prevSlideImg = this.imgEl;
      if (this.prevSlideEl) {
        this.prevSlideEl.style.left = `${-slideWidth}px`;
        this.prevSlideEl.style.pointerEvents = 'none';
      }

      this.currentSlideEl = this.nextSlideEl;
      this.imgEl = this.nextSlideImg;
      if (this.currentSlideEl) {
        this.currentSlideEl.style.left = '0';
        this.currentSlideEl.style.pointerEvents = 'auto';
      }

      this.nextSlideEl = null;
      this.nextSlideImg = null;
      if (this.currentIndex < this.gallery.length - 1) {
        this.createAdjacentSlide(this.currentIndex + 1, slideWidth);
      }
    } else {
      // Backward: next is removed, current→next, prev→current, create new prev
      if (this.nextSlideEl) this.nextSlideEl.remove();

      this.nextSlideEl = this.currentSlideEl;
      this.nextSlideImg = this.imgEl;
      if (this.nextSlideEl) {
        this.nextSlideEl.style.left = `${slideWidth}px`;
        this.nextSlideEl.style.pointerEvents = 'none';
      }

      this.currentSlideEl = this.prevSlideEl;
      this.imgEl = this.prevSlideImg;
      if (this.currentSlideEl) {
        this.currentSlideEl.style.left = '0';
        this.currentSlideEl.style.pointerEvents = 'auto';
      }

      this.prevSlideEl = null;
      this.prevSlideImg = null;
      if (this.currentIndex > 0) {
        this.createAdjacentSlide(this.currentIndex - 1, -slideWidth);
      }
    }
  }

  /** Set up zoom state and image src for the newly-centered current image. */
  private setupCurrentImage(): void {
    this.zoom = this.defaultZoomState();
    this.stopFitTransition();

    const item = this.gallery[this.currentIndex];
    if (!item || !this.imgEl) return;

    // Check preload cache first
    const cached = this.preloadCache.get(item.src);
    const fullResReady = cached?.complete && cached.naturalWidth > 0;

    // Also check if the slide's img element already has full-res loaded
    // (e.g. preload finished during strip animation and upgraded the adjacent slide)
    const imgHasFullRes =
      this.imgEl.src === item.src &&
      this.imgEl.complete &&
      this.imgEl.naturalWidth > 0;

    if (fullResReady || imgHasFullRes) {
      const natW = fullResReady ? cached!.naturalWidth : this.imgEl.naturalWidth;
      const natH = fullResReady ? cached!.naturalHeight : this.imgEl.naturalHeight;
      this.zoom.naturalWidth = natW;
      this.zoom.naturalHeight = natH;
      this.zoom.fitRect = this.computeTargetRect(natW, natH);
      this.imgEl.src = item.src;
      this.positionImage(this.zoom.fitRect);
    } else {
      const thumbImg = item.triggerEl.querySelector('img') as HTMLImageElement | null;
      const natW = thumbImg?.naturalWidth || 400;
      const natH = thumbImg?.naturalHeight || 300;
      this.zoom.naturalWidth = natW;
      this.zoom.naturalHeight = natH;
      this.zoom.fitRect = this.computeTargetRectFromAspectRatio(natW, natH);
      this.positionImage(this.zoom.fitRect);
      this.swapToFullRes(item.src);
    }

    // Apply border-radius to the new current image (previous image had it from
    // the open animation, but this is a fresh DOM element after slot recycling).
    const br = this.getTargetBorderRadius();
    if (this.imgEl) {
      this.imgEl.style.borderRadius = br > 0 ? `${br}px` : '';
    }

    this.updateCursorState();
  }

  /**
   * If a strip spring is running (from a flick or arrow key), resolve it so
   * the user can start a new gesture from a clean state.
   */
  private resolveStripAnimation(): void {
    if (this.stripRafId === null) return;
    this.stopStripSpring();

    const slideWidth = window.innerWidth + SLIDE_GAP;
    if (Math.abs(this.stripOffset) > slideWidth / 2) {
      // Past halfway — complete the navigation
      const direction = (this.stripOffset < 0 ? 1 : -1) as 1 | -1;
      const newIndex = this.currentIndex + direction;
      if (newIndex >= 0 && newIndex < this.gallery.length) {
        // Adjust offset to preserve visual positions after recycling
        this.stripOffset += direction * slideWidth;
        this.completeNavigation(direction);
        // completeNavigation resets stripOffset to 0, but we adjusted it above
        // so the visual position is preserved. Re-apply the adjusted offset.
      }
    }
    // stripOffset is now close to 0 (or exactly 0 after completeNavigation)
    this.applyStripOffset(this.stripOffset);
  }

  // ─── Spring animation engine (rAF) ──────────────────────────

  private animateSpring(
    from: AnimState,
    to: AnimState,
    config: SpringConfig,
    onComplete: () => void,
    earlyComplete?: (current: AnimState) => boolean,
    initialVelocities?: Partial<AnimState>,
    configOverrides?: Partial<Record<keyof AnimState, SpringConfig>>,
  ): void {
    this.stopSpring();

    const img = this.imgEl!;
    const backdrop = this.backdrop!;

    if (this.reducedMotion) {
      this.applyAnimState(img, backdrop, to);
      onComplete();
      return;
    }

    // One spring per animated property
    const springs: {
      key: keyof AnimState;
      state: SpringState;
      target: number;
      config: SpringConfig;
    }[] = [
      {
        key: 'translateX',
        state: { position: from.translateX, velocity: initialVelocities?.translateX ?? 0 },
        target: to.translateX,
        config: configOverrides?.translateX ?? config,
      },
      {
        key: 'translateY',
        state: { position: from.translateY, velocity: initialVelocities?.translateY ?? 0 },
        target: to.translateY,
        config: configOverrides?.translateY ?? config,
      },
      {
        key: 'scale',
        state: { position: from.scale, velocity: initialVelocities?.scale ?? 0 },
        target: to.scale,
        config: configOverrides?.scale ?? config,
      },
      {
        key: 'opacity',
        state: { position: from.opacity, velocity: initialVelocities?.opacity ?? 0 },
        target: to.opacity,
        config: configOverrides?.opacity ?? config,
      },
      {
        key: 'crop',
        state: { position: from.crop, velocity: initialVelocities?.crop ?? 0 },
        target: to.crop,
        config: configOverrides?.crop ?? config,
      },
      {
        key: 'borderRadius',
        state: { position: from.borderRadius, velocity: initialVelocities?.borderRadius ?? 0 },
        target: to.borderRadius,
        config: configOverrides?.borderRadius ?? config,
      },
    ];

    let lastTime = performance.now();

    // Apply initial state
    this.applyAnimState(img, backdrop, from);

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      let allSettled = true;
      const current: Record<string, number> = {};

      for (const s of springs) {
        const result = springStep(s.config, s.state, s.target, dt);
        s.state = result;
        current[s.key] = result.position;
        if (!result.settled) allSettled = false;
      }

      const currentState = current as unknown as AnimState;
      this.applyAnimState(img, backdrop, currentState);

      if (allSettled || earlyComplete?.(currentState)) {
        // Snap to exact final values
        this.applyAnimState(img, backdrop, to);
        this.debugLog(`mainRaf settled${earlyComplete?.(currentState) ? ' (early)' : ''}`);
        this.rafId = null;
        onComplete();
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private applyAnimState(img: HTMLImageElement, backdrop: HTMLDivElement, state: AnimState): void {
    img.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
    backdrop.style.opacity = String(state.opacity);

    img.style.opacity = this.isTextLink
      ? String(Math.min(1, state.opacity / TEXT_LINK_OPACITY_THRESHOLD))
      : '';

    if (state.crop > 0.001) {
      const { top, right, bottom, left } = this.cropInsets;
      const br = state.borderRadius > 0.1 ? state.borderRadius / Math.max(state.scale, 0.01) : 0;
      img.style.clipPath = `inset(${state.crop * top}px ${state.crop * right}px ${state.crop * bottom}px ${state.crop * left}px round ${br}px)`;
    } else {
      img.style.clipPath = '';
    }

    // Border-radius: compensate for FLIP scale so visual radius matches the
    // animated value. When clipPath is active it handles rounding via `round`.
    if (state.crop <= 0.001) {
      const br = state.borderRadius > 0.1 ? state.borderRadius / Math.max(state.scale, 0.01) : 0;
      img.style.borderRadius = br > 0.1 ? `${br}px` : '';
    } else {
      img.style.borderRadius = '';
    }

    // Chrome follows backdrop opacity during open/close.
    // Accelerate fade-out on close so chrome disappears before the morph lands.
    this.chromeBaseOpacity = this.state.isClosing
      ? Math.pow(state.opacity, 2)
      : state.opacity;
    // Drift progress: 1 = fully offset toward origin, 0 = settled in place
    this.chromeDriftProgress = 1 - state.opacity;
    this.updateChromeVisuals();
  }

  // ─── Strip spring (gallery slide animation) ─────────────────

  private animateStrip(
    fromX: number,
    toX: number,
    config: SpringConfig,
    velocity: number,
    onComplete: () => void,
  ): void {
    this.stopStripSpring();

    if (this.reducedMotion) {
      this.stripOffset = toX;
      this.applyStripOffset(toX);
      onComplete();
      return;
    }

    let spring: SpringState = { position: fromX, velocity };
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const result = springStep(config, spring, toX, dt);
      spring = result;

      this.stripOffset = result.position;
      this.applyStripOffset(result.position);

      // Early completion: sub-pixel position + low velocity means visually done.
      // Without this, the spring long tail adds ~500ms of imperceptible creep.
      const earlyDone =
        Math.abs(result.position - toX) < 1 && Math.abs(result.velocity) < 5;

      if (result.settled || earlyDone) {
        this.stripOffset = toX;
        this.applyStripOffset(toX);
        this.debugLog('stripRaf settled');
        this.stripRafId = null;
        onComplete();
        return;
      }

      this.stripRafId = requestAnimationFrame(tick);
    };

    this.stripRafId = requestAnimationFrame(tick);
  }

  private stopStripSpring(): void {
    if (this.stripRafId !== null) {
      cancelAnimationFrame(this.stripRafId);
      this.stripRafId = null;
    }
  }

  private applyStripOffset(offset: number): void {
    if (this.stripEl) {
      this.stripEl.style.transform = offset ? `translateX(${offset}px)` : '';
    }
    this.updateChromeFade(offset);
  }

  /**
   * Cross-fade caption and counter as the strip slides between images.
   * Opacity follows a V-curve: 1 → 0 at midpoint → 1.
   * Text content swaps at the midpoint so the new caption fades in.
   */
  private updateChromeFade(offset: number): void {
    if (this.gallery.length <= 1) return;

    if (offset === 0) {
      if (this.chromeCaption) this.chromeCaption.style.opacity = '';
      if (this.chromeCounter) this.chromeCounter.style.opacity = '';
      this.chromeFadeSwapped = false;
      return;
    }

    const direction = offset < 0 ? 1 : -1;
    const destIndex = this.currentIndex + direction;
    const hasDestination = destIndex >= 0 && destIndex < this.gallery.length;

    if (!hasDestination) return; // At edge (bounce) — don't fade

    const slideWidth = window.innerWidth + SLIDE_GAP;
    const progress = Math.min(1, Math.abs(offset) / slideWidth);
    const fadeOpacity = Math.abs(1 - progress * 2);

    // Swap text at midpoint
    if (progress > 0.5 && !this.chromeFadeSwapped) {
      this.chromeFadeSwapped = true;
      const item = this.gallery[destIndex];
      if (this.chromeCounter) {
        this.chromeCounter.textContent = `${destIndex + 1}\u2009/\u2009${this.gallery.length}`;
      }
      if (this.chromeCaption) {
        const cap = item?.caption || '';
        this.chromeCaption.textContent = cap;
        this.chromeCaption.style.display = cap ? '' : 'none';
      }
    } else if (progress <= 0.5 && this.chromeFadeSwapped) {
      this.chromeFadeSwapped = false;
      const item = this.gallery[this.currentIndex];
      if (this.chromeCounter) {
        this.chromeCounter.textContent = `${this.currentIndex + 1}\u2009/\u2009${this.gallery.length}`;
      }
      if (this.chromeCaption) {
        const cap = item?.caption || '';
        this.chromeCaption.textContent = cap;
        this.chromeCaption.style.display = cap ? '' : 'none';
      }
    }

    if (this.chromeCaption) this.chromeCaption.style.opacity = String(fadeOpacity);
    if (this.chromeCounter) this.chromeCounter.style.opacity = String(fadeOpacity);
  }

  /**
   * Rubber-band bounce at gallery edges. Kicks the strip with velocity in the
   * attempted direction — the spring overshoots then settles back to 0,
   * hinting that there are no more images that way.
   * direction: 1 = shift right (at first image), -1 = shift left (at last).
   */
  private bounceStrip(direction: 1 | -1): void {
    this.debugLog(`bounceStrip(${direction > 0 ? 'right' : 'left'})`);
    const BOUNCE_VELOCITY = 1200;
    const BOUNCE_SPRING: SpringConfig = { stiffness: 400, damping: 24, mass: 1 };
    this.animateStrip(0, 0, BOUNCE_SPRING, direction * BOUNCE_VELOCITY, () => {
      this.stripOffset = 0;
    });
  }

  /**
   * If a strip animation is in progress, stop it and resolve immediately.
   * Navigation animations are completed (index updated, slots recycled).
   * Bounce animations are just cancelled (strip reset to 0).
   */
  private forceCompleteStripAnimation(): void {
    if (this.stripRafId === null) return;
    this.stopStripSpring();

    if (this.pendingNavDirection !== null) {
      this.completeNavigation(this.pendingNavDirection);
    } else {
      // Bounce or other non-navigation animation — just reset
      this.stripOffset = 0;
      this.applyStripOffset(0);
    }
  }

  // ─── Zoom ────────────────────────────────────────────────────

  private isZoomable(): boolean {
    const { fitRect, naturalWidth, naturalHeight } = this.zoom;
    return naturalWidth > fitRect.width * 1.05 || naturalHeight > fitRect.height * 1.05;
  }

  private getTapZoomScale(): number {
    const { fitRect, naturalWidth } = this.zoom;
    const nativeScale = naturalWidth / fitRect.width;
    // 3× fit ensures a perceptible jump; cap at native so we never upscale
    return Math.min(Math.max(nativeScale, 2), 3);
  }

  private getMaxZoomScale(): number {
    const { fitRect, naturalWidth } = this.zoom;
    const nativeScale = naturalWidth / fitRect.width;
    return Math.max(nativeScale, 2);
  }

  private zoomIn(clickX: number, clickY: number): void {
    if (!this.imgEl || !this.isZoomable()) return;
    this.debugLog('zoomIn');
    this.emit('zoomIn');

    this.stopSpring();
    this.state.isAnimating = true;
    this.animateChrome(1);

    const { fitRect } = this.zoom;
    const targetScale = this.getTapZoomScale();

    const imgCenterX = fitRect.x + fitRect.width / 2;
    const imgCenterY = fitRect.y + fitRect.height / 2;
    const relX = clickX - imgCenterX;
    const relY = clickY - imgCenterY;

    let panX = -(relX * targetScale - relX);
    let panY = -(relY * targetScale - relY);

    const bounds = this.computePanBounds(targetScale);
    panX = clamp(panX, bounds.minX, bounds.maxX);
    panY = clamp(panY, bounds.minY, bounds.maxY);

    if (this.reducedMotion) {
      this.zoom.panX = panX;
      this.zoom.panY = panY;
      this.zoom.scale = targetScale;
      this.zoom.zoomed = true;
      this.applyPanTransform();
      this.state.isAnimating = false;
      this.updateCursorState();
      return;
    }

    const fromPanX = this.zoom.panX;
    const fromPanY = this.zoom.panY;
    const fromScale = this.zoom.scale;

    // Spring from current → target zoom state
    let sX: SpringState = { position: fromPanX, velocity: 0 };
    let sY: SpringState = { position: fromPanY, velocity: 0 };
    let sScale: SpringState = { position: fromScale, velocity: 0 };

    const config = this.opts.springOpen;
    let lastTime = performance.now();
    let madeInteractive = false;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const rX = springStep(config, sX, panX, dt);
      const rY = springStep(config, sY, panY, dt);
      const rS = springStep(config, sScale, targetScale, dt);

      sX = rX;
      sY = rY;
      sScale = rS;

      this.zoom.panX = rX.position;
      this.zoom.panY = rY.position;
      this.zoom.scale = rS.position;
      this.applyPanTransform();

      // Make interactive as soon as visually zoomed — don't wait for spring tail
      if (!madeInteractive && rS.position > 1) {
        madeInteractive = true;
        this.zoom.zoomed = true;
        this.state.isAnimating = false;
        this.updateCursorState();
      }

      if (rX.settled && rY.settled && rS.settled) {
        this.zoom.panX = panX;
        this.zoom.panY = panY;
        this.zoom.scale = targetScale;
        this.applyPanTransform();

        this.rafId = null;
        if (!madeInteractive) {
          this.zoom.zoomed = true;
          this.state.isAnimating = false;
          this.updateCursorState();
        }
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private zoomOut(): void {
    if (!this.imgEl) return;
    this.debugLog('zoomOut');
    this.emit('zoomOut');

    this.stopSpring();
    this.state.isAnimating = true;
    this.zoom.zoomingOut = true;
    this.animateChrome(0);

    if (this.reducedMotion) {
      this.zoom.panX = 0;
      this.zoom.panY = 0;
      this.zoom.scale = 1;
      this.zoom.zoomed = false;
      this.zoom.zoomingOut = false;
      this.applyPanTransform();
      this.state.isAnimating = false;
      this.updateCursorState();
      return;
    }

    const fromPanX = this.zoom.panX;
    const fromPanY = this.zoom.panY;
    const fromScale = this.zoom.scale;

    let sX: SpringState = { position: fromPanX, velocity: 0 };
    let sY: SpringState = { position: fromPanY, velocity: 0 };
    let sScale: SpringState = { position: fromScale, velocity: 0 };

    const config = this.opts.springClose;
    let lastTime = performance.now();
    let madeInteractive = false;

    const VISUAL_THRESHOLD = 0.005;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const rX = springStep(config, sX, 0, dt);
      const rY = springStep(config, sY, 0, dt);
      const rS = springStep(config, sScale, 1, dt);

      sX = rX;
      sY = rY;
      sScale = rS;

      this.zoom.panX = rX.position;
      this.zoom.panY = rY.position;
      this.zoom.scale = rS.position;
      this.applyPanTransform();

      // Update state as soon as visually settled — don't wait for spring tail
      if (
        !madeInteractive &&
        Math.abs(rS.position - 1) < VISUAL_THRESHOLD &&
        Math.abs(rX.position) < 1 &&
        Math.abs(rY.position) < 1
      ) {
        madeInteractive = true;
        this.zoom.zoomed = false;
        this.zoom.zoomingOut = false;
        this.state.isAnimating = false;
        this.updateCursorState();
      }

      if (rX.settled && rY.settled && rS.settled) {
        this.zoom.panX = 0;
        this.zoom.panY = 0;
        this.zoom.scale = 1;
        this.applyPanTransform();

        this.rafId = null;
        if (!madeInteractive) {
          this.zoom.zoomed = false;
          this.zoom.zoomingOut = false;
          this.state.isAnimating = false;
          this.updateCursorState();
        }
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  // ─── Pan: drag + momentum via rAF spring ────────────────────

  private handleImagePointerDown(e: PointerEvent): void {
    e.preventDefault();

    // Add to pointer cache
    this.pointerCache.push(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    // Second finger down — start pinch
    if (this.pointerCache.length === 2) {
      this.startPinch();
      return;
    }

    // Single pointer at fit scale — track for potential swipe-to-dismiss or swipe-to-navigate.
    // Block during open animation (isAnimating=true) — the image is mid-FLIP
    // and freezing it would leave a partial-open state. Snap-back doesn't set
    // isAnimating, so it stays interruptible.
    // Use !zoomed rather than scale<=1: during zoom-out spring tail, scale may
    // linger slightly above 1 after madeInteractive has already cleared zoomed.
    // Also catch mid-zoomOut: if the user touches down while zoom-out is animating,
    // snap to fit scale and start dismiss tracking instead of entering pan mode.
    const atFitScale = !this.zoom.zoomed || this.zoom.zoomingOut;
    const blockedByAnimation = this.state.isAnimating && !this.zoom.zoomingOut;
    if (atFitScale && !blockedByAnimation) {
      // Resolve any in-progress strip animation
      this.resolveStripAnimation();

      // Cancel any in-progress animation (e.g. snap-back, zoom-out spring)
      this.stopSpring();
      // Snap to fit scale so the image is exactly at rest
      this.zoom.scale = 1;
      this.zoom.panX = 0;
      this.zoom.panY = 0;
      this.zoom.zoomed = false;
      this.zoom.zoomingOut = false;
      this.applyPanTransform();
      this.state.isAnimating = false;
      this.dismiss.tracking = true;
      this.dismiss.startX = e.clientX;
      this.dismiss.startY = e.clientY;
      this.velocitySamples = [];
      this.addVelocitySample(e.clientX, e.clientY);
      return;
    }

    // Interrupt any in-progress zoom-in animation — user is grabbing it
    this.stopSpring();
    this.zoom.zoomed = true;
    this.state.isAnimating = false;

    this.zoom.isDragging = true;
    this.zoom.dragMoved = false;
    this.zoom.dragStartX = e.clientX;
    this.zoom.dragStartY = e.clientY;
    this.zoom.dragStartPanX = this.zoom.panX;
    this.zoom.dragStartPanY = this.zoom.panY;

    this.velocitySamples = [];
    this.addVelocitySample(e.clientX, e.clientY);

    this.updateCursorState();
  }

  private handleOverlayPointerDown(e: PointerEvent): void {
    // Only handle pointers that land outside the image (backdrop area)
    if (e.target === this.imgEl) return;

    // Only for dismiss at fit scale, not during open animation.
    // Allow during zoom-out: snap to fit and start dismiss tracking.
    const atFitScale = !this.zoom.zoomed || this.zoom.zoomingOut;
    const blockedByAnimation = this.state.isAnimating && !this.zoom.zoomingOut;
    if (!atFitScale || blockedByAnimation) return;

    e.preventDefault();

    // Capture on the overlay so move/up events are delivered here
    this.overlay!.setPointerCapture(e.pointerId);

    // Resolve any in-progress strip animation
    this.resolveStripAnimation();

    this.stopSpring();
    // Snap to fit scale in case we interrupted a zoom-out spring
    if (this.zoom.zoomingOut) {
      this.zoom.scale = 1;
      this.zoom.panX = 0;
      this.zoom.panY = 0;
      this.zoom.zoomed = false;
      this.zoom.zoomingOut = false;
      this.applyPanTransform();
    }
    this.state.isAnimating = false;
    this.dismiss.tracking = true;
    this.dismiss.fromOverlay = true;
    this.dismiss.startX = e.clientX;
    this.dismiss.startY = e.clientY;
    this.velocitySamples = [];
    this.addVelocitySample(e.clientX, e.clientY);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.imgEl) return;

    // Update pointer in cache
    const idx = this.pointerCache.findIndex((p) => p.pointerId === e.pointerId);
    if (idx >= 0) this.pointerCache[idx] = e;

    // Pinch active — handle two-finger zoom+pan
    if (this.pinch.active && this.pointerCache.length === 2) {
      this.updatePinch();
      return;
    }

    // Swipe-to-navigate (horizontal drag at scale=1)
    if (this.swipeNav.active) {
      this.handleSwipeNavMove(e);
      return;
    }

    // Swipe-to-dismiss tracking / active drag
    if (this.dismiss.tracking || this.dismiss.active) {
      this.handleDismissMove(e);
      return;
    }

    // Single-finger drag (zoomed pan)
    if (!this.zoom.isDragging) return;

    const dx = e.clientX - this.zoom.dragStartX;
    const dy = e.clientY - this.zoom.dragStartY;

    if (!this.zoom.dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      this.zoom.dragMoved = true;
    }

    this.addVelocitySample(e.clientX, e.clientY);

    let newPanX = this.zoom.dragStartPanX + dx;
    let newPanY = this.zoom.dragStartPanY + dy;

    const bounds = this.computePanBounds(this.zoom.scale);
    newPanX = rubberBand(newPanX, bounds.minX, bounds.maxX);
    newPanY = rubberBand(newPanY, bounds.minY, bounds.maxY);

    this.zoom.panX = newPanX;
    this.zoom.panY = newPanY;
    this.applyPanTransform();
  }

  private handlePointerUp(e: PointerEvent): void {
    // Remove from pointer cache
    this.pointerCache = this.pointerCache.filter((p) => p.pointerId !== e.pointerId);

    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released
    }

    // Pinch ended — settle with spring
    if (this.pinch.active) {
      if (this.pointerCache.length < 2) {
        this.endPinch();
      }
      return;
    }

    // Swipe-to-navigate release
    if (this.swipeNav.active) {
      this.handleSwipeNavRelease();
      return;
    }

    // Swipe-to-dismiss release
    if (this.dismiss.tracking || this.dismiss.active) {
      this.handleDismissRelease();
      return;
    }

    // Single-finger drag end (zoomed pan)
    if (!this.zoom.isDragging) return;

    const wasDrag = this.zoom.dragMoved;
    this.zoom.isDragging = false;
    // Don't clear dragMoved here — handleImageClick needs it to suppress the click
    this.updateCursorState();

    if (!wasDrag) {
      this.zoomOut();
      // Mark dragMoved so the subsequent click event is suppressed —
      // without this, handleImageClick also calls zoomOut() on the same tap.
      this.zoom.dragMoved = true;
      return;
    }

    const velocity = this.computeVelocity();
    this.startPanMomentum(velocity.vx, velocity.vy);
  }

  // ─── Velocity tracking ──────────────────────────────────────

  private addVelocitySample(x: number, y: number): void {
    const now = performance.now();
    this.velocitySamples.push({ x, y, t: now });
    const cutoff = now - VELOCITY_WINDOW;
    while (this.velocitySamples.length > 1 && this.velocitySamples[0].t < cutoff) {
      this.velocitySamples.shift();
    }
  }

  private computeVelocity(): { vx: number; vy: number } {
    const samples = this.velocitySamples;
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const dt = (newest.t - oldest.t) / 1000;
    if (dt < 0.001) return { vx: 0, vy: 0 };
    return {
      vx: (newest.x - oldest.x) / dt,
      vy: (newest.y - oldest.y) / dt,
    };
  }

  // ─── Swipe-to-dismiss ──────────────────────────────────────

  private handleDismissMove(e: PointerEvent): void {
    const dx = e.clientX - this.dismiss.startX;
    const dy = e.clientY - this.dismiss.startY;

    if (!this.dismiss.active) {
      // Still tracking — determine axis once past threshold.
      // Use a larger threshold than DRAG_THRESHOLD so the angle has enough
      // signal to commit reliably, especially on mobile.
      if (Math.hypot(dx, dy) < AXIS_LOCK_THRESHOLD) return;

      if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        // Vertical wins — activate dismiss
        this.dismiss.active = true;
        this.dismiss.tracking = false;
        this.zoom.dragMoved = true; // Suppress the click that follows pointerup

        // Snap strip back if it was at a non-zero offset from an interrupted animation
        if (this.stripOffset !== 0) {
          this.stripOffset = 0;
          this.applyStripOffset(0);
        }
      } else {
        // Horizontal — start swipe-to-navigate if in a gallery
        if (this.gallery.length > 1) {
          const startX = this.dismiss.startX;
          this.dismiss = this.defaultDismissState();
          this.zoom.dragMoved = true; // Suppress the click
          this.startSwipeNav(startX, e.clientX);
        } else {
          this.dismiss = this.defaultDismissState();
        }
        return;
      }
    }

    this.addVelocitySample(e.clientX, e.clientY);

    // Unconstrained movement once dismiss is active
    this.dismiss.offsetX = dx;
    this.dismiss.offsetY = dy;

    // Scale and opacity driven by distance from center
    const vh = window.innerHeight;
    const dist = Math.hypot(dx, dy);
    const progress = dist / vh;

    this.dismiss.scale = Math.max(0.7, 1 - progress * 0.3);
    this.dismiss.opacity = Math.max(0, 1 - progress / 0.4);

    this.applyDismissTransform();
  }

  private applyDismissTransform(): void {
    if (!this.imgEl || !this.backdrop) return;
    const { offsetX, offsetY, scale } = this.dismiss;
    this.imgEl.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    this.backdrop.style.opacity = String(this.dismiss.opacity);

    this.chromeBaseOpacity = this.dismiss.opacity;
    this.updateChromeVisuals();
  }

  private handleDismissRelease(): void {
    if (!this.dismiss.active) {
      // Was just tracking, never activated.
      // Overlay-initiated: pointer capture suppresses the backdrop click, so close here.
      // Image-initiated: let the click handler deal with it.
      const fromOverlay = this.dismiss.fromOverlay;
      this.dismiss = this.defaultDismissState();
      if (fromOverlay) this.close();
      return;
    }

    const { vx, vy } = this.computeVelocity();

    // iOS-style: dismiss is the default once the gesture activates.
    // Snap back only if the user deliberately returned the image to center.
    const dist = Math.hypot(this.dismiss.offsetX, this.dismiss.offsetY);
    const speed = Math.hypot(vx, vy);

    if (dist < 5 && speed < 50) {
      this.dismissSnapBack(vx, vy);
    } else {
      this.dismissClose(vx, vy);
    }
  }

  private dismissClose(velocityX: number, velocityY: number): void {
    this.debugLog('dismissClose');
    this.state.isClosing = true;
    this.emit('close');
    this.state.isAnimating = true;
    this.stopFitTransition();
    if (this.overlay) {
      const ov = this.overlay;
      setTimeout(() => {
        ov.style.pointerEvents = 'none';
      }, 80);
    }

    const { offsetX, offsetY, scale, opacity } = this.dismiss;
    this.dismiss = this.defaultDismissState();

    const thumbRect = this.state.triggerEl ? this.getThumbRect(this.state.triggerEl) : null;
    const currentBR = this.getTargetBorderRadius();

    // Off-screen thumbnails — fade out in place
    if (!thumbRect || !this.isInViewport(thumbRect)) {
      this.animateSpring(
        { translateX: offsetX, translateY: offsetY, scale, opacity, crop: 0, borderRadius: currentBR },
        { translateX: offsetX, translateY: offsetY, scale, opacity: 0, crop: 0, borderRadius: currentBR },
        this.opts.springClose,
        () => this.finishClose(),
        (s) => s.opacity < 0.01,
        { translateX: velocityX, translateY: velocityY },
      );
      return;
    }

    // FLIP morph back to thumbnail (or text-link rect with image aspect ratio)
    const { fitRect } = this.zoom;
    const morphRect = this.isTextLink
      ? this.textLinkFlipRect(thumbRect, this.zoom.naturalWidth, this.zoom.naturalHeight)
      : thumbRect;

    const flipX = morphRect.x + morphRect.width / 2 - (fitRect.x + fitRect.width / 2);
    const flipY = morphRect.y + morphRect.height / 2 - (fitRect.y + fitRect.height / 2);

    const { flipScale, hasCrop } = this.computeFlipCrop(
      morphRect,
      fitRect,
      this.state.triggerEl,
      this.isTextLink,
    );

    // Clean up as soon as the image is visually at the thumbnail — the swap
    // from animated image → real thumbnail is imperceptible at this point.
    // Don't use opacity alone: it may already be near 0 from the drag.
    // Tolerances are wide enough to survive spring overshoot from fast flicks
    // (at thumbnail scale, 20px of position error is a few pixels on screen).
    const atThumbnail = (s: AnimState) =>
      Math.abs(s.scale - flipScale) < 0.05 &&
      Math.abs(s.translateX - flipX) < 20 &&
      Math.abs(s.translateY - flipY) < 20;

    // Parabolic arc: the axis with more velocity gets a softer spring,
    // so momentum carries it further while the cross-axis converges first.
    // This produces a natural curved path toward the thumbnail.
    const base = this.opts.springClose;
    const absVx = Math.abs(velocityX);
    const absVy = Math.abs(velocityY);
    const vRatio = Math.max(absVx, absVy) / (Math.min(absVx, absVy) || 1);
    let dismissConfigs: Partial<Record<keyof AnimState, SpringConfig>> | undefined;
    if (vRatio > 1.5 && Math.max(absVx, absVy) > 100) {
      const soft = { ...base, stiffness: base.stiffness * 0.55, damping: base.damping * 0.85 };
      dismissConfigs = absVy > absVx
        ? { translateY: soft }
        : { translateX: soft };
    }

    this.animateSpring(
      { translateX: offsetX, translateY: offsetY, scale, opacity, crop: 0, borderRadius: currentBR },
      { translateX: flipX, translateY: flipY, scale: flipScale, opacity: 0, crop: hasCrop ? 1 : 0, borderRadius: this.thumbBorderRadius },
      this.opts.springClose,
      () => this.finishClose(),
      atThumbnail,
      { translateX: velocityX, translateY: velocityY },
      dismissConfigs,
    );
  }

  private dismissSnapBack(velocityX: number, velocityY: number): void {
    const { offsetX, offsetY, scale, opacity } = this.dismiss;

    this.dismiss = this.defaultDismissState();

    // Don't set isAnimating — snap-back is visual recovery, not a state
    // transition. This keeps it interruptible by a new dismiss gesture
    // (the user can grab the image mid-snap-back) while isAnimating=true
    // during the open animation correctly blocks dismiss tracking.
    const targetBR = this.getTargetBorderRadius();
    this.animateSpring(
      { translateX: offsetX, translateY: offsetY, scale, opacity, crop: 0, borderRadius: targetBR },
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR },
      SNAP_SPRING,
      () => {},
      undefined,
      { translateX: velocityX, translateY: velocityY },
    );
  }

  // ─── Scroll lock ────────────────────────────────────────────

  private lockBodyScroll(): void {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    this.savedBodyOverflow = document.body.style.overflow;
    this.savedHtmlPaddingRight = document.documentElement.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.documentElement.style.paddingRight = `${scrollbarWidth}px`;
    }
  }

  private unlockBodyScroll(): void {
    document.body.style.overflow = this.savedBodyOverflow;
    document.documentElement.style.paddingRight = this.savedHtmlPaddingRight;
  }

  // ─── Wheel handling ────────────────────────────────────────


  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    if (this.state.isClosing || !this.state.isOpen) return;

    // Ignore during active pointer gestures
    if (this.dismiss.active || this.dismiss.tracking) return;
    if (this.swipeNav.active) return;
    if (this.zoom.isDragging) return;

    // Gesture-end detection: fires when wheel events stop.
    // Resets all wheel accumulator state.
    if (this.wheelGestureTimer !== null) clearTimeout(this.wheelGestureTimer);
    this.wheelGestureTimer = setTimeout(() => {
      this.debugLog('gesture timer → reset wheel state');
      this.wheelGestureTimer = null;
      this.wheelDismissY = 0;
      this.wheelNavCommitted = false;
      this.wheelNavTotalDelta = 0;
    }, 80);

    this.handleScroll(e);
  }

  private handleScroll(e: WheelEvent): void {
    // Normalize line-based deltas (mouse wheels) to pixels
    const lineScale = e.deltaMode === 1 ? 16 : 1;
    const deltaX = e.deltaX * lineScale;
    const deltaY = e.deltaY * lineScale;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (this.zoom.zoomed || this.zoom.scale !== 1) {
      // Zoomed: scroll pans
      this.wheelPan(deltaX, deltaY);
      return;
    }

    // At fit scale: determine primary axis
    if (absX > absY && this.gallery.length > 1) {
      // Horizontal dominant — navigate gallery
      this.wheelNavigate(deltaX);
    } else if (absY > 0) {
      // Vertical dominant — dismiss
      this.wheelDismiss(deltaY);
    }
  }

  private wheelPan(deltaX: number, deltaY: number): void {
    this.stopSpring();

    const bounds = this.computePanBounds(this.zoom.scale);

    this.zoom.panX -= deltaX;
    this.zoom.panY -= deltaY;

    // Rubber-band outside bounds
    if (this.zoom.panX < bounds.minX) {
      const over = bounds.minX - this.zoom.panX;
      this.zoom.panX = bounds.minX - over * RUBBER_BAND_FACTOR;
    } else if (this.zoom.panX > bounds.maxX) {
      const over = this.zoom.panX - bounds.maxX;
      this.zoom.panX = bounds.maxX + over * RUBBER_BAND_FACTOR;
    }
    if (this.zoom.panY < bounds.minY) {
      const over = bounds.minY - this.zoom.panY;
      this.zoom.panY = bounds.minY - over * RUBBER_BAND_FACTOR;
    } else if (this.zoom.panY > bounds.maxY) {
      const over = this.zoom.panY - bounds.maxY;
      this.zoom.panY = bounds.maxY + over * RUBBER_BAND_FACTOR;
    }

    this.applyPanTransform();

    // Snap back to bounds after a pause (wheel events come in bursts)
    this.scheduleWheelSnapBack();
  }

  private scheduleWheelSnapBack(): void {
    if (this.wheelSnapBackTimer !== null) clearTimeout(this.wheelSnapBackTimer);
    this.wheelSnapBackTimer = setTimeout(() => {
      this.wheelSnapBackTimer = null;
      if (this.state.isClosing || !this.state.isOpen) return;
      if (!this.zoom.zoomed && this.zoom.scale === 1) return;

      const bounds = this.computePanBounds(this.zoom.scale);
      const needsSnap =
        this.zoom.panX < bounds.minX ||
        this.zoom.panX > bounds.maxX ||
        this.zoom.panY < bounds.minY ||
        this.zoom.panY > bounds.maxY;

      if (needsSnap) {
        this.startPanMomentum(0, 0);
      }
    }, 100);
  }

  private wheelNavigate(deltaX: number): void {
    if (this.wheelNavCommitted) return;

    this.wheelNavTotalDelta += deltaX;

    if (Math.abs(this.wheelNavTotalDelta) > WHEEL_NAV_THRESHOLD) {
      this.wheelNavCommitted = true;
      const dir = this.wheelNavTotalDelta > 0 ? 'next' : 'prev';
      this.debugLog(`wheelNav commit → ${dir}`);
      if (this.wheelNavTotalDelta > 0) {
        this.next();
      } else {
        this.prev();
      }
    }
  }

  private wheelDismiss(deltaY: number): void {
    this.wheelDismissY += Math.abs(deltaY);

    if (this.wheelDismissY > WHEEL_DISMISS_THRESHOLD) {
      this.wheelDismissY = 0;
      this.dismissClose(0, WHEEL_DISMISS_VELOCITY);
    }
  }

  // ─── Swipe-to-navigate ──────────────────────────────────────

  private startSwipeNav(startX: number, currentX: number): void {
    const initialOffset = this.stripOffset;
    this.swipeNav = {
      active: true,
      startX,
      offsetX: initialOffset + (currentX - startX),
      initialOffset,
    };
    this.applyStripOffset(this.swipeNav.offsetX);
    this.stripOffset = this.swipeNav.offsetX;
  }

  private handleSwipeNavMove(e: PointerEvent): void {
    const dx = e.clientX - this.swipeNav.startX;
    let offset = this.swipeNav.initialOffset + dx;

    // Rubber-band at gallery edges
    const atStart = this.currentIndex === 0;
    const atEnd = this.currentIndex === this.gallery.length - 1;

    if (atStart && offset > 0) {
      offset = offset * RUBBER_BAND_FACTOR;
    }
    if (atEnd && offset < 0) {
      offset = offset * RUBBER_BAND_FACTOR;
    }

    this.swipeNav.offsetX = offset;
    this.stripOffset = offset;
    this.addVelocitySample(e.clientX, e.clientY);
    this.applyStripOffset(offset);
  }

  private handleSwipeNavRelease(): void {
    const { vx } = this.computeVelocity();
    const offset = this.swipeNav.offsetX;

    // Reset swipe nav state immediately — spring animation is just visual follow-through
    this.swipeNav = this.defaultSwipeNavState();

    const slideWidth = window.innerWidth + SLIDE_GAP;
    const progress = Math.abs(offset) / slideWidth;

    let shouldNavigate =
      Math.abs(vx) > SWIPE_VELOCITY_THRESHOLD || progress > SWIPE_DISTANCE_THRESHOLD;

    const direction = (offset < 0 ? 1 : -1) as 1 | -1;

    // Don't navigate past edges
    if (direction === 1 && this.currentIndex >= this.gallery.length - 1) shouldNavigate = false;
    if (direction === -1 && this.currentIndex <= 0) shouldNavigate = false;

    if (shouldNavigate) {
      this.completeSwipeNav(direction, vx);
    } else {
      this.snapBackSwipeNav(vx);
    }
  }

  private completeSwipeNav(direction: 1 | -1, velocity: number): void {
    this.pendingNavDirection = direction;

    const destSlide = direction === 1 ? this.nextSlideEl : this.prevSlideEl;
    if (destSlide) destSlide.style.pointerEvents = 'auto';

    const slideWidth = window.innerWidth + SLIDE_GAP;
    const targetX = -direction * slideWidth;

    this.animateStrip(this.stripOffset, targetX, this.opts.springOpen, velocity, () =>
      this.completeNavigation(direction),
    );
  }

  private snapBackSwipeNav(velocity: number): void {
    this.animateStrip(this.stripOffset, 0, SNAP_SPRING, velocity, () => {
      this.stripOffset = 0;
    });
  }

  // ─── Pinch-to-zoom ─────────────────────────────────────────

  private startPinch(): void {
    // Cancel any in-progress animation or dismiss gesture
    this.stopSpring();
    this.state.isAnimating = false;
    this.zoom.isDragging = false;
    this.dismiss = this.defaultDismissState();

    const [p1, p2] = this.pointerCache;
    const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
    const midX = (p1.clientX + p2.clientX) / 2;
    const midY = (p1.clientY + p2.clientY) / 2;

    this.pinch = {
      active: true,
      initialDistance: dist,
      initialScale: this.zoom.scale,
      initialPanX: this.zoom.panX,
      initialPanY: this.zoom.panY,
      initialMidX: midX,
      initialMidY: midY,
      prevScale: this.zoom.scale,
      prevScaleTime: performance.now(),
    };
  }

  private updatePinch(): void {
    const [p1, p2] = this.pointerCache;
    const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
    const midX = (p1.clientX + p2.clientX) / 2;
    const midY = (p1.clientY + p2.clientY) / 2;

    const ratio = dist / this.pinch.initialDistance;
    const maxScale = this.getMaxZoomScale();

    let newScale = this.pinch.initialScale * ratio;
    // Rubber-band past min/max
    if (newScale < 1) {
      // Lighter rubber band below 1 so pinch-to-close feels responsive
      newScale = 1 - (1 - newScale) * PINCH_DISMISS_RUBBER_BAND_FACTOR;
    } else if (newScale > maxScale) {
      newScale = maxScale + (newScale - maxScale) * PINCH_RUBBER_BAND_FACTOR;
    }

    // Track scale velocity for commit/snap-back decision on release
    const now = performance.now();
    this.pinch.prevScale = this.zoom.scale;
    this.pinch.prevScaleTime = now;

    // Focal-point correction: keep the midpoint pinned to the same content
    const { fitRect } = this.zoom;
    const imgCenterX = fitRect.x + fitRect.width / 2;
    const imgCenterY = fitRect.y + fitRect.height / 2;

    // Vector from image center to initial midpoint in screen space
    const relX = this.pinch.initialMidX - imgCenterX;
    const relY = this.pinch.initialMidY - imgCenterY;

    // Pan offset so that content under the initial midpoint stays under the current midpoint
    const scaleRatio = newScale / this.pinch.initialScale;
    const panX =
      this.pinch.initialPanX +
      (midX - this.pinch.initialMidX) -
      (relX - this.pinch.initialPanX) * (scaleRatio - 1);
    const panY =
      this.pinch.initialPanY +
      (midY - this.pinch.initialMidY) -
      (relY - this.pinch.initialPanY) * (scaleRatio - 1);

    this.zoom.scale = newScale;
    this.zoom.panX = panX;
    this.zoom.panY = panY;
    this.applyPanTransform();

    // Below fit scale: fade backdrop and chrome proportionally (pinch-to-close)
    if (newScale < 1) {
      const dismissProgress = 1 - newScale;
      const opacity = Math.max(0, 1 - dismissProgress / 0.35);
      this.backdrop!.style.opacity = String(opacity);
      this.chromeBaseOpacity = opacity;
      this.chromeSpring = { position: 0, velocity: 0 };
      this.updateChromeVisuals();
    } else {
      // Fade chrome proportionally to zoom level
      const chromeProgress = Math.min(1, Math.max(0, (newScale - 1) / 0.5));
      this.chromeSpring = { position: chromeProgress, velocity: 0 };
      this.updateChromeVisuals();
    }
  }

  private endPinch(): void {
    this.pinch.active = false;
    this.zoom.dragMoved = true; // Suppress the click that follows

    const maxScale = this.getMaxZoomScale();

    if (this.zoom.scale < 1) {
      // Compute scale velocity from last frame
      const dt = (performance.now() - this.pinch.prevScaleTime) / 1000;
      const scaleVelocity = dt > 0.001 ? (this.zoom.scale - this.pinch.prevScale) / dt : 0;

      if (this.zoom.scale < PINCH_CLOSE_SCALE || scaleVelocity < PINCH_CLOSE_VELOCITY) {
        // Commit to close — bridge into dismiss path
        this.pinchClose();
      } else {
        // Snap back to fit scale and restore backdrop/chrome
        this.pinchSnapBack();
      }
    } else if (this.zoom.scale > maxScale) {
      // Clamp to max scale, keep pan clamped
      const bounds = this.computePanBounds(maxScale);
      const panX = clamp(this.zoom.panX, bounds.minX, bounds.maxX);
      const panY = clamp(this.zoom.panY, bounds.minY, bounds.maxY);
      this.springToZoomState(maxScale, panX, panY, SNAP_SPRING, true);
      this.animateChrome(1);
    } else {
      // Valid zoom — clamp pan to bounds and settle
      this.zoom.zoomed = this.zoom.scale > 1;
      this.animateChrome(this.zoom.scale > 1 ? 1 : 0);
      const bounds = this.computePanBounds(this.zoom.scale);
      const inBoundsX = this.zoom.panX >= bounds.minX && this.zoom.panX <= bounds.maxX;
      const inBoundsY = this.zoom.panY >= bounds.minY && this.zoom.panY <= bounds.maxY;
      if (!inBoundsX || !inBoundsY) {
        const panX = clamp(this.zoom.panX, bounds.minX, bounds.maxX);
        const panY = clamp(this.zoom.panY, bounds.minY, bounds.maxY);
        this.springToZoomState(this.zoom.scale, panX, panY, SNAP_SPRING, this.zoom.scale > 1);
      } else {
        this.updateCursorState();
      }
    }

    // Don't auto-transition to single-finger drag — the second finger
    // lifting off produces noisy velocity that triggers unwanted momentum.
    // User can lift and re-place a finger to pan intentionally.
  }

  private pinchClose(): void {
    this.debugLog('pinchClose');
    this.state.isClosing = true;
    this.emit('close');
    this.state.isAnimating = true;
    this.stopFitTransition();

    // Stop any strip animation and reset
    this.stopStripSpring();
    this.stripOffset = 0;
    if (this.stripEl) this.stripEl.style.transform = '';
    this.swipeNav = this.defaultSwipeNavState();

    if (this.overlay) {
      const ov = this.overlay;
      setTimeout(() => {
        ov.style.pointerEvents = 'none';
      }, 80);
    }

    // Current pinch state becomes the starting point for the close animation.
    // panX/panY are in the same coordinate space as dismiss translateX/Y.
    const { panX, panY, scale } = this.zoom;
    const dismissProgress = 1 - scale;
    const opacity = Math.max(0, 1 - dismissProgress / 0.35);

    // Reset zoom state — animation system takes over via animateSpring
    this.zoom.scale = 1;
    this.zoom.panX = 0;
    this.zoom.panY = 0;
    this.zoom.zoomed = false;

    const thumbRect = this.state.triggerEl ? this.getThumbRect(this.state.triggerEl) : null;
    const currentBR = this.getTargetBorderRadius();

    // Off-screen or no thumbnail — fade out in place
    if (!thumbRect || !this.isInViewport(thumbRect)) {
      this.animateSpring(
        { translateX: panX, translateY: panY, scale, opacity, crop: 0, borderRadius: currentBR },
        { translateX: panX, translateY: panY, scale, opacity: 0, crop: 0, borderRadius: currentBR },
        this.opts.springClose,
        () => this.finishClose(),
        (s) => s.opacity < 0.01,
      );
      return;
    }

    // FLIP morph back to thumbnail
    const { fitRect } = this.zoom;
    const morphRect = this.isTextLink
      ? this.textLinkFlipRect(thumbRect, this.zoom.naturalWidth, this.zoom.naturalHeight)
      : thumbRect;

    const flipX = morphRect.x + morphRect.width / 2 - (fitRect.x + fitRect.width / 2);
    const flipY = morphRect.y + morphRect.height / 2 - (fitRect.y + fitRect.height / 2);

    const { flipScale, hasCrop } = this.computeFlipCrop(
      morphRect,
      fitRect,
      this.state.triggerEl,
      this.isTextLink,
    );

    const atThumbnail = (s: AnimState) =>
      Math.abs(s.scale - flipScale) < 0.05 &&
      Math.abs(s.translateX - flipX) < 20 &&
      Math.abs(s.translateY - flipY) < 20;

    this.animateSpring(
      { translateX: panX, translateY: panY, scale, opacity, crop: 0, borderRadius: currentBR },
      { translateX: flipX, translateY: flipY, scale: flipScale, opacity: 0, crop: hasCrop ? 1 : 0, borderRadius: this.thumbBorderRadius },
      this.opts.springClose,
      () => this.finishClose(),
      atThumbnail,
    );
  }

  private pinchSnapBack(): void {
    const { panX, panY, scale } = this.zoom;
    const dismissProgress = 1 - scale;
    const opacity = Math.max(0, 1 - dismissProgress / 0.35);

    // Reset zoom to fit — the spring animates the visual recovery
    this.zoom.scale = 1;
    this.zoom.panX = 0;
    this.zoom.panY = 0;
    this.zoom.zoomed = false;

    // Animate snap-back: image returns to center, backdrop restores.
    // Don't set isAnimating so snap-back stays interruptible.
    const targetBR = this.getTargetBorderRadius();
    this.animateSpring(
      { translateX: panX, translateY: panY, scale, opacity, crop: 0, borderRadius: targetBR },
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0, borderRadius: targetBR },
      SNAP_SPRING,
      () => {},
    );
  }

  private springToZoomState(
    targetScale: number,
    targetPanX: number,
    targetPanY: number,
    config: SpringConfig,
    zoomed: boolean,
  ): void {
    this.stopSpring();
    this.state.isAnimating = true;

    if (this.reducedMotion) {
      this.zoom.panX = targetPanX;
      this.zoom.panY = targetPanY;
      this.zoom.scale = targetScale;
      this.zoom.zoomed = zoomed;
      this.applyPanTransform();
      this.state.isAnimating = false;
      this.updateCursorState();
      return;
    }

    let sX: SpringState = { position: this.zoom.panX, velocity: 0 };
    let sY: SpringState = { position: this.zoom.panY, velocity: 0 };
    let sScale: SpringState = { position: this.zoom.scale, velocity: 0 };

    let lastTime = performance.now();
    let madeInteractive = false;

    const VISUAL_THRESHOLD = 0.005;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const rX = springStep(config, sX, targetPanX, dt);
      const rY = springStep(config, sY, targetPanY, dt);
      const rS = springStep(config, sScale, targetScale, dt);

      sX = rX;
      sY = rY;
      sScale = rS;

      this.zoom.panX = rX.position;
      this.zoom.panY = rY.position;
      this.zoom.scale = rS.position;
      this.applyPanTransform();

      // Update state as soon as visually settled — don't wait for spring tail
      if (
        !madeInteractive &&
        Math.abs(rS.position - targetScale) < VISUAL_THRESHOLD * targetScale &&
        Math.abs(rX.position - targetPanX) < 1 &&
        Math.abs(rY.position - targetPanY) < 1
      ) {
        madeInteractive = true;
        this.zoom.zoomed = zoomed;
        this.state.isAnimating = false;
        this.updateCursorState();
      }

      if (rX.settled && rY.settled && rS.settled) {
        this.zoom.panX = targetPanX;
        this.zoom.panY = targetPanY;
        this.zoom.scale = targetScale;
        this.applyPanTransform();

        this.rafId = null;
        if (!madeInteractive) {
          this.zoom.zoomed = zoomed;
          this.state.isAnimating = false;
          this.updateCursorState();
        }
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  // ─── Pan momentum (rAF spring) ─────────────────────────────

  private startPanMomentum(vx: number, vy: number): void {
    const bounds = this.computePanBounds(this.zoom.scale);

    const inBoundsX = this.zoom.panX >= bounds.minX && this.zoom.panX <= bounds.maxX;
    const inBoundsY = this.zoom.panY >= bounds.minY && this.zoom.panY <= bounds.maxY;

    const targetX = inBoundsX
      ? clamp(this.zoom.panX + vx * 0.15, bounds.minX, bounds.maxX)
      : clamp(this.zoom.panX, bounds.minX, bounds.maxX);

    const targetY = inBoundsY
      ? clamp(this.zoom.panY + vy * 0.15, bounds.minY, bounds.maxY)
      : clamp(this.zoom.panY, bounds.minY, bounds.maxY);

    if (this.reducedMotion) {
      this.zoom.panX = targetX;
      this.zoom.panY = targetY;
      this.applyPanTransform();
      return;
    }

    let sX: SpringState = { position: this.zoom.panX, velocity: inBoundsX ? vx : 0 };
    let sY: SpringState = { position: this.zoom.panY, velocity: inBoundsY ? vy : 0 };

    const configX = inBoundsX ? PAN_SPRING : SNAP_SPRING;
    const configY = inBoundsY ? PAN_SPRING : SNAP_SPRING;

    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const rX = springStep(configX, sX, targetX, dt);
      const rY = springStep(configY, sY, targetY, dt);
      sX = rX;
      sY = rY;

      this.zoom.panX = rX.position;
      this.zoom.panY = rY.position;
      this.applyPanTransform();

      if (rX.settled && rY.settled) {
        this.rafId = null;
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private stopSpring(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private applyPanTransform(): void {
    if (!this.imgEl) return;
    this.imgEl.style.transform = `translate(${this.zoom.panX}px, ${this.zoom.panY}px) scale(${this.zoom.scale})`;
  }

  private computePanBounds(scale: number): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } {
    const { fitRect } = this.zoom;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scaledW = fitRect.width * scale;
    const scaledH = fitRect.height * scale;
    const overflowX = Math.max(0, (scaledW - vw) / 2);
    const overflowY = Math.max(0, (scaledH - vh) / 2);
    return { minX: -overflowX, maxX: overflowX, minY: -overflowY, maxY: overflowY };
  }

  // ─── Image click handler ─────────────────────────────────────

  private handleImageClick(e: MouseEvent): void {
    if (this.zoom.dragMoved) {
      this.zoom.dragMoved = false;
      return;
    }

    // If a strip animation is in progress, complete it so zoom state is valid
    // for the newly-current image before processing the click.
    if (this.pendingNavDirection !== null) {
      this.forceCompleteStripAnimation();
    }

    // Zoomed (idle or animating) — zoom out
    if (this.zoom.zoomed || this.zoom.scale !== 1) {
      this.zoomOut();
      return;
    }

    if (this.isZoomable()) {
      this.zoomIn(e.clientX, e.clientY);
    } else {
      this.close();
    }
  }

  // ─── Cursor state ────────────────────────────────────────────

  private updateCursorState(): void {
    if (!this.imgEl) return;
    const img = this.imgEl;
    if (this.zoom.isDragging) {
      img.style.cursor = 'grabbing';
    } else if (this.zoom.zoomed) {
      img.style.cursor = 'grab';
    } else if (this.isZoomable()) {
      img.style.cursor = 'zoom-in';
    } else {
      img.style.cursor = 'pointer';
    }
  }

  // ─── Chrome UI ──────────────────────────────────────────────

  private createChrome(): void {
    if (!this.overlay) return;

    const isGallery = this.gallery.length > 1;
    const caption = this.getCurrentCaption();
    const hasContent = isGallery || !!caption;

    // Bottom pill bar
    const bar = document.createElement('div');
    bar.className = 'lightbox3-chrome';
    if (!hasContent) bar.classList.add('lightbox3-chrome--minimal');

    // Counter (gallery only)
    const counter = document.createElement('span');
    counter.className = 'lightbox3-counter';
    if (isGallery) {
      counter.textContent = `${this.currentIndex + 1}\u2009/\u2009${this.gallery.length}`;
    } else {
      counter.style.display = 'none';
    }
    bar.appendChild(counter);
    this.chromeCounter = counter;

    // Caption
    const captionEl = document.createElement('span');
    captionEl.className = 'lightbox3-caption';
    captionEl.textContent = caption;
    if (!caption) captionEl.style.display = 'none';
    bar.appendChild(captionEl);
    this.chromeCaption = captionEl;

    // Close button
    const close = document.createElement('button');
    close.className = 'lightbox3-close';
    close.setAttribute('aria-label', 'Close');
    close.type = 'button';
    close.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.appendChild(close);
    this.chromeClose = close;
    this.bindPressSpring(close);

    this.overlay.appendChild(bar);
    this.chromeBar = bar;
    this.overlay.focus({ preventScroll: true });

    // Navigation arrows (gallery only)
    if (isGallery) {
      const prev = document.createElement('button');
      prev.className = 'lightbox3-arrow lightbox3-arrow-prev';
      prev.setAttribute('aria-label', 'Previous image');
      prev.type = 'button';
      prev.innerHTML =
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="12,4 6,10 12,16"/></svg>';
      prev.addEventListener('click', (e) => {
        e.stopPropagation();
        this.prev();
      });
      prev.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.overlay.appendChild(prev);
      this.chromePrev = prev;
      this.bindPressSpring(prev);

      const next = document.createElement('button');
      next.className = 'lightbox3-arrow lightbox3-arrow-next';
      next.setAttribute('aria-label', 'Next image');
      next.type = 'button';
      next.innerHTML =
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="8,4 14,10 8,16"/></svg>';
      next.addEventListener('click', (e) => {
        e.stopPropagation();
        this.next();
      });
      next.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.overlay.appendChild(next);
      this.chromeNext = next;
      this.bindPressSpring(next);

      this.updateArrowVisibility();
    }
  }

  private getCurrentCaption(): string {
    if (this.gallery.length > 0) {
      return this.gallery[this.currentIndex]?.caption || '';
    }
    return this.state.triggerEl?.getAttribute('data-caption') || this.state.triggerEl?.getAttribute('data-title') || '';
  }

  private getCurrentAlt(): string {
    if (this.gallery.length > 0) {
      return this.gallery[this.currentIndex]?.alt || '';
    }
    const triggerEl = this.state.triggerEl;
    const img = triggerEl?.querySelector('img') as HTMLImageElement | null;
    return triggerEl?.getAttribute('data-alt') || img?.alt || '';
  }

  private updateChromeContent(): void {
    const caption = this.getCurrentCaption();
    if (this.chromeCounter) {
      this.chromeCounter.textContent = `${this.currentIndex + 1}\u2009/\u2009${this.gallery.length}`;
    }
    if (this.chromeCaption) {
      this.chromeCaption.textContent = caption;
      this.chromeCaption.style.display = caption ? '' : 'none';
    }
    this.updateArrowVisibility();
  }

  private updateArrowVisibility(): void {
    if (this.chromePrev) {
      this.chromePrev.style.display = this.currentIndex > 0 ? '' : 'none';
    }
    if (this.chromeNext) {
      this.chromeNext.style.display =
        this.currentIndex < this.gallery.length - 1 ? '' : 'none';
    }
  }

  /**
   * Compute per-element drift vectors from a thumbnail origin point.
   * Each vector points from the element's resting position back toward the origin,
   * scaled by CHROME_DRIFT. During animation, these are multiplied by chromeDriftProgress
   * so elements appear to launch from / return to the thumbnail location.
   */
  private computeChromeDrift(originX: number, originY: number): void {
    const CHROME_DRIFT = 0.05;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Approximate resting positions of each chrome element
    const barPos = { x: vw / 2, y: vh - 16 };
    const prevPos = { x: 36, y: vh / 2 };
    const nextPos = { x: vw - 36, y: vh / 2 };

    this.chromeDriftVectors = {
      bar: {
        x: (originX - barPos.x) * CHROME_DRIFT,
        y: (originY - barPos.y) * CHROME_DRIFT,
      },
      prev: {
        x: (originX - prevPos.x) * CHROME_DRIFT,
        y: (originY - prevPos.y) * CHROME_DRIFT,
      },
      next: {
        x: (originX - nextPos.x) * CHROME_DRIFT,
        y: (originY - nextPos.y) * CHROME_DRIFT,
      },
    };
  }

  private resetChromeDrift(): void {
    this.chromeDriftProgress = 0;
    this.chromeDriftVectors = { bar: { x: 0, y: 0 }, prev: { x: 0, y: 0 }, next: { x: 0, y: 0 } };
  }

  private animateChrome(target: number): void {
    this.stopChromeSpring();
    // Reset drift — directional drift is only used during open/close morph
    this.resetChromeDrift();

    if (this.reducedMotion) {
      this.chromeSpring = { position: target, velocity: 0 };
      this.updateChromeVisuals();
      return;
    }

    const config = target === 1 ? this.opts.springOpen : this.opts.springClose;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const result = springStep(config, this.chromeSpring, target, dt);
      this.chromeSpring = result;
      this.updateChromeVisuals();

      if (result.settled) {
        this.chromeRafId = null;
        return;
      }
      this.chromeRafId = requestAnimationFrame(tick);
    };

    this.chromeRafId = requestAnimationFrame(tick);
  }

  private updateChromeVisuals(): void {
    const zoom = this.chromeSpring.position;
    const opacity = this.chromeBaseOpacity;
    const interactive = opacity > 0.1 && zoom < 0.5;

    // Slide chrome off viewport edges when zoomed
    const barY = zoom * 120;
    const arrowX = zoom * 100;

    // Per-element directional drift toward/from thumbnail origin
    const p = this.chromeDriftProgress;
    const d = this.chromeDriftVectors;

    if (this.chromeBar) {
      this.chromeBar.style.opacity = String(opacity);
      this.chromeBar.style.transform = `translateX(calc(-50% + ${d.bar.x * p}px)) translateY(${barY + d.bar.y * p}px)`;
      this.chromeBar.style.pointerEvents = interactive ? '' : 'none';
    }
    if (this.chromePrev) {
      const prevScale = this.getPressScale(this.chromePrev);
      this.chromePrev.style.opacity = String(opacity);
      this.chromePrev.style.transform = `translateY(calc(-50% + ${d.prev.y * p}px)) translateX(${-arrowX + d.prev.x * p}px) scale(${prevScale})`;
      this.chromePrev.style.pointerEvents = interactive ? '' : 'none';
    }
    if (this.chromeNext) {
      const nextScale = this.getPressScale(this.chromeNext);
      this.chromeNext.style.opacity = String(opacity);
      this.chromeNext.style.transform = `translateY(calc(-50% + ${d.next.y * p}px)) translateX(${arrowX + d.next.x * p}px) scale(${nextScale})`;
      this.chromeNext.style.pointerEvents = interactive ? '' : 'none';
    }
    if (this.chromeClose) {
      const closeScale = this.getPressScale(this.chromeClose);
      this.chromeClose.style.transform = `scale(${closeScale})`;
      this.chromeClose.style.pointerEvents = interactive ? '' : 'none';
    }
  }

  private stopChromeSpring(): void {
    if (this.chromeRafId !== null) {
      cancelAnimationFrame(this.chromeRafId);
      this.chromeRafId = null;
    }
  }

  // ─── Button press spring ────────────────────────────────────

  private bindPressSpring(btn: HTMLButtonElement): void {
    this.pressSprings.set(btn, { state: { position: 1, velocity: 0 }, target: 1 });
    btn.addEventListener('pointerdown', () => this.animatePressSpring(btn, 0.85));
    btn.addEventListener('pointerup', () => this.animatePressSpring(btn, 1));
    btn.addEventListener('pointerleave', () => this.animatePressSpring(btn, 1));
  }

  private getPressScale(btn: HTMLButtonElement | null): number {
    if (!btn) return 1;
    const entry = this.pressSprings.get(btn);
    return entry ? entry.state.position : 1;
  }

  private animatePressSpring(btn: HTMLButtonElement, target: number): void {
    const entry = this.pressSprings.get(btn);
    if (!entry) return;
    entry.target = target;
    this.startPressLoop();
  }

  private startPressLoop(): void {
    if (this.pressRafId !== null) return;

    if (this.reducedMotion) {
      for (const [, entry] of this.pressSprings) {
        entry.state = { position: entry.target, velocity: 0 };
      }
      this.updateChromeVisuals();
      return;
    }

    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;
      let allSettled = true;
      for (const [, entry] of this.pressSprings) {
        const result = springStep(PRESS_SPRING, entry.state, entry.target, dt);
        entry.state = result;
        if (!result.settled) allSettled = false;
      }
      this.updateChromeVisuals();
      if (allSettled) {
        this.pressRafId = null;
        return;
      }
      this.pressRafId = requestAnimationFrame(tick);
    };
    this.pressRafId = requestAnimationFrame(tick);
  }

  // ─── DOM ─────────────────────────────────────────────────────

  private createOverlay(src: string): void {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox3-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.tabIndex = -1;

    const backdrop = document.createElement('div');
    backdrop.className = 'lightbox3-backdrop';
    backdrop.style.opacity = '0';
    backdrop.addEventListener('click', this.close);

    // Strip container — translates horizontally for gallery navigation
    const strip = document.createElement('div');
    strip.className = 'lightbox3-strip';

    // Center slide
    const { slide, img } = this.createSlide(src, this.getCurrentAlt());
    slide.style.left = '0';
    slide.style.pointerEvents = 'auto';

    strip.appendChild(slide);

    overlay.addEventListener('pointerdown', this.handleOverlayPointerDown);
    overlay.addEventListener('pointermove', this.handlePointerMove);
    overlay.addEventListener('pointerup', this.handlePointerUp);
    overlay.addEventListener('pointercancel', this.handlePointerUp);
    overlay.addEventListener('wheel', this.handleWheel, { passive: false });

    overlay.appendChild(backdrop);
    overlay.appendChild(strip);
    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.backdrop = backdrop;
    this.stripEl = strip;
    this.currentSlideEl = slide;
    this.imgEl = img;
  }

  private createSlide(src: string, alt = ''): { slide: HTMLDivElement; img: HTMLImageElement } {
    const slide = document.createElement('div');
    slide.className = 'lightbox3-slide';

    const img = document.createElement('img');
    img.className = 'lightbox3-image';
    if (src) img.src = src;
    img.alt = alt;
    img.draggable = false;

    img.addEventListener('click', (e) => this.handleImageClick(e));
    img.addEventListener('pointerdown', this.handleImagePointerDown);
    img.addEventListener('pointermove', this.handlePointerMove);
    img.addEventListener('pointerup', this.handlePointerUp);
    img.addEventListener('pointercancel', this.handlePointerUp);

    slide.appendChild(img);
    return { slide, img };
  }

  /** Create and position an adjacent (prev or next) slide in the strip. */
  private createAdjacentSlide(galleryIndex: number, leftPosition: number): void {
    if (!this.stripEl) return;
    const item = this.gallery[galleryIndex];
    if (!item) return;

    const { slide, img } = this.createSlide('', item.alt);
    slide.style.left = `${leftPosition}px`;
    slide.style.pointerEvents = 'none';

    // Use full-res if already cached, otherwise thumbnail
    this.setupSlideImage(img, item);

    this.stripEl.appendChild(slide);

    if (leftPosition < 0) {
      this.prevSlideEl = slide;
      this.prevSlideImg = img;
    } else {
      this.nextSlideEl = slide;
      this.nextSlideImg = img;
    }
  }

  /** Set the src and position for an adjacent slide's image. */
  private setupSlideImage(img: HTMLImageElement, item: GalleryItem): void {
    const br = this.getTargetBorderRadius();
    img.style.borderRadius = br > 0 ? `${br}px` : '';
    const cached = this.preloadCache.get(item.src);
    const fullResReady = cached?.complete && cached.naturalWidth > 0;

    if (fullResReady) {
      img.src = item.src;
      const rect = this.computeTargetRect(cached!.naturalWidth, cached!.naturalHeight);
      this.positionImageEl(img, rect);
    } else {
      img.src = item.thumbSrc || item.src;
      const thumbImg = item.triggerEl.querySelector('img') as HTMLImageElement | null;
      const natW = thumbImg?.naturalWidth || 400;
      const natH = thumbImg?.naturalHeight || 300;
      const rect = this.computeTargetRectFromAspectRatio(natW, natH);
      this.positionImageEl(img, rect);

      // If preload is in progress, upgrade this slide as soon as it completes
      if (cached && !cached.complete) {
        const onLoad = () => {
          cached.removeEventListener('load', onLoad);
          if (this.state.isClosing || !this.state.isOpen) return;
          // Only upgrade if this img is still an adjacent slide (not yet current)
          if (
            (img === this.prevSlideImg || img === this.nextSlideImg) &&
            cached.naturalWidth > 0
          ) {
            img.src = item.src;
            const fullRect = this.computeTargetRect(cached.naturalWidth, cached.naturalHeight);
            this.positionImageEl(img, fullRect);
          }
        };
        cached.addEventListener('load', onLoad);
      }
    }
  }

  /** Position an image element at the given rect. */
  private positionImageEl(img: HTMLImageElement, rect: DOMRect): void {
    Object.assign(img.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  /** Populate prev and next slides for gallery navigation. */
  private populateAdjacentSlides(): void {
    if (!this.stripEl || this.gallery.length <= 1) return;
    const slideWidth = window.innerWidth + SLIDE_GAP;

    if (this.currentIndex > 0) {
      this.createAdjacentSlide(this.currentIndex - 1, -slideWidth);
    }
    if (this.currentIndex < this.gallery.length - 1) {
      this.createAdjacentSlide(this.currentIndex + 1, slideWidth);
    }
  }

  private removeOverlay(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
      this.backdrop = null;
      this.imgEl = null;
      this.stripEl = null;
      this.currentSlideEl = null;
      this.prevSlideEl = null;
      this.prevSlideImg = null;
      this.nextSlideEl = null;
      this.nextSlideImg = null;
      this.chromeBar = null;
      this.chromeCounter = null;
      this.chromeCaption = null;
      this.chromeClose = null;
      this.chromePrev = null;
      this.chromeNext = null;
      this.pressSprings.clear();
      if (this.pressRafId !== null) {
        cancelAnimationFrame(this.pressRafId);
        this.pressRafId = null;
      }
    }
  }

  private positionImage(rect: DOMRect): void {
    if (!this.imgEl) return;
    Object.assign(this.imgEl.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /** Target border-radius for the lightbox image: subtle rounding on desktop, none on mobile. */
  private getTargetBorderRadius(): number {
    return window.innerWidth > 600 ? DESKTOP_BORDER_RADIUS : 0;
  }

  /** Read the visual border-radius from the thumbnail's trigger element. */
  private getThumbBorderRadius(el: HTMLElement): number {
    // Check the trigger element first (wrapping anchor/div with overflow:hidden),
    // then fall back to the image inside it.
    const elRadius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    if (elRadius > 0) return elRadius;
    const img = el.querySelector('img');
    return img ? parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0 : 0;
  }

  private getThumbRect(el: HTMLElement): DOMRect {
    const img = el.querySelector('img') as HTMLImageElement | null;
    if (!img) return el.getBoundingClientRect();

    const elRect = img.getBoundingClientRect();
    const objectFit = getComputedStyle(img).objectFit;

    if (objectFit !== 'cover' || !img.naturalWidth || !img.naturalHeight) {
      return elRect;
    }

    // When object-fit: cover is used, the image is scaled up to fill the container
    // and cropped. Compute the virtual rect of the full uncropped image so the FLIP
    // animation origin has the correct aspect ratio (no jitter from crop mismatch).
    const natRatio = img.naturalWidth / img.naturalHeight;
    const elRatio = elRect.width / elRect.height;

    let renderedW: number, renderedH: number;
    if (natRatio > elRatio) {
      // Image wider than container: height-matched, cropped horizontally
      renderedH = elRect.height;
      renderedW = elRect.height * natRatio;
    } else {
      // Image taller than container: width-matched, cropped vertically
      renderedW = elRect.width;
      renderedH = elRect.width / natRatio;
    }

    // Parse object-position (default 50% 50%) to find crop offset
    const pos = getComputedStyle(img).objectPosition || '50% 50%';
    const parts = pos.split(/\s+/);
    const px = parts[0]?.endsWith('%') ? parseFloat(parts[0]) / 100 : 0.5;
    const py = parts[1]?.endsWith('%') ? parseFloat(parts[1]) / 100 : 0.5;

    const offsetX = (elRect.width - renderedW) * px;
    const offsetY = (elRect.height - renderedH) * py;

    return new DOMRect(elRect.x + offsetX, elRect.y + offsetY, renderedW, renderedH);
  }

  private computeCropInsets(
    el: HTMLElement,
    virtualRect: DOMRect,
    targetRect: DOMRect,
  ): { top: number; right: number; bottom: number; left: number } {
    const zero = { top: 0, right: 0, bottom: 0, left: 0 };
    const img = el.querySelector('img') as HTMLImageElement | null;
    if (!img || getComputedStyle(img).objectFit !== 'cover') return zero;

    const elRect = img.getBoundingClientRect();

    // Fraction of the virtual rect that is cropped on each side
    const topFrac = Math.max(0, elRect.top - virtualRect.top) / virtualRect.height;
    const leftFrac = Math.max(0, elRect.left - virtualRect.left) / virtualRect.width;
    const bottomFrac = Math.max(0, virtualRect.bottom - elRect.bottom) / virtualRect.height;
    const rightFrac = Math.max(0, virtualRect.right - elRect.right) / virtualRect.width;

    // Convert to pixel insets in the lightbox image's coordinate space
    return {
      top: topFrac * targetRect.height,
      right: rightFrac * targetRect.width,
      bottom: bottomFrac * targetRect.height,
      left: leftFrac * targetRect.width,
    };
  }

  /**
   * Compute FLIP scale and crop insets for morphing between the lightbox image
   * and a thumbnail. Handles both CSS object-fit:cover cropping and server-side
   * aspect ratio mismatches (e.g. Unsplash ?fit=crop).
   */
  private computeFlipCrop(
    morphRect: DOMRect,
    fitRect: DOMRect,
    triggerEl: HTMLElement | null,
    isTextLink: boolean,
  ): { flipScale: number; hasCrop: boolean } {
    const scaleX = morphRect.width / fitRect.width;
    const scaleY = morphRect.height / fitRect.height;

    // Try CSS object-fit:cover crop detection first.
    // Threshold filters out subpixel floating-point noise from getThumbRect.
    if (!isTextLink && triggerEl) {
      this.cropInsets = this.computeCropInsets(triggerEl, morphRect, fitRect);
      const cssCrop =
        this.cropInsets.top + this.cropInsets.right + this.cropInsets.bottom + this.cropInsets.left;
      if (cssCrop > 1) {
        return { flipScale: Math.min(scaleX, scaleY), hasCrop: true };
      }
    }

    // Check for aspect ratio mismatch (e.g. server-side crop produces different
    // aspect ratio than the full-res image). When present, use Math.max (fill)
    // instead of Math.min (fit) and clip the excess via clip-path.
    const morphRatio = morphRect.width / morphRect.height;
    const fitRatio = fitRect.width / fitRect.height;
    const relDiff = Math.abs(morphRatio - fitRatio) / Math.max(morphRatio, fitRatio);

    if (!isTextLink && relDiff > 0.05) {
      const flipScale = Math.max(scaleX, scaleY);
      // What portion of the local (pre-transform) image is visible after scaling
      const visibleLocalW = morphRect.width / flipScale;
      const visibleLocalH = morphRect.height / flipScale;
      // Symmetric (centered) crop — matches the common center-crop default
      this.cropInsets = {
        top: Math.max(0, (fitRect.height - visibleLocalH) / 2),
        bottom: Math.max(0, (fitRect.height - visibleLocalH) / 2),
        left: Math.max(0, (fitRect.width - visibleLocalW) / 2),
        right: Math.max(0, (fitRect.width - visibleLocalW) / 2),
      };
      return { flipScale, hasCrop: true };
    }

    // No crop needed — aspect ratios match
    return { flipScale: Math.min(scaleX, scaleY), hasCrop: false };
  }

  private setThumbVisibility(visible: boolean): void {
    if (!this.state.triggerEl) return;
    const img = this.state.triggerEl.querySelector('img') || this.state.triggerEl;
    (img as HTMLElement).style.visibility = visible ? '' : 'hidden';
  }

  private computeTargetRect(naturalWidth: number, naturalHeight: number): DOMRect {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw <= 600;
    const px = isMobile ? 0 : this.opts.padding;
    const py = isMobile ? 20 : this.opts.padding;
    const scale = Math.min((vw - px * 2) / naturalWidth, (vh - py * 2) / naturalHeight, 1);
    const w = naturalWidth * scale;
    const h = naturalHeight * scale;
    return new DOMRect((vw - w) / 2, (vh - h) / 2, w, h);
  }

  /** Like computeTargetRect but without the scale ≤ 1 cap. Used when full-res
   *  dimensions are unknown — fills the viewport based on aspect ratio alone. */
  private computeTargetRectFromAspectRatio(width: number, height: number): DOMRect {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw <= 600;
    const px = isMobile ? 0 : this.opts.padding;
    const py = isMobile ? 20 : this.opts.padding;
    const scale = Math.min((vw - px * 2) / width, (vh - py * 2) / height);
    const w = width * scale;
    const h = height * scale;
    return new DOMRect((vw - w) / 2, (vh - h) / 2, w, h);
  }

  private loadImage(src: string): Promise<{ width: number; height: number }> {
    const cached = this.preloadCache.get(src);
    if (cached?.complete && cached.naturalWidth > 0) {
      return Promise.resolve({ width: cached.naturalWidth, height: cached.naturalHeight });
    }
    return new Promise((resolve) => {
      const img = cached || new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 800, height: 600 });
      if (!cached) {
        img.src = src;
        this.preloadCache.set(src, img);
      }
    });
  }

  private isInViewport(rect: DOMRect): boolean {
    return (
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  // ─── Debug panel ────────────────────────────────────────────

  private debugEl: HTMLDivElement | null = null;
  private debugStateEl: HTMLDivElement | null = null;
  private debugLogEl: HTMLDivElement | null = null;
  private debugRafId: number | null = null;
  private debugLogEntries: string[] = [];
  private debugT0: number = 0;

  private startDebugPanel(): void {
    if (!this.opts.debug || this.debugEl) return;
    this.debugT0 = performance.now();
    this.debugLogEntries = [];

    // Container: two-column layout
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      zIndex: '9999999',
      display: 'flex',
      gap: '8px',
      fontFamily: 'monospace',
      fontSize: '11px',
      lineHeight: '1.5',
      pointerEvents: 'none',
    });

    // Left column: live state
    const stateCol = document.createElement('div');
    Object.assign(stateCol.style, {
      background: 'rgba(0,0,0,0.85)',
      color: '#0f0',
      padding: '8px 12px',
      borderRadius: '6px',
      whiteSpace: 'pre',
      minWidth: '260px',
    });

    // Right column: event log
    const logCol = document.createElement('div');
    Object.assign(logCol.style, {
      background: 'rgba(0,0,0,0.85)',
      color: '#ccc',
      padding: '8px 12px',
      borderRadius: '6px',
      whiteSpace: 'pre',
      minWidth: '280px',
      maxHeight: '400px',
      overflowY: 'auto',
      pointerEvents: 'auto',
    });
    logCol.textContent = '── event log ──────────\n';

    el.appendChild(stateCol);
    el.appendChild(logCol);
    document.body.appendChild(el);
    this.debugEl = el;
    this.debugStateEl = stateCol;
    this.debugLogEl = logCol;

    const tick = () => {
      this.updateDebugPanel();
      this.debugRafId = requestAnimationFrame(tick);
    };
    this.debugRafId = requestAnimationFrame(tick);
  }

  private stopDebugPanel(): void {
    if (this.debugRafId !== null) {
      cancelAnimationFrame(this.debugRafId);
      this.debugRafId = null;
    }
    if (this.debugEl) {
      this.debugEl.remove();
      this.debugEl = null;
      this.debugStateEl = null;
      this.debugLogEl = null;
    }
  }

  private debugLog(msg: string): void {
    if (!this.debugLogEl) return;
    const t = ((performance.now() - this.debugT0) / 1000).toFixed(2);
    const entry = `${t}s  ${msg}`;
    this.debugLogEntries.push(entry);
    // Keep last 100 entries
    if (this.debugLogEntries.length > 100) this.debugLogEntries.shift();
    this.debugLogEl.textContent =
      '── event log ──────────\n' + this.debugLogEntries.join('\n');
    this.debugLogEl.scrollTop = this.debugLogEl.scrollHeight;
  }

  private updateDebugPanel(): void {
    if (!this.debugStateEl) return;

    const on = (v: boolean) => (v ? '●' : '○');
    const px = (v: number) => v.toFixed(1);

    const lines: string[] = [
      `── state ──────────────`,
      `isOpen:${on(this.state.isOpen)}  isAnim:${on(this.state.isAnimating)}  isClosing:${on(this.state.isClosing)}`,
      `gallery: ${this.currentIndex + 1}/${this.gallery.length || 1}`,
      ``,
      `── springs ────────────`,
      `mainRaf:  ${on(this.rafId !== null)}`,
      `stripRaf: ${on(this.stripRafId !== null)}  offset: ${px(this.stripOffset)}`,
      `chromeRaf:${on(this.chromeRafId !== null)}`,
      `pendingNav: ${this.pendingNavDirection ?? 'none'}`,
      ``,
      `── zoom ───────────────`,
      `scale: ${px(this.zoom.scale)}  zoomed:${on(this.zoom.zoomed)}`,
      `pan: ${px(this.zoom.panX)}, ${px(this.zoom.panY)}`,
      `dragging:${on(this.zoom.isDragging)}  dragMoved:${on(this.zoom.dragMoved)}`,
      ``,
      `── gestures ───────────`,
      `dismiss: track:${on(this.dismiss.tracking)} active:${on(this.dismiss.active)}`,
      `swipeNav: ${on(this.swipeNav.active)}`,
      `pinch: ${on(this.pinch.active)}`,
      ``,
      `── wheel nav ──────────`,
      `committed:${on(this.wheelNavCommitted)}`,
      `totalDelta: ${px(this.wheelNavTotalDelta)}`,
      `gestureTimer: ${on(this.wheelGestureTimer !== null)}`,
      `dismissY: ${px(this.wheelDismissY)}`,
    ];

    // Gallery preload status
    if (this.gallery.length > 1) {
      lines.push('', '── gallery preload ────');
      for (let i = 0; i < this.gallery.length; i++) {
        const item = this.gallery[i];
        const cached = this.preloadCache.get(item.src);
        const isCurrent = i === this.currentIndex;
        const marker = isCurrent ? '▸' : ' ';

        let status: string;
        if (cached?.complete && cached.naturalWidth > 0) {
          status = `● ${cached.naturalWidth}×${cached.naturalHeight}`;
        } else if (cached) {
          status = '◐ loading';
        } else {
          status = '○ pending';
        }

        // Truncate filename for display
        const filename = item.src.split('/').pop() || item.src;
        const name = filename.length > 20 ? filename.slice(0, 19) + '…' : filename;
        lines.push(`${marker}${String(i + 1).padStart(2)} ${name.padEnd(20)} ${status}`);
      }
    }

    this.debugStateEl.textContent = lines.join('\n');
  }
}

// ─── Utility functions ───────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rubberBand(value: number, min: number, max: number): number {
  if (value < min) return min - (min - value) * RUBBER_BAND_FACTOR;
  if (value > max) return max + (value - max) * RUBBER_BAND_FACTOR;
  return value;
}
