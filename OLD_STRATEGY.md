# Lightbox3 — Strategic Plan

## The Opportunity

The lightbox library space is ripe for disruption:

- **PhotoSwipe** (market leader, ~470K weekly downloads) is maintained by a single developer who has publicly discussed burnout and abandoning the project for a year. Last npm release was May 2024. Best-in-class touch gestures but poor accessibility, requires predefined image dimensions, no video support.
- **Magnific Popup** (#2 by downloads at ~112K/week) is completely unmaintained with 678 open issues. A massive installed base with no upgrade path.
- **Lightbox2** (~71K/week) still requires jQuery and is functionally legacy.
- **Fancybox** has a confusing paid licensing model that many teams can't use. Polished but commercially constrained.
- **lightGallery** (~94K/week) is feature-rich but GPLv3 — a dealbreaker for most commercial projects.
- **GLightbox** (~50K/week) is stalling — no stable release in over a year.

**Every major lightbox library is either unmaintained, poorly licensed, has a single maintainer at risk of burnout, or is missing critical modern features.** No library uses the View Transitions API or has physics-based touch interactions that feel native.

The fundamental gap between these libraries and native photo viewers (iOS Photos, Google Photos) isn't about features — it's about **interaction quality**. Specifically: interruptibility, gesture-driven transitions, spatial awareness, and physical realism. No web lightbox closes this gap. Lightbox3 will.

Lokesh Dhakar — the originator of the lightbox pattern — is uniquely positioned to reclaim this space.

---

## Competitive Landscape

### Feature Matrix

| Feature | PhotoSwipe | Fancybox | lightGallery | GLightbox | SimpleLightbox | Tobii |
|---|---|---|---|---|---|---|
| **License** | MIT | Commercial | GPLv3 | MIT | MIT | MIT |
| **Dependencies** | 0 | 0 | 0 | 0 | 0 | 0 |
| **Bundle (gzip)** | ~15 KB | ~15-20 KB | ~13 KB core | ~15 KB | ~9 KB | ~6 KB |
| **TypeScript** | No (planned v6) | Yes | Yes | No | No | No |
| **Pinch-to-zoom** | Excellent | Good | Good | No | Good | No |
| **Swipe nav** | Excellent | Good | Good | Good | Good | Good |
| **Drag-to-close** | Good | Good | No | No | Good | No |
| **Physics/momentum** | Yes | Yes | Limited | No | No | No |
| **Captions** | Plugin only | Yes | Plugin | Yes | Yes | No |
| **Video support** | Plugin (weak) | Built-in | Built-in | Built-in | No | Yes |
| **Thumbnails strip** | No (planned v6) | Yes | Plugin | No | No | No |
| **View Transitions** | No | No | No | No | No | No |
| **Focus trapping** | No | Yes | No | No | No | Yes |
| **ARIA roles** | Minimal | Partial | Partial | Minimal | No | Yes |
| **Auto image dims** | No (biggest complaint) | Yes | Yes | Yes | Yes | Yes |
| **`prefers-reduced-motion`** | Yes | No | No | No | No | No |
| **Framework wrappers** | Community | Official | Official | No | Vue only | No |
| **Plugin architecture** | Limited | Yes | Yes | No | No | No |
| **Maintenance** | Low | Active | Active | Stalled | Slow | Active |

### Interaction Quality Matrix — The Real Gap

No competitor comparison table captures the things that actually matter for how a lightbox *feels*. These are the interaction qualities that separate native apps from web lightboxes:

| Quality | PhotoSwipe | Fancybox | Every other library |
|---|---|---|---|
| **Animations interruptible mid-transition** | No | No | No |
| **Gesture-driven transitions (finger scrubs progress)** | Partial (dismiss) | Partial (dismiss) | No |
| **Crop-aware morph (object-fit: cover)** | No | No | No |
| **Round-trip morph to correct thumbnail** | No | No | No |
| **Adaptive duration based on distance** | No | No | No |
| **Image tilt on drag** | No | No | No |
| **Parallax depth layers on dismiss** | No | No | No |
| **High-frequency pointer tracking** | No | No | No |
| **Physics configurable via CSS custom properties** | No | No | No |
| **Pre-warm images on hover/touchstart** | No | No | No |

Every cell is "No." This is the opportunity.

### What Developers Love (across all libraries)

1. **Zero dependencies** — universally praised
2. **Easy setup** — "just works" is the highest compliment
3. **Good touch gestures** — the #1 reason people choose PhotoSwipe
4. **Small bundle size** — strong preference for <15 KB gzipped
5. **MIT license** — commercial-friendly, no legal headaches

### What Developers Hate

1. **Predefined image dimensions** (PhotoSwipe's #1 complaint since 2015)
2. **Licensing confusion** (Fancybox, lightGallery)
3. **Poor accessibility** (universal across all libraries)
4. **jQuery dependency** (Lightbox2, Magnific Popup)
5. **Solo maintainer risk** (PhotoSwipe, Fancybox, GLightbox)
6. **Complex setup** (PhotoSwipe v4 was notorious)
7. **Stale maintenance** (Magnific Popup, Spotlight, Luminous)

---

## Lightbox3 Positioning

### Two Pillars of Differentiation

**1. Effortless Setup** — The easiest lightbox to implement, period.

The original Lightbox succeeded because it was a script tag and one HTML attribute. Lightbox3 should honor that legacy. Target: working lightbox in under 60 seconds, zero configuration required.

**2. Best-in-Class Touch Physics** — Interactions that feel native.

Not just "swipe works" — real spring physics, momentum, drag-to-dismiss that feels like throwing a card off the screen. The kind of interaction quality that makes people tweet about it. The gap between web and native closes here.

### Strategic Positioning Statement

> Lightbox3 is the modern image lightbox that takes 30 seconds to set up and feels like a native app on mobile. Built on web platform APIs by the creator of the original Lightbox.

---

## Core Architecture Decisions

### 1. Plain `<div>` Overlay with Manual Accessibility (not `<dialog>`)

We considered using the native `<dialog>` element for its built-in a11y (focus trapping, `aria-modal`, `::backdrop`). However, `<dialog>` fights our animation model: calling `close()` immediately sets `display: none` and removes the element from the top layer. There's no clean way to animate out — the drag-to-dismiss physics simulation, the gravity-based fling, the backdrop fade — all need to complete *before* the DOM element disappears. We'd be fighting the browser's lifecycle on every animation path.

Instead, we use a plain `<div>` overlay and implement the a11y features manually (~50-80 lines):

```html
<div class="lightbox3" role="dialog" aria-modal="true" aria-label="Image viewer">
  <!-- lightbox content -->
</div>
```

- **Focus trapping**: intercept Tab/Shift+Tab at boundaries (~30 lines)
- **Inert background**: `document.body.toggleAttribute('inert', isOpen)` — one line, well-supported in all modern browsers
- **Escape to close**: `keydown` listener
- **Focus management**: save trigger element ref on open, restore focus on close
- **Screen reader announcements**: `aria-live` region for slide changes ("Image 2 of 5: Beach sunset")
- **Z-index stacking**: high z-index value (sufficient for 99% of cases)

This gives us **full control over the DOM lifecycle** — animations drive when elements appear and disappear, not the other way around.

### 2. View Transitions API for Open/Close (with Spring Physics)

Morph from thumbnail to full-size image using the browser's GPU-accelerated View Transitions API. The API captures snapshots as pseudo-elements (`::view-transition-old`, `::view-transition-new`) and interpolates position + size via `::view-transition-group`. We have **full control** over the animation curves.

**How we get bounce/spring on the morph:**

The CSS `linear()` easing function (Chrome 113+, Firefox 112+, Safari 17.2+) lets us define arbitrary easing curves as sampled points — including spring physics curves with overshoot:

```css
::view-transition-group(lightbox-image) {
  animation-duration: 0.8s;
  animation-timing-function: linear(
    0, 0.063, 0.234, 0.474, 0.733, 0.96, 1.108, 1.17,
    1.157, 1.094, 1.013, 0.94, 0.892, 0.878, 0.895,
    0.933, 0.977, 1.012, 1.031, 1.032, 1.019, 1
  );
}
```

Values > 1.0 are the overshoot/bounce. We generate these by sampling our spring physics function. For even more control, we can use the Web Animations API on `transition.ready` to apply fully custom keyframes or scrub the transition with gesture input.

**Fallback:** For browsers without View Transitions support, we fall back to CSS animations using the same `linear()` spring curves applied to `transform` + `opacity` on the image element directly.

**Known limitation:** View Transitions captures elements as raster snapshots. If the thumbnail is small, the morph may look blurry until the full-res image loads. We handle this with progressive loading — show the blurred thumbnail snapshot morphing, then swap to full-res once loaded.

### 3. Hybrid Animation Architecture — View Transitions + Custom Physics

Not everything should use View Transitions. The API is ideal for **discrete state changes** (thumbnail → fullsize, open → closed) but wrong for **continuous gesture-driven interactions** (dragging, swiping, pinching). We use a hybrid approach:

| Interaction | Engine | Why |
|---|---|---|
| Thumbnail → fullsize open | View Transitions API + spring `linear()` easing | Discrete state change. GPU-accelerated morph with bounce. |
| Close (non-drag) | View Transitions API + spring easing | Same — discrete transition back to thumbnail. |
| Drag-to-dismiss | Custom physics (`requestAnimationFrame`) | Continuous gesture. Needs frame-by-frame spring + gravity + momentum simulation responding to finger position. |
| Swipe between images | Custom physics (`requestAnimationFrame`) | Continuous gesture. Needs deceleration, spring snap, rubber-banding at gallery edges. |
| Pinch-to-zoom | Custom pointer tracking + spring rubber-band | Continuous gesture. Needs real-time two-finger tracking with rubber-band at min/max zoom. |
| Double-tap zoom | CSS animation with spring `linear()` | Discrete state change (1x → 2x or 2x → 1x). |

**Critical constraint: every transition — View Transition or custom physics — must be interruptible.** If the user grabs the image mid-open-animation, mid-swipe-snap, or mid-spring-back, we cancel the current animation and hand control to the pointer immediately. There is no point where the system is "in an animation." There is only the current position, velocity, and target, updated every frame.

### 4. Spring Physics Engine (Lightweight, Custom)

A tiny spring physics module (~1-2 KB) that serves two purposes:

**A. Runtime simulation** for gesture-driven interactions:
- Drag-to-dismiss: momentum + gravity after release, spring-back if below threshold
- Swipe navigation: deceleration + spring snap to nearest slide
- Pinch-to-zoom: rubber-band effect when exceeding min/max bounds
- Uses `requestAnimationFrame` for 60fps updates

**B. Easing curve generation** for View Transitions and CSS animations:
- Samples the spring function to produce `linear()` CSS easing values
- Configurable stiffness, damping, and mass
- Same physics parameters drive both runtime gestures and pre-computed CSS curves, ensuring consistent feel across all interactions

```ts
// One spring config drives everything
const spring = { stiffness: 200, damping: 20, mass: 1 };

// Runtime: used in rAF loop for drag-to-dismiss
springSimulate(spring, currentPos, targetPos, velocity, dt);

// CSS: generates linear() easing for View Transitions
springToLinearEasing(spring); // → "linear(0, 0.063, 0.234, ...)"
```

This is the core differentiator. Every interaction — whether a View Transition morph or a finger-driven drag — uses the same underlying spring model. The entire library feels physically coherent.

### 5. CSS Custom Properties for Physics and Theming

Physics and visual configuration are exposed as CSS custom properties, not just JS options:

```css
.my-gallery {
  --lb3-spring-stiffness: 200;
  --lb3-spring-damping: 20;
  --lb3-backdrop-opacity: 0.95;
  --lb3-max-zoom: 5;
  --lb3-dismiss-threshold: 0.4;
}

/* Softer, slower feel on mobile */
@media (max-width: 768px) {
  .my-gallery {
    --lb3-spring-stiffness: 150;
    --lb3-spring-damping: 15;
  }
}

/* Respect reduced motion — instant, stiff springs */
@media (prefers-reduced-motion: reduce) {
  .my-gallery {
    --lb3-spring-stiffness: 800;
    --lb3-spring-damping: 80;
  }
}
```

The library reads these via `getComputedStyle` at init. This means:
- Physics can vary per gallery, per breakpoint, per user preference — all in CSS
- Designers can tune the feel without touching JS
- Different galleries on the same page can have different physics
- `prefers-reduced-motion` handling becomes a CSS concern, not a JS branch

No animation library does this. It collapses the gap between "design" and "engineering" configuration.

### 6. Auto-Detect Image Dimensions

Solve PhotoSwipe's biggest pain point. No `data-width` / `data-height` required. The library fetches and caches dimensions automatically. If dimensions are provided via attributes, use them for faster initial render.

### 7. Progressive Enhancement

Works without JavaScript as plain links to images. With JS, enhances into the full lightbox experience.

---

## Target Bundle Size

| Component | Target (gzipped) |
|---|---|
| Core (lightbox + gestures + physics) | **< 8 KB** |
| CSS | **< 3 KB** |
| **Total** | **< 11 KB** |

This would make Lightbox3 smaller than PhotoSwipe (~15 KB), GLightbox (~15 KB), and lightGallery (~13 KB core) while having dramatically better interactions.

---

## Feature Set — MVP (v1.0)

### Must Have

- [x] Single image lightbox (click thumbnail → full-size overlay)
- [x] Gallery mode (prev/next navigation between images)
- [x] Animated open/close (View Transitions API with CSS fallback)
- [x] Thumbnail-to-fullsize morph animation with spring bounce
- [x] Crop-aware morph (detect `object-fit: cover` and morph from visible crop rect)
- [x] Spatial round-trip close (image morphs back to the *correct* thumbnail, even after navigating)
- [x] Scroll-aware close (graceful fade if thumbnail has scrolled off-screen)
- [x] Drag-to-dismiss with physics (momentum, gravity, fall off any edge)
- [x] Image tilt on drag (subtle `rotateZ` based on horizontal velocity)
- [x] Parallax depth layers on dismiss (image, UI, backdrop move at different rates)
- [x] Swipe navigation with momentum
- [x] Pinch-to-zoom and double-tap zoom on mobile
- [x] Pan while zoomed
- [x] Gesture continuity (pinch → pan → pinch without lifting fingers)
- [x] All animations interruptible (grab image mid-transition, mid-snap-back, mid-anything)
- [x] High-frequency pointer tracking (`getCoalescedEvents()` for smoother gestures)
- [x] Adaptive animation duration (scales with travel distance, not fixed)
- [x] Pre-warm images on hover/touchstart (start loading before click)
- [x] Captions (from `alt`, `title`, `data-caption`, or `<figcaption>`)
- [x] Keyboard navigation (arrows, Escape, Tab)
- [x] Good accessibility defaults (ARIA roles, focus return, screen reader announcements, `inert` background)
- [x] `prefers-reduced-motion` support (via CSS custom properties)
- [x] Responsive images (`srcset` / `<picture>` support)
- [x] Auto-detect image dimensions (no manual width/height required)
- [x] CSS custom properties for physics and theming
- [x] Works via CDN script tag with zero config
- [x] Works via npm with ES module imports
- [x] Touch, mouse, and keyboard input
- [x] Loading states (blur-up placeholder while full image loads)
- [x] Counter (1 of N)
- [x] Spring-loaded UI elements (buttons use spring animations on hover/press)

### Nice to Have (v1.x)

- [ ] Gallery thumbnail strip
- [ ] Fullscreen API support
- [ ] Download button
- [ ] Deep linking / hash navigation
- [ ] Social sharing
- [ ] Slideshow / autoplay mode
- [ ] Dominant color backdrop extraction (tint backdrop with image's primary color)
- [ ] Gesture-driven open (drag up on thumbnail to scrub the open transition)

### Explicitly Deferred (v2+)

- [ ] Video support (YouTube, Vimeo, HTML5)
- [ ] Iframe / inline HTML content
- [ ] Plugin architecture
- [ ] Framework-specific wrappers (React, Vue, Svelte)

---

## API Design — Ease of Implementation

### Level 0: Script Tag + HTML Attributes (Zero JS)

```html
<script src="https://cdn.jsdelivr.net/npm/lightbox3/dist/lightbox3.min.js" type="module"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lightbox3/dist/lightbox3.css">

<!-- That's it. Any link to an image with data-lightbox just works. -->
<a href="photo-full.jpg" data-lightbox>
  <img src="photo-thumb.jpg" alt="A sunset over the ocean">
</a>

<!-- Gallery: group images with a shared name -->
<a href="photo1.jpg" data-lightbox="vacation">
  <img src="photo1-thumb.jpg" alt="Beach">
</a>
<a href="photo2.jpg" data-lightbox="vacation">
  <img src="photo2-thumb.jpg" alt="Mountains">
</a>
```

This is the pitch. Two includes, one attribute, done. The script auto-initializes on DOMContentLoaded, discovers all `[data-lightbox]` elements, and wires everything up.

### Level 1: npm + Minimal JS

```js
import 'lightbox3/style.css';
import { Lightbox } from 'lightbox3';

// Auto-discover all [data-lightbox] elements
Lightbox.init();
```

### Level 2: Programmatic / Custom Configuration

```js
import { Lightbox } from 'lightbox3';

const lb = new Lightbox({
  selector: '.gallery a',
  captions: true,
  physics: {
    stiffness: 200,
    damping: 20,
    mass: 1,
  },
  zoom: {
    max: 4,
    doubleTapScale: 2,
  },
  on: {
    open: (instance) => { /* ... */ },
    close: (instance) => { /* ... */ },
    slide: (instance, index) => { /* ... */ },
  }
});
```

### Level 3: Full Control

```js
import { Lightbox } from 'lightbox3';

const lb = new Lightbox({
  items: [
    { src: 'photo1.jpg', thumb: 'photo1-sm.jpg', alt: 'Beach', caption: 'Malibu, 2025' },
    { src: 'photo2.jpg', thumb: 'photo2-sm.jpg', alt: 'Mountains', caption: 'Yosemite' },
  ],
  target: document.getElementById('lightbox-root'),
});

// Programmatic control
lb.open(0);      // Open to first image
lb.next();       // Go to next
lb.prev();       // Go to previous
lb.close();      // Close
lb.destroy();    // Clean up
```

---

## Quality Standards

These are the non-negotiable quality bars. Every interaction and animation must meet these standards. If something doesn't feel right, it ships when it does — not before.

### Interaction Quality

| Principle | What It Means |
|---|---|
| **Drag with resistance** | Every drag has spring-based resistance at boundaries. Never a hard stop. Images, carousel edges, zoom limits — all rubber-band. |
| **Inertial swipe** | Velocity carries through after release. Swipe speed directly determines animation speed and whether a transition commits. Not a binary threshold — a velocity-weighted `swipePower = abs(offset) * velocity`. |
| **Rubber-band overscroll** | When you hit an edge (first/last image, min/max zoom), the system gives — then pulls back. iOS formula: `(1 - 1/(d * factor / dim + 1)) * dim`. This is what makes boundaries feel soft instead of dead. |
| **Pinch-to-zoom** | Two-finger zoom centered on the pinch midpoint, not the image center. Continuous, not stepped. Rubber-band past min/max with spring-back. |
| **Double-tap zoom** | Tap point becomes zoom center. Zooms to 2x (or back to 1x if already zoomed). Spring-animated, not instant. |
| **Smooth settle-back** | Every overshoot settles with a spring — drag release, zoom bounce-back, carousel snap. Never linear, never `ease-out`. Actual damped harmonic oscillator. |
| **Velocity-aware transitions** | Open/close animation duration adapts to gesture velocity and travel distance. A fast flick dismisses quickly. A slow drag gets a slower spring-back. The system reads the user's energy and matches it. |

### Animation Quality

| Principle | What It Means |
|---|---|
| **Spring-based transitions everywhere** | No generic `ease-in-out` or `ease-out`. Every animated property uses the spring engine — same `stiffness`/`damping`/`mass` configuration driving both gesture physics and CSS transitions. The entire UI feels physically coherent. |
| **Shared-element open/close** | Thumbnail morphs into lightbox image (position, size, border-radius). Close morphs back to the correct thumbnail. The image has spatial identity — it came from somewhere and goes back there. Inspired by iOS App Store card expand and motion.dev's `layoutId` pattern. |
| **Subtle squash/stretch under stress** | During drag-to-dismiss, the image slightly scales down as it moves away from center (like Fancybox's compact mode: interpolate from current scale to ~77% over 33% of viewport drag). On fling, the image tilts in the drag direction. On spring-back overshoot, the image very slightly compresses then expands. These are 1-2% effects — felt more than seen. |
| **Motion adapts to gesture velocity** | The spring's initial velocity comes directly from the gesture's release velocity. A fast fling produces a fast, energetic spring. A gentle release produces a slow, soft settle. The physics engine doesn't have a fixed animation duration — it runs until the spring settles, and that duration is emergent from the initial conditions. |
| **Reduced-motion support** | `prefers-reduced-motion: reduce` → all springs become extremely stiff (effectively instant). No morphs, no bounces, no slides. Images appear/disappear in place. Users who need this get full functionality with zero motion. Controlled via CSS custom properties so it's a one-line media query override. |

### Fancybox Compact Mode Patterns Worth Adopting

Studied Fancybox's compact mode plugin. Key patterns to incorporate:

- **Tap to toggle chrome**: single tap shows/hides all UI (toolbar, arrows, captions) with a fade. Immersive viewing mode. Backdrop tap does NOT close — it toggles chrome. This prevents accidental dismissal on mobile.
- **Image scales down during drag-to-dismiss**: as you drag vertically, the image interpolates from current scale toward ~77%. Combined with backdrop fade, creates a sense of "pulling away."
- **Velocity + distance dismiss threshold**: `|velocityY| > threshold OR |distance| > 50px` triggers dismiss. Fast flick = instant. Slow pull past threshold = also works.
- **Footer-based captions on mobile**: captions move to a semi-transparent footer bar at the bottom, matching native photo app layout.

---

## The Interaction Model — What Makes It Feel Native

The gap between web lightboxes and iOS Photos isn't about features. It's about how the photo behaves as a *physical object in space*. These ten interaction qualities are what close that gap. They're not optional polish — they're the core of why someone would choose Lightbox3.

### 1. Every Animation Is Interruptible

On iOS, you can start opening a photo, change your mind mid-animation, and flick it away. You can start dragging to dismiss, hesitate, and reverse. You can be mid-swipe to the next image and pinch to zoom. Nothing ever locks you into watching an animation complete.

Web lightboxes treat animations as atomic — once `open()` fires, you wait 300-400ms before you can interact. This is the single biggest thing that makes web feel like web.

**Implementation:** There is no "animating" state. Every frame, the system has a current position, velocity, and target. Pointer input always takes priority. When a View Transition is running and the user touches down, we call `transition.skipTransition()`, read the current interpolated position from the pseudo-element's computed style, and hand off to the physics engine at that exact position and zero velocity. The spring simulation picks up seamlessly.

### 2. Gesture-Driven Transitions

On iOS, dragging a photo down to dismiss doesn't *trigger* a dismiss animation. Your finger *is* the animation. The backdrop opacity tracks drag distance in real-time. You're scrubbing the transition continuously. Release past the threshold → physics takes over. Release before → springs back.

**Implementation:** For drag-to-dismiss and swipe, pointer position directly drives all visual state every frame — image position, backdrop opacity, UI element positions. No animation is "playing." When the pointer releases, the current velocity becomes the initial velocity of the physics simulation. The transition from gesture to physics is seamless because there's no transition — it's the same system, just switching from "position set by pointer" to "position set by spring solver."

### 3. Crop-Aware Morphing

~90% of thumbnails use `object-fit: cover` — they're cropped. Every existing lightbox ignores this. The open animation morphs from the full image rectangle, causing a visible jump where the crop changes.

**Implementation:** On open, read the thumbnail's `object-fit`, `object-position`, `naturalWidth`, `naturalHeight`, and bounding rect. Compute the visible crop region. The View Transition morph starts from that exact crop rect — the image unfolds from its cropped state, revealing hidden edges during the transition. This requires injecting a temporary element matching the crop geometry as the `::view-transition-old` source.

### 4. Spatial Round-Trip Close

When you open photo 1, swipe to photo 5, then close — the image should fly back to *photo 5's thumbnail*, not photo 1's. This requires maintaining a mapping between gallery items and their source DOM elements, updating the "return target" as the user navigates.

**Edge case — scroll-aware closing:** If the return target thumbnail has scrolled off-screen, don't try to morph back to an invisible element (it would fly to a position the user can't see). Fall back to a graceful fade + scale-down instead. Check `getBoundingClientRect()` against the viewport before choosing the close animation path.

### 5. Pre-Warm Images on Hover and Touchstart

When a user hovers over a thumbnail (desktop) or touches it (the ~100ms before the click registers), start loading the full-res image immediately. By the time the click/tap fires, the image may already be loaded.

**Implementation:** `pointerenter` (desktop) and `touchstart` (mobile) create an `Image()` object and set its `src`. The loaded image is cached. When the lightbox opens, it checks the cache first. Combined with the blur-up placeholder (thumbnail scaled up → sharp full-res swap), there's never a blank loading state.

### 6. Adaptive Animation Duration

iOS adjusts animation duration based on travel distance. A morph from a thumbnail near center is quick (~250ms). A morph from the far corner takes longer (~450ms). The speed is roughly constant; the duration adapts.

Web lightboxes use fixed durations. Short-distance animations feel sluggish. Long-distance animations feel rushed.

**Implementation:** Calculate the Euclidean distance between the thumbnail center and the viewport center. Map this to a duration range (e.g., 250ms–500ms). Use the same spring parameters but scale the `animation-duration` on the `::view-transition-group`. The result: every morph feels like it moves at the same natural speed.

### 7. Image Tilt on Drag

When you pick up a physical object and move it, it tilts. During drag-to-dismiss, apply a subtle `rotateZ` (2-4 degrees) based on the horizontal velocity of the drag. Moving right → slight clockwise tilt. Moving left → counterclockwise. When flung off-screen, the tilt increases slightly with the trajectory.

**Implementation:** ~10 lines on top of the drag handler. `rotateZ = clamp(horizontalVelocity * tiltFactor, -maxTilt, maxTilt)`. Applied via the same `transform` that handles translation. The tilt decays with a spring when the image returns to center.

### 8. Parallax Depth Layers on Dismiss

When dragging to dismiss, different layers move at different rates:
- **Image**: follows finger 1:1 (depth 1.0)
- **UI controls** (close button, caption, counter): drift faster and fade sooner (depth 1.3)
- **Backdrop**: opacity tracks drag distance but on a different curve (depth 0.8)

This layered motion creates a sense of depth. Most lightboxes move everything in lockstep, which feels flat.

**Implementation:** Each layer has a `depthMultiplier`. During drag, each layer's position/opacity is `dragProgress * depthMultiplier`. Controls disappear before the image does, which also provides a cleaner visual during the fling animation.

### 9. Gesture Continuity

On iOS, you can start pinching to zoom, then without lifting fingers, transition to panning, then back to pinching. Most web lightboxes have discrete gesture states — switching requires lifting fingers.

**Implementation:** Track all active pointers continuously. Don't classify gestures upfront. Instead, every frame: count active pointers. One pointer → compute translation delta. Two pointers → compute translation delta AND scale delta AND rotation delta. If a second finger arrives mid-pan, start incorporating scale from that frame (initial scale = current scale). If a finger lifts mid-pinch, continue panning with the remaining finger. No state machine resets. No dropped input.

### 10. High-Frequency Pointer Tracking

`PointerEvent.getCoalescedEvents()` gives access to all intermediate pointer positions between animation frames. On a 120Hz display where JS runs at 60fps, there are pointer positions between frames that most libraries never see.

**Implementation:** Use coalesced events for velocity calculation — average over all intermediate points for a smoother, more accurate velocity vector. This directly improves the quality of fling physics (more accurate release velocity = more natural trajectories). On the rendering side, use the latest coalesced position for minimal input-to-display latency.

---

## The Touch Physics System — The Secret Weapon

This is what will make people choose Lightbox3. The goal is interactions that feel as good as iOS Photos or Google Photos.

### Drag-to-Dismiss

When dragging an image:
- Image follows the finger with zero lag (use `requestAnimationFrame`, avoid layout thrashing)
- Image tilts subtly in the direction of movement (rotateZ based on horizontal velocity)
- **Image scales down** as you drag: interpolate from current scale toward ~77% as drag reaches 33% of viewport height. Creates a "pulling away" feeling (inspired by Fancybox compact mode)
- Backdrop opacity decreases proportionally to drag distance (at depth 0.8)
- UI controls drift away faster and fade out sooner (at depth 1.3)
- On release: if velocity exceeds threshold OR distance exceeds threshold, image flies off in the direction of the gesture with momentum + gravity + increasing tilt
- If below threshold, image springs back to center with a soft bounce — scale returns to 1, tilt returns to zero, UI fades back in
- The image can be flung off any edge — top, bottom, left, right, or diagonal
- Gravity pulls it downward as it flies off (like throwing a card)
- The spring-back is interruptible — grab it mid-bounce and keep dragging

### Carousel — Swipe Between Images

**This is not a simple image swap.** The lightbox renders a real carousel with multiple image elements in the DOM simultaneously. As you drag horizontally, you see the current image sliding out and the next image sliding in — exactly like iOS Photos or the motion.dev carousel example.

**DOM architecture:**
- A carousel track element contains 3 slides at any time: previous, current, and next
- Slides are positioned via `transform: translate3d(offsetX, 0, 0)` on the track — GPU-composited, no layout thrashing
- Each slide contains its own `<img>` (pre-loaded). When navigation settles, slides outside the window are recycled (removed/re-added with new images)
- A gap between slides (e.g., 20px) provides visual separation during the swipe

**Swipe physics:**
- Drag with resistance: pointer position directly drives track offset in real-time
- Inertial swipe: on release, velocity determines whether to advance. `swipePower = Math.abs(offset) * velocity` — a fast flick with small distance OR a slow drag past 30% viewport width both trigger advancement (velocity-weighted threshold, matching iOS)
- Rubber-band overscroll at gallery edges: iOS-style `(1 - 1/(d * 0.55 / dim + 1)) * dim` — heavy resistance that increases as you pull further
- Spring snap: on release, spring-animate to the nearest slide position using release velocity as initial velocity. The spring overshoots slightly and settles — not a generic ease-out
- Interruptible: grab mid-snap to redirect. The spring cancels and dragging resumes at the current position with current velocity

**Edge behavior:**
- At first image: swipe right shows rubber-band resistance, then springs back
- At last image: swipe left shows rubber-band resistance, then springs back
- The rubber-band overscroll gives clear tactile feedback that you've reached the boundary

**What the user sees:**
1. Finger down → track follows finger 1:1
2. Dragging left → current image slides left, next image peeks in from the right with a gap
3. Release with enough velocity → both images spring-slide into place (next becomes current)
4. Release without enough velocity → both images spring back to original positions

### Pinch-to-Zoom

- Two-finger zoom centered on the pinch midpoint
- Smooth, continuous scaling (not stepped)
- Rubber-band effect when exceeding min/max zoom
- Double-tap: smart zoom to 2x centered on tap point, or reset to 1x
- Pan constrained to image bounds when zoomed in
- Seamless transition between pinch and pan without lifting fingers

### The Open Animation (View Transitions + Spring)

- Thumbnail's crop geometry is captured (accounting for `object-fit: cover`)
- `document.startViewTransition()` captures the thumbnail snapshot, then we update the DOM to show the lightbox
- Browser creates `::view-transition-group(lightbox-image)` and interpolates position + size from crop rect to center
- We override the easing on the group with a spring `linear()` curve — the morph overshoots slightly, then settles with a bounce
- Animation duration is adaptive — scaled to the distance between thumbnail and viewport center
- Backdrop fades in simultaneously via `::view-transition-new(root)`
- The old snapshot (thumbnail crop) crossfades to the new snapshot (full-size image) during the morph
- If full-res image isn't loaded yet (despite pre-warming), the morph shows a scaled-up blurry thumbnail → sharp image swap on load
- **Interruptible**: if the user touches down during the open animation, we call `transition.skipTransition()` and hand off to the physics engine at the current interpolated position
- **Fallback** (no View Transitions support): CSS animation on the image element using the same `linear()` spring easing, animating `transform` from thumbnail rect to center

```css
/* The spring bounce on the morph — generated from our physics engine */
::view-transition-group(lightbox-image) {
  animation-duration: 0.7s;
  animation-timing-function: linear(
    0, 0.063, 0.234, 0.474, 0.733, 0.96, 1.108, 1.17,
    1.157, 1.094, 1.013, 0.94, 0.892, 0.878, 0.895,
    0.933, 0.977, 1.012, 1.031, 1.032, 1.019, 1
  );
}
```

### The Close Animation (Spatial Round-Trip)

- Determine the return target: the thumbnail DOM element corresponding to the *current* gallery image (not necessarily the one that was originally opened)
- Check if the return target is visible in the viewport (`getBoundingClientRect()`)
- **If visible**: View Transition morph from fullsize back to the thumbnail's crop rect, with spring easing and adaptive duration
- **If off-screen**: graceful fade + scale-down to nothing (don't fly to an invisible position)
- **If drag-to-dismiss**: physics engine handles the fling trajectory, then we remove the overlay once the image is off-screen

---

## Accessibility — Good Defaults, Won't Compromise Interactions

Accessibility is important, but it's not a pillar of differentiation for Lightbox3. Where a11y features are free or low-cost, we include them. Where they conflict with animation quality, gesture fluidity, or ease of implementation, **interactions win**.

**What we include (low/no cost):**
- `role="dialog"` + `aria-modal="true"` on the overlay
- `inert` on background content when open
- Escape to close
- Arrow keys for gallery navigation
- Focus moved into lightbox on open, returned to trigger on close
- Image `alt` text exposed to screen readers
- `aria-live` region for slide change announcements
- `prefers-reduced-motion`: all animations instantly complete, no motion
- Controls are real `<button>` elements with `aria-label`

**What we skip if it gets in the way:**
- Strict focus trapping if it complicates gesture handling or DOM structure
- WCAG 2.1 AA full compliance as a hard requirement — we aim for it but won't let it block shipping or degrade the interaction quality
- Touch target minimums that conflict with our visual design (we'll be generous but not dogmatic)

---

## Technical Implementation Plan

### Build System

- **Language**: TypeScript
- **Bundler**: Rollup (produces clean ESM + UMD bundles)
- **CSS**: Vanilla CSS with custom properties (no preprocessor needed)
- **Testing**: Vitest (unit) + Playwright (e2e, especially for touch gestures and accessibility)
- **Linting**: ESLint + Prettier
- **Package**: npm, with CDN availability via jsDelivr/unpkg

### Module Structure

```
src/
├── index.ts              # Public API, auto-init logic
├── lightbox.ts           # Core Lightbox class, lifecycle orchestration
├── gallery.ts            # Gallery navigation, thumbnail-to-item mapping
├── carousel.ts           # Carousel DOM: track + slides, translate3d positioning, slide recycling
├── overlay.ts            # Overlay div, backdrop, z-index, inert management
├── gestures/
│   ├── pointer.ts        # Unified pointer tracking + coalesced events + velocity
│   ├── drag.ts           # Drag-to-dismiss (with tilt + parallax layers + scale-down)
│   ├── swipe.ts          # Carousel swipe (drives track offset, spring snap, rubber-band)
│   ├── pinch.ts          # Pinch-to-zoom (with gesture continuity)
│   └── tap.ts            # Single-tap (toggle chrome), double-tap (zoom)
├── physics/
│   ├── spring.ts         # Spring simulation (runtime rAF + linear() easing generation)
│   ├── momentum.ts       # Velocity tracking + deceleration
│   └── gravity.ts        # Gravity for drag-to-dismiss flight
├── transitions/
│   ├── view-transition.ts # View Transitions API wrapper + CSS animation fallback
│   ├── morph.ts          # Crop-aware morph (rect capture, object-fit detection, round-trip)
│   └── easing.ts         # Spring → linear() CSS easing curve generator
├── image.ts              # Image loading, pre-warming, dimension detection, srcset, blur-up
├── caption.ts            # Caption extraction and rendering
├── a11y.ts               # Screen reader announcements, focus management
├── config.ts             # Default options, CSS custom property reading, merging
├── utils.ts              # Shared utilities
└── style.css             # All styles + CSS custom property defaults
```

### Development Phases

**Phase 1 — Foundation (Weeks 1-2)**
- Project scaffolding (TypeScript, Rollup, Vitest, Playwright)
- Overlay management (div + backdrop + `inert` on background)
- Image loading with auto-dimension detection and pre-warming
- Basic open/close (no animations yet)
- Keyboard navigation (Escape, arrows)
- Basic a11y (`role="dialog"`, `aria-modal`, focus management)
- CSS custom property reading infrastructure

**Phase 2 — Physics Engine + Pointer System (Weeks 3-4)**
- Spring physics engine (runtime simulation + `linear()` easing generation)
- Momentum tracking and gravity
- Unified pointer event system with coalesced events
- Velocity calculation from high-frequency pointer data
- Interruptibility architecture (no "animating" state — always position + velocity + target)

**Phase 3 — Touch Gestures (Weeks 4-6)**
- Drag-to-dismiss with momentum, gravity, and tilt
- Parallax depth layers during dismiss (image, UI, backdrop at different rates)
- Pinch-to-zoom with rubber-banding
- Gesture continuity (pinch ↔ pan without lifting fingers)
- Double-tap zoom
- Pan while zoomed
- Spring-loaded UI elements (buttons)
- All gestures interruptible

**Phase 4 — Gallery + Transitions (Weeks 6-8)**
- Gallery mode (multiple images, prev/next)
- Swipe navigation with spring snapping (interruptible)
- Thumbnail-to-item mapping for spatial round-trip
- Crop-aware morph (detect `object-fit`, compute visible rect)
- View Transitions API for open/close morph with spring easing
- Adaptive animation duration (scaled to travel distance)
- Scroll-aware close (fade fallback when thumbnail is off-screen)
- CSS fallback animations for browsers without View Transitions
- Captions, counter (1 of N), loading states (blur-up)

**Phase 5 — Polish & Ship (Weeks 8-10)**
- `prefers-reduced-motion` support via CSS custom properties
- Auto-init from `<script>` tag (zero-config mode)
- CDN build (UMD bundle with styles injected)
- srcset / responsive image support
- Cross-browser testing (Chrome, Safari, Firefox, Samsung Internet)
- Touch device testing (iOS Safari, Android Chrome, high-refresh-rate devices)
- Performance profiling (60fps gestures, no jank, no layout thrashing)
- Documentation site
- npm publish

---

## Success Metrics

1. **Setup time**: New user → working lightbox in < 60 seconds
2. **Bundle size**: < 11 KB gzipped total (JS + CSS)
3. **Gesture FPS**: 60fps during drag, swipe, and pinch on mid-range mobile
4. **Accessibility**: Pass axe-core audit with zero critical violations
5. **Lighthouse**: Zero impact on page performance scores
6. **The feel test**: Hand someone an iPhone, open the demo, and ask "is this a native app or a website?"
7. **Community**: Target 1,000 GitHub stars in first 3 months (leveraging existing Lightbox brand)

---

## Marketing Angle

Lokesh's name carries weight. The pitch writes itself:

> **From the creator of Lightbox — the library that started it all.**
>
> Lightbox3 is a ground-up rewrite for the modern web. Two lines of HTML to get started. Physics-based touch interactions that feel native. Powered by View Transitions and spring physics. Under 11KB.
>
> No jQuery. No config. No compromises on mobile.

The demo page should be the primary marketing tool — let people feel the interactions on their phone immediately. The interactions sell themselves; the marketing just needs to get the phone into someone's hand.
