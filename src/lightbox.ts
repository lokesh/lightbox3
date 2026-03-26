import { springStep, SPRING_OPEN, SPRING_CLOSE } from './physics/spring';
import type { SpringConfig, SpringState } from './physics/spring';
// Note: easing.ts is no longer used — all animations are rAF + spring physics

export interface LightboxOptions {
  selector?: string;
  springOpen?: SpringConfig;
  springClose?: SpringConfig;
  padding?: number;
}

const DEFAULTS: Required<LightboxOptions> = {
  selector: '[data-lightbox]',
  springOpen: SPRING_OPEN,
  springClose: SPRING_CLOSE,
  padding: 40,
};

// For text-link triggers, the image fades in/out quickly at the animation edges.
// When backdrop opacity is below this threshold, the image opacity is proportional;
// above it, the image is fully opaque. Tune this to control fade speed.
const TEXT_LINK_FADE_THRESHOLD = 0.3;

interface LightboxState {
  isOpen: boolean;
  isAnimating: boolean;
  isClosing: boolean;
  triggerEl: HTMLElement | null;
  currentSrc: string;
}

interface ZoomState {
  zoomed: boolean;
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
}

interface PinchState {
  active: boolean;
  initialDistance: number;
  initialScale: number;
  initialPanX: number;
  initialPanY: number;
  initialMidX: number;
  initialMidY: number;
}

interface VelocitySample {
  x: number;
  y: number;
  t: number;
}

const PRELOAD_DELAY = 80;
const DRAG_THRESHOLD = 4;
const RUBBER_BAND_FACTOR = 0.35;
const VELOCITY_WINDOW = 80;
const PAN_SPRING: SpringConfig = { stiffness: 170, damping: 26, mass: 1 };
const SNAP_SPRING: SpringConfig = { stiffness: 300, damping: 30, mass: 1 };
const PINCH_RUBBER_BAND_FACTOR = 0.4;

export class Lightbox {
  private opts: Required<LightboxOptions>;
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

  // Preload
  private preloadCache = new Map<string, HTMLImageElement>();
  private preloadTimer: ReturnType<typeof setTimeout> | null = null;

  // Velocity tracking
  private velocitySamples: VelocitySample[] = [];

  // Pointer cache for multi-touch (pinch)
  private pointerCache: PointerEvent[] = [];
  private pinch: PinchState = this.defaultPinchState();

  // rAF animation handle (single loop for all spring animations)
  private rafId: number | null = null;

  // Crop insets for object-fit:cover thumbnail animation (pixels in lightbox image space)
  private cropInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  // Text-link trigger: fade the image in/out quickly at animation edges
  private isTextLink = false;

  constructor(opts: LightboxOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };

    this.handleClick = this.handleClick.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
    this.handlePointerEnter = this.handlePointerEnter.bind(this);
    this.handlePointerLeave = this.handlePointerLeave.bind(this);
    this.handleImagePointerDown = this.handleImagePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.close = this.close.bind(this);

