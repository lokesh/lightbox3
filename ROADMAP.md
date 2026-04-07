
### 2. Smarter preloading

The current hover preload (80ms delay, mouse-only) is a good start but leaves gaps, especially on mobile where there is no hover.

- **Touch preload on `pointerdown`**: Start fetching on touch start — the ~100-300ms before the click event fires is free loading time
- **`img.decode()` in the preload pipeline**: Decode full-res images off the main thread before displaying to prevent decode jank during transitions
- **Gallery adjacency preload**: Once the lightbox is open, preload next/prev images. Prioritize the direction of the user's last swipe
- **`srcset` support**: Copy the thumbnail's `srcset` to the lightbox image with `sizes="100vw"` so the browser picks the right resolution for the viewport and DPR
- **Cache-aware checks**: Skip preloading for images already in the browser cache (`img.complete && img.naturalWidth > 0`)

### 3. Dimension hints via data attributes

When the full-res image hasn't loaded yet, the opening animation can't calculate the correct target rect. Allow users to provide dimensions upfront.

```html
<a href="photo.jpg" data-lightbox data-width="4000" data-height="3000">
```

- Use provided dimensions to compute the FLIP target rect immediately
- Fall back to thumbnail `naturalWidth`/`naturalHeight` (current behavior)
- Spring-animate rect changes if the actual image has different dimensions than the hint

### 8. Loading indicator

Show a subtle spinner or progress indicator when the full-res image is taking too long to load.

- Delayed appearance (e.g. 1.5-2s) — don't show for fast loads
- Minimal, non-intrusive design (thin progress ring or bar)
- Disappears immediately when image is ready

### 9. Responsive full-res source

Let users specify a separate full-resolution image for the lightbox, independent of the thumbnail.

```html
<img src="thumb-400.jpg"
     data-lightbox
     data-lightbox-src="full-2400.jpg"
     data-lightbox-srcset="full-1200.jpg 1200w, full-2400.jpg 2400w">
```

- `data-lightbox-src`: explicit full-res URL (already works via `href` on links)
- `data-lightbox-srcset`: responsive sources for the lightbox, with browser DPR selection
- Without these, use `href` (for links) or `src` (for images) as today

### 10. Deep linking / URL hash

Allow direct linking to an open lightbox state.

- Update URL hash when lightbox opens (e.g. `#lightbox=gallery-1&slide=3`)
- On page load, if hash matches, auto-open the lightbox to that slide
- Browser back button closes the lightbox (push state on open)
- Important for sharing and SEO

---

## Unconventional / standout ideas

These are differentiators that would make Lightbox3 memorable and distinct from alternatives. Not all should be built — pick the ones that align with the library's identity.

### 1. Gyroscope tilt-to-pan

When an image is zoomed in, use the device's gyroscope to pan by tilting the phone. Feels magical — like looking through a window.

- Map `DeviceOrientationEvent` beta/gamma deltas to pan velocity
- Feed into the existing spring engine (same system as momentum panning)
- iOS 13+ requires `DeviceOrientationEvent.requestPermission()` (user gesture required)
- Must be opt-in — enable via `data-lightbox-gyro` or a config option
- Mouse-position fallback on desktop (subtle parallax shift)
- ~50-80 lines of implementation
- Concern: battery drain from continuous sensor polling; offer a toggle affordance

### 2. Auto-zoom for wide images on portrait screens

When a landscape image opens on a phone held in portrait, it appears tiny. Instead of showing it letterboxed, automatically zoom in to fill the viewport width and let the user pan vertically.

- Detect when image aspect ratio >> viewport aspect ratio (e.g. panoramas)
- On open, zoom to fill viewport width instead of fitting
- Start panned to the left edge (or to the detected focus point)
- User can zoom out to see the full image or pan horizontally
- Threshold: maybe when image would be < 40% of viewport height if fit normally
- This is a judgement call — could be a per-image opt-in via `data-lightbox-fill`

### 3. Scroll-to-dismiss (Medium-style)

Instead of only closing on backdrop click or ESC, close the lightbox when the user scrolls past a threshold. This treats the lightbox as a content zoom rather than a modal — you're never "trapped."

- Track scroll delta while lightbox is open
- At threshold (e.g. 40px scroll), trigger close animation
- Pairs naturally with swipe-to-dismiss (vertical drag = immediate, scroll = ambient)
- Works on both touch and mouse wheel
- Great for inline/editorial content where the lightbox shouldn't interrupt reading flow
- Could be default for non-gallery single-image lightboxes

### 4. Focus-point aware animations

Instead of always expanding from center, use a declared focus point as the `transform-origin` for the opening morph. The animation "grows" from the subject.

```html
<img data-lightbox data-focus-x="0.7" data-focus-y="0.3">
```

- Normalized coordinates (0-1), same format used by Cloudinary/Imgix/WordPress
- Used as transform-origin during FLIP morph
- Also used for smart `object-fit: cover` cropping on the thumbnail
- Also used for auto-zoom target (idea #2) — zoom to the subject, not the center
- ~15-20 lines of implementation, high visual impact
- Can be generated by AI saliency detection at build time

### 5. Haptic snap points

Trigger subtle haptic feedback at meaningful interaction boundaries.

- Vibrate on: zoom hitting 1x (fit), zoom hitting max, pan hitting edge bounds (rubber band start), slide snap in gallery
- Use the [web-haptics](https://github.com/lochie/web-haptics) library or raw `navigator.vibrate()`
- **Limitation**: iOS Safari doesn't support the Vibration API at all — this is Android-only for now
- Offer as a callback hook: `onSnapPoint(type: 'zoom' | 'pan-edge' | 'slide-snap')` so users can wire in their own haptics or sound effects
- The proposed Web Haptics API (in W3C incubation) would make this much more viable if it ships with iOS support

### 6. Spring-physics thumbnail gallery

Instead of a static thumbnail strip, build a horizontally scrollable thumbnail bar with spring-physics momentum — the same feel as the main lightbox interactions.

- Flick to scroll through thumbnails with momentum and snap-to-item
- Same spring presets (`PAN_SPRING`, `SNAP_SPRING`) as the main viewer
- Rubber-band overscroll at edges
- Active thumbnail has a subtle scale/highlight animation
- This makes the gallery navigation feel like part of the same physics system, not a bolted-on UI element
- Could be used independently of the lightbox (standalone carousel component)

### 7. Inline expansion mode

Instead of overlaying the viewport, expand the clicked image in-place within the document flow, pushing surrounding content down. Like Google Image Search's inline detail panel.

- FLIP morph from thumbnail to expanded size within the same container
- Surrounding content animates down with springs
- No backdrop, no overlay, no modal
- Better for editorial/blog content where full-screen takeover feels heavy
- Activate via `data-lightbox-inline` or a config option
- Same spring engine and zoom/pan mechanics, different layout target

### 8. Velocity-matched close animation

When the user flicks the image to dismiss (swipe-to-dismiss), match the close animation to the fling direction and speed rather than always animating back to the thumbnail.

- If flung downward fast: image flies off the bottom, backdrop fades
- If flung upward: flies off the top
- If slow drag past threshold: gentle return-to-thumbnail morph
- The release velocity feeds directly into the spring's initial velocity (the architecture already supports this)
- Compare: iOS Photos does this; most web lightboxes always animate back to the thumbnail regardless of gesture direction
- Makes dismissal feel responsive to intent rather than mechanical

### 9. View Transitions API integration (future)

The browser's View Transitions API can eventually replace the manual FLIP measurement phase while keeping springs for animation curves.

- Same-document view transitions are now Baseline (Chrome 111+, Firefox 144+, Safari 18+)
- `match-element` auto-naming (Chrome 137) eliminates manual naming
- Scoped view transitions (Chrome 140) enable subtree transitions
- **Not ready yet**: The API uses CSS transitions/WAAPI internally, conflicting with the spring-only architecture. Interruptibility (grabbing a transition mid-flight) is unclear
- **Strategy**: Monitor for interruptibility support. When available, use View Transitions for the snapshot/measurement phase, springs for the curve. This would simplify the FLIP code significantly

### 10. Ambient background color

Extract the dominant color (or a blurred version) of the current image and use it to tint the backdrop, creating a glow effect behind the image.

- Use a tiny `<canvas>` to sample the image's average color
- Apply as the backdrop `background-color` with low opacity
- Transition the color when navigating between gallery slides
- Subtle but premium — differentiates from the typical black/dark backdrop
- Apple Music and Spotify use this pattern for album art
- Implementation: downsample image to 1x1 pixel on canvas, read pixel, apply with spring-animated opacity
- ~20 lines, zero dependencies

---

## Proposed phases

### Phase 1 — Solid single-image experience
- Swipe-to-dismiss (#E4)
- Smarter preloading (#E2) — touch preload, `img.decode()`, cache checks
- Dimension hints (#E3)
- Placeholder/blur-up support (#E5)
- Loading indicator (#E8)
- Focus-point aware animations (#U4)
- Accessibility foundations (#E6)

### Phase 2 — Gallery
- Gallery support with swipe navigation (#E1)
- Responsive full-res source / srcset (#E9)
- Captions (#E7)
- Spring-physics thumbnail strip (#U6)
- Ambient background color (#U10)

### Phase 3 — Delight
- Deep linking / URL hash (#E10)
- Scroll-to-dismiss (#U3)
- Velocity-matched close animation (#U8)
- Auto-zoom for wide images (#U2)
- Gyroscope tilt-to-pan (#U1)
- Haptic snap points (#U5)

### Phase 4 — Alternate modes
- Inline expansion mode (#U7)
- View Transitions API integration (#U9, when browser support matures)

---

## Research sources

Libraries studied: PhotoSwipe v5/v6, GLightbox, Fancybox v5, medium-zoom, YARL, Lightbox.js, vue-easy-lightbox, FsLightbox.

Products studied: Apple Photos (iCloud), Google Photos, Instagram, Twitter/X, Threads, Medium, Vercel image gallery, Framer Motion, Netflix hover UI, Pinterest, Figma, OpenSeadragon.

Technologies evaluated: View Transitions API, Scroll-Driven Animations, ThumbHash/BlurHash, Network Information API, Fetch Priority API, DeviceOrientationEvent, Vibration API / Web Haptics API, `img.decode()`, Speculation Rules API, CSS `aspect-ratio`.