    this.attach();
  }

  static init(opts?: LightboxOptions): Lightbox {
    return new Lightbox(opts);
  }

  private attach(): void {
    document.addEventListener('click', this.handleClick);
    document.addEventListener('pointerenter', this.handlePointerEnter, true);
    document.addEventListener('pointerleave', this.handlePointerLeave, true);
  }

  destroy(): void {
    document.removeEventListener('click', this.handleClick);
    document.removeEventListener('pointerenter', this.handlePointerEnter, true);
    document.removeEventListener('pointerleave', this.handlePointerLeave, true);
    this.cancelPreload();
    this.stopSpring();
    this.removeOverlay();
  }

  private defaultZoomState(): ZoomState {
    return {
      zoomed: false,
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
      this.state.isAnimating = false;
      this.state.isClosing = false;
      this.finishClose();
      this.open(trigger, src);
      return;
    }

    this.open(trigger, src);
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.zoom.zoomed || this.zoom.scale !== 1) {
        // Any zoom state (idle, animating in, or animating out) — zoom out
        this.zoomOut();
      } else {
        this.close();
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

    this.state.isOpen = true;
    this.state.isAnimating = true;
    this.state.triggerEl = triggerEl;
    this.state.currentSrc = src;

    const thumbImg = triggerEl.querySelector('img') as HTMLImageElement | null;
    const thumbSrc = thumbImg?.currentSrc || thumbImg?.src || '';
    this.isTextLink = !thumbImg;
    const thumbRect = this.getThumbRect(triggerEl);

    this.createOverlay(thumbSrc || src);
    document.addEventListener('keydown', this.handleKeydown);
    if (thumbImg) this.setThumbVisibility(false);

    const thumbNatW = thumbImg?.naturalWidth || thumbRect.width;
    const thumbNatH = thumbImg?.naturalHeight || thumbRect.height;

    const cached = this.preloadCache.get(src);
    const fullResReady = cached?.complete && cached.naturalWidth > 0;

    const natW = fullResReady ? cached!.naturalWidth : thumbNatW;
    const natH = fullResReady ? cached!.naturalHeight : thumbNatH;
    const targetRect = this.computeTargetRect(natW, natH);

    // Place image at final size/position, then FLIP from thumbnail
    this.positionImage(targetRect);

    this.zoom = this.defaultZoomState();
    this.zoom.fitRect = targetRect;
    this.zoom.naturalWidth = natW;
    this.zoom.naturalHeight = natH;

    // Compute the FLIP transform: what transform makes the image look like it's at thumbRect?
    const scaleX = thumbRect.width / targetRect.width;
    const scaleY = thumbRect.height / targetRect.height;
    const flipScale = Math.min(scaleX, scaleY);
    const flipX = (thumbRect.x + thumbRect.width / 2) - (targetRect.x + targetRect.width / 2);
    const flipY = (thumbRect.y + thumbRect.height / 2) - (targetRect.y + targetRect.height / 2);

    // Compute crop insets for object-fit:cover thumbnails
    this.cropInsets = this.computeCropInsets(triggerEl, thumbRect, targetRect);
    const hasCrop = this.cropInsets.top + this.cropInsets.right +
                    this.cropInsets.bottom + this.cropInsets.left > 0;

    // Start full-res load immediately so it continues regardless of animation interrupts
    if (thumbSrc && thumbSrc !== src) {
      this.swapToFullRes(src, natW, natH);
    }

    // Start spring from FLIP position → identity
    this.animateSpring(
      { translateX: flipX, translateY: flipY, scale: flipScale, opacity: 0, crop: hasCrop ? 1 : 0 },
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0 },
      this.opts.springOpen,
      () => {
        this.state.isAnimating = false;
        this.updateCursorState();
      },
    );
  }

  private swapToFullRes(src: string, currentNatW: number, currentNatH: number): void {
    this.loadImage(src).then((size) => {
      if (!this.imgEl || this.state.currentSrc !== src) return;

      this.imgEl.src = src;
      this.zoom.naturalWidth = size.width;
      this.zoom.naturalHeight = size.height;

      const needsReposition = Math.abs(size.width / size.height - currentNatW / currentNatH) > 0.01;
      if (needsReposition && !this.zoom.zoomed) {
        const targetRect = this.computeTargetRect(size.width, size.height);
        this.zoom.fitRect = targetRect;
        this.positionImage(targetRect);
      }

      this.updateCursorState();
    });
  }

  close(): void {
    if (this.state.isClosing) return;
    if (!this.state.isOpen && !this.state.isAnimating) return;

    this.state.isClosing = true;
    this.stopSpring();
    this.state.isAnimating = false;

    // Let clicks pass through to thumbnails underneath during close
    if (this.overlay) this.overlay.style.pointerEvents = 'none';

    // If zoomed, reset zoom first then close
    if (this.zoom.zoomed) {
      this.zoom.scale = 1;
      this.zoom.panX = 0;
      this.zoom.panY = 0;
      this.zoom.zoomed = false;
      this.imgEl!.style.transform = '';
    }

    this.state.isAnimating = true;

    const thumbRect = this.state.triggerEl
      ? this.getThumbRect(this.state.triggerEl)
      : null;

    const closeWhenInvisible = (s: AnimState) => s.opacity < 0.01;

    if (!thumbRect || !this.isInViewport(thumbRect)) {
      this.animateSpring(
        { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0 },
        { translateX: 0, translateY: 0, scale: 1, opacity: 0, crop: 0 },
        this.opts.springClose,
        () => this.finishClose(),
        closeWhenInvisible,
      );
      return;
    }

    const { fitRect } = this.zoom;
    const scaleX = thumbRect.width / fitRect.width;
    const scaleY = thumbRect.height / fitRect.height;
    const flipScale = Math.min(scaleX, scaleY);
    const flipX = (thumbRect.x + thumbRect.width / 2) - (fitRect.x + fitRect.width / 2);
    const flipY = (thumbRect.y + thumbRect.height / 2) - (fitRect.y + fitRect.height / 2);

    // Recompute crop insets for close (thumb may have moved since open)
    this.cropInsets = this.computeCropInsets(this.state.triggerEl!, thumbRect, fitRect);
    const hasCrop = this.cropInsets.top + this.cropInsets.right +
                    this.cropInsets.bottom + this.cropInsets.left > 0;

    this.animateSpring(
      { translateX: 0, translateY: 0, scale: 1, opacity: 1, crop: 0 },
      { translateX: flipX, translateY: flipY, scale: flipScale, opacity: 0, crop: hasCrop ? 1 : 0 },
      this.opts.springClose,
      () => this.finishClose(),
      closeWhenInvisible,
    );
  }


  private finishClose(): void {
    this.setThumbVisibility(true);
    this.removeOverlay();
    document.removeEventListener('keydown', this.handleKeydown);

    this.state.isOpen = false;
    this.state.isAnimating = false;
    this.state.isClosing = false;
    this.state.triggerEl = null;
    this.zoom = this.defaultZoomState();
    this.pointerCache = [];
    this.pinch = this.defaultPinchState();
  }

  // ─── Spring animation engine (rAF) ──────────────────────────

  private animateSpring(
    from: AnimState,
    to: AnimState,
    config: SpringConfig,
    onComplete: () => void,
    earlyComplete?: (current: AnimState) => boolean,
  ): void {
    this.stopSpring();

    const img = this.imgEl!;
    const backdrop = this.backdrop!;

    // One spring per animated property
    const springs: {
      key: string;
      state: SpringState;
      target: number;
    }[] = [
      { key: 'translateX', state: { position: from.translateX, velocity: 0 }, target: to.translateX },
      { key: 'translateY', state: { position: from.translateY, velocity: 0 }, target: to.translateY },
      { key: 'scale', state: { position: from.scale, velocity: 0 }, target: to.scale },
      { key: 'opacity', state: { position: from.opacity, velocity: 0 }, target: to.opacity },
      { key: 'crop', state: { position: from.crop, velocity: 0 }, target: to.crop },
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
        const result = springStep(config, s.state, s.target, dt);
        s.state = result;
        current[s.key] = result.position;
        if (!result.settled) allSettled = false;
      }

      const currentState = current as unknown as AnimState;
      this.applyAnimState(img, backdrop, currentState);

      if (allSettled || earlyComplete?.(currentState)) {
        // Snap to exact final values
        this.applyAnimState(img, backdrop, to);
        this.rafId = null;
        onComplete();
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private applyAnimState(
    img: HTMLImageElement,
    backdrop: HTMLDivElement,
    state: AnimState,
  ): void {
    img.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
    backdrop.style.opacity = String(state.opacity);

    // Text-link triggers: fade the image quickly at animation edges to mask the
    // aspect ratio mismatch when the image is small near the text.
    if (this.isTextLink) {
      const imgOpacity = Math.min(1, state.opacity / TEXT_LINK_FADE_THRESHOLD);
      img.style.opacity = String(imgOpacity);
    } else {
      img.style.opacity = '';
    }

    if (state.crop > 0.001) {
      const { top, right, bottom, left } = this.cropInsets;
      img.style.clipPath = `inset(${state.crop * top}px ${state.crop * right}px ${state.crop * bottom}px ${state.crop * left}px)`;
    } else {
      img.style.clipPath = '';
    }
  }

  // ─── Zoom ────────────────────────────────────────────────────

  private isZoomable(): boolean {
    const { fitRect, naturalWidth, naturalHeight } = this.zoom;
    return naturalWidth > fitRect.width * 1.05 || naturalHeight > fitRect.height * 1.05;
  }

  private getZoomScale(): number {
    const { fitRect, naturalWidth } = this.zoom;
    const nativeScale = naturalWidth / fitRect.width;
    return Math.max(nativeScale, 2);
  }

  private zoomIn(clickX: number, clickY: number): void {
    if (!this.imgEl || !this.isZoomable()) return;

    this.stopSpring();
    this.state.isAnimating = true;

    const { fitRect } = this.zoom;
    const targetScale = this.getZoomScale();

    const imgCenterX = fitRect.x + fitRect.width / 2;
    const imgCenterY = fitRect.y + fitRect.height / 2;
    const relX = clickX - imgCenterX;
    const relY = clickY - imgCenterY;

    let panX = -(relX * targetScale - relX);
    let panY = -(relY * targetScale - relY);

    const bounds = this.computePanBounds(targetScale);
    panX = clamp(panX, bounds.minX, bounds.maxX);
    panY = clamp(panY, bounds.minY, bounds.maxY);

    const fromPanX = this.zoom.panX;
    const fromPanY = this.zoom.panY;
    const fromScale = this.zoom.scale;

    // Spring from current → target zoom state
    let sX: SpringState = { position: fromPanX, velocity: 0 };
    let sY: SpringState = { position: fromPanY, velocity: 0 };
    let sScale: SpringState = { position: fromScale, velocity: 0 };

    const config = this.opts.springOpen;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const rX = springStep(config, sX, panX, dt);
      const rY = springStep(config, sY, panY, dt);
      const rS = springStep(config, sScale, targetScale, dt);

      sX = rX; sY = rY; sScale = rS;

      this.zoom.panX = rX.position;
      this.zoom.panY = rY.position;
      this.zoom.scale = rS.position;
      this.applyPanTransform();

      if (rX.settled && rY.settled && rS.settled) {
        this.zoom.panX = panX;
        this.zoom.panY = panY;
        this.zoom.scale = targetScale;
        this.zoom.zoomed = true;
        this.applyPanTransform();

        this.rafId = null;
        this.state.isAnimating = false;
        this.updateCursorState();
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private zoomOut(): void {
    if (!this.imgEl) return;

    this.stopSpring();
    this.state.isAnimating = true;

    const fromPanX = this.zoom.panX;
    const fromPanY = this.zoom.panY;
    const fromScale = this.zoom.scale;

    let sX: SpringState = { position: fromPanX, velocity: 0 };
    let sY: SpringState = { position: fromPanY, velocity: 0 };
    let sScale: SpringState = { position: fromScale, velocity: 0 };

    const config = this.opts.springClose;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const rX = springStep(config, sX, 0, dt);
      const rY = springStep(config, sY, 0, dt);
      const rS = springStep(config, sScale, 1, dt);

      sX = rX; sY = rY; sScale = rS;

      this.zoom.panX = rX.position;
      this.zoom.panY = rY.position;
      this.zoom.scale = rS.position;
      this.applyPanTransform();

      if (rX.settled && rY.settled && rS.settled) {
        this.zoom.panX = 0;
        this.zoom.panY = 0;
        this.zoom.scale = 1;
        this.zoom.zoomed = false;
        this.applyPanTransform();

        this.rafId = null;
        this.state.isAnimating = false;
        this.updateCursorState();
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

    // Single pointer — only allow drag when zoomed
    if (this.zoom.scale <= 1) return;

    // Interrupt any in-progress zoom animation — user is grabbing it
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

  private handlePointerMove(e: PointerEvent): void {
    if (!this.imgEl) return;

    // Update pointer in cache
    const idx = this.pointerCache.findIndex(p => p.pointerId === e.pointerId);
    if (idx >= 0) this.pointerCache[idx] = e;

    // Pinch active — handle two-finger zoom+pan
    if (this.pinch.active && this.pointerCache.length === 2) {
      this.updatePinch();
      return;
    }

    // Single-finger drag
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
    this.pointerCache = this.pointerCache.filter(p => p.pointerId !== e.pointerId);

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

    // Single-finger drag end
    if (!this.zoom.isDragging) return;

    const wasDrag = this.zoom.dragMoved;
    this.zoom.isDragging = false;
    // Don't clear dragMoved here — handleImageClick needs it to suppress the click
    this.updateCursorState();

    if (!wasDrag) {
      this.zoomOut();
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

  // ─── Pinch-to-zoom ─────────────────────────────────────────

  private startPinch(): void {
    // Cancel any in-progress animation
    this.stopSpring();
    this.state.isAnimating = false;
    this.zoom.isDragging = false;

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
    };
  }

  private updatePinch(): void {
    const [p1, p2] = this.pointerCache;
    const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
    const midX = (p1.clientX + p2.clientX) / 2;
    const midY = (p1.clientY + p2.clientY) / 2;

    const ratio = dist / this.pinch.initialDistance;
    const maxScale = this.getZoomScale();

    let newScale = this.pinch.initialScale * ratio;
    // Rubber-band past min/max
    if (newScale < 1) {
      newScale = 1 - (1 - newScale) * PINCH_RUBBER_BAND_FACTOR;
    } else if (newScale > maxScale) {
      newScale = maxScale + (newScale - maxScale) * PINCH_RUBBER_BAND_FACTOR;
    }

    // Focal-point correction: keep the midpoint pinned to the same content
    const { fitRect } = this.zoom;
    const imgCenterX = fitRect.x + fitRect.width / 2;
    const imgCenterY = fitRect.y + fitRect.height / 2;

    // Vector from image center to initial midpoint in screen space
    const relX = this.pinch.initialMidX - imgCenterX;
    const relY = this.pinch.initialMidY - imgCenterY;

    // Pan offset so that content under the initial midpoint stays under the current midpoint
    const scaleRatio = newScale / this.pinch.initialScale;
    const panX = this.pinch.initialPanX + (midX - this.pinch.initialMidX) - (relX - this.pinch.initialPanX) * (scaleRatio - 1);
    const panY = this.pinch.initialPanY + (midY - this.pinch.initialMidY) - (relY - this.pinch.initialPanY) * (scaleRatio - 1);

    this.zoom.scale = newScale;
    this.zoom.panX = panX;
    this.zoom.panY = panY;
    this.applyPanTransform();
  }

  private endPinch(): void {
    this.pinch.active = false;
    this.zoom.dragMoved = true; // Suppress the click that follows

    const maxScale = this.getZoomScale();

    if (this.zoom.scale < 1) {
      // Snap back to 1 (opened state)
      this.springToZoomState(1, 0, 0, SNAP_SPRING, false);
    } else if (this.zoom.scale > maxScale) {
      // Clamp to max scale, keep pan clamped
      const bounds = this.computePanBounds(maxScale);
      const panX = clamp(this.zoom.panX, bounds.minX, bounds.maxX);
      const panY = clamp(this.zoom.panY, bounds.minY, bounds.maxY);
      this.springToZoomState(maxScale, panX, panY, SNAP_SPRING, true);
    } else {
      // Valid zoom — clamp pan to bounds and settle
      this.zoom.zoomed = this.zoom.scale > 1;
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

  private springToZoomState(
    targetScale: number,
    targetPanX: number,
    targetPanY: number,
    config: SpringConfig,
    zoomed: boolean,
  ): void {
    this.stopSpring();
    this.state.isAnimating = true;

    let sX: SpringState = { position: this.zoom.panX, velocity: 0 };
    let sY: SpringState = { position: this.zoom.panY, velocity: 0 };
    let sScale: SpringState = { position: this.zoom.scale, velocity: 0 };

    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const rX = springStep(config, sX, targetPanX, dt);
      const rY = springStep(config, sY, targetPanY, dt);
      const rS = springStep(config, sScale, targetScale, dt);

      sX = rX; sY = rY; sScale = rS;

      this.zoom.panX = rX.position;
      this.zoom.panY = rY.position;
      this.zoom.scale = rS.position;
      this.applyPanTransform();

      if (rX.settled && rY.settled && rS.settled) {
        this.zoom.panX = targetPanX;
        this.zoom.panY = targetPanY;
        this.zoom.scale = targetScale;
        this.zoom.zoomed = zoomed;
        this.applyPanTransform();

        this.rafId = null;
        this.state.isAnimating = false;
        this.updateCursorState();
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

  private computePanBounds(scale: number): { minX: number; maxX: number; minY: number; maxY: number } {
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

  // ─── DOM ─────────────────────────────────────────────────────

  private createOverlay(src: string): void {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox3-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const backdrop = document.createElement('div');
    backdrop.className = 'lightbox3-backdrop';
    backdrop.style.opacity = '0';
    backdrop.addEventListener('click', this.close);

    const img = document.createElement('img');
    img.className = 'lightbox3-image';
    img.src = src;
    img.draggable = false;

    img.addEventListener('click', (e) => this.handleImageClick(e));
    img.addEventListener('pointerdown', this.handleImagePointerDown);
    img.addEventListener('pointermove', this.handlePointerMove);
    img.addEventListener('pointerup', this.handlePointerUp);
    img.addEventListener('pointercancel', this.handlePointerUp);

    overlay.appendChild(backdrop);
    overlay.appendChild(img);
    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.backdrop = backdrop;
    this.imgEl = img;
  }

  private removeOverlay(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
      this.backdrop = null;
      this.imgEl = null;
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

    return new DOMRect(
      elRect.x + offsetX,
      elRect.y + offsetY,
      renderedW,
      renderedH,
    );
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
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
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
