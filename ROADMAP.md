# Lightbox3 Roadmap

Direction: keep the two things that make Lightbox3 distinct — **dead-simple drop-in setup** and **best-in-class mobile physics** — and fill the gaps around them before chasing scope. Video / non-image content is deliberately parked (see [Parked](#parked)); the near-term focus is small correctness gaps and open GitHub issues.

---

## Shipped

Baseline single-image and gallery experiences are done and won't be re-listed as work:

- Open/close FLIP morph, zoom, pan with momentum, snap-back
- Gallery support with swipe navigation, strip slide, rubber-band edges
- Swipe-to-dismiss (vertical drag, velocity commit/snap-back)
- Scroll-to-dismiss + wheel navigation (Medium-style)
- Captions (`data-caption`, `data-title`, `data-alt`)
- Loading indicator (delayed spinner)
- Gallery adjacency preload (immediate neighbors + travel direction)
- Cache-aware preload checks (`img.complete && naturalWidth > 0`)
- Accessibility foundations: focus trap, `aria-modal`, `aria-label`s, restore-focus-on-close, `prefers-reduced-motion` honored throughout
- Pinch-to-zoom, hover preload, configurable padding/radius via CSS custom properties

---

## Near-term: gaps & GitHub issues

Small, high-return work. Do these before opening any large new surface.

### N1. ctrl / shift / meta-click passthrough — [issue #5]

Modifier-clicks should fall through to the browser (open in new tab/window) instead of being hijacked into the lightbox. Well-scoped, contributor-blessed, ~30-min fix.

- On the thumbnail click handler, bail early if `e.ctrlKey || e.metaKey || e.shiftKey` (or `e.button !== 0`)
- Let the native anchor behavior proceed

### N2. Option parsing / esm.sh init — [issue #10]

User reports options (`padding`, `debug`) ignored when importing via esm.sh. Verify the option-parsing path and document the correct init pattern.

- Reproduce with an esm.sh import; confirm whether it's a real parsing bug or a usage/docs gap
- Fix parsing if broken; either way document the module-import + options pattern in the README
- Related: PR #6 (demo option logging) touches the same surface — review and merge/close

### N3. Touch preload on `pointerdown`

Hover preload is mouse-only; mobile gets nothing. Start fetching on `pointerdown` — the ~100–300ms before `click` fires is free loading time.

- Fire the existing preload path from `pointerdown` / touch start on the thumbnail
- Reuse `preloadCache`; no double-fetch if already cached

### N4. `img.decode()` in the preload pipeline

Decode full-res images off the main thread before display to prevent decode jank during the open/navigate transitions.

- Await `img.decode()` after load, before the morph swaps in the full-res source
- Fall back gracefully where `decode()` is unsupported or rejects

### N5. Project hygiene

Not features, but they gate everything else and signal a maintained project.

- **CI**: add `.github/workflows` running lint + build (test/e2e scripts already exist). Unblocks safe Dependabot merges
- **Dev-dep audit**: `npm audit fix` + merge Dependabot PRs (#7/#12/#13/#14). Dev-only, not user-facing, but clears the noise
- **GitHub Releases**: cut releases with notes (npm & tags are already in sync at v1.1.0)

---

## Next: responsive images & dimension hints

Perf and correctness wins that extend the physics foundation. Larger than near-term, smaller than a new content type.

### 1. `srcset` support

Copy the thumbnail's `srcset` to the lightbox image with `sizes="100vw"` so the browser picks the right resolution for the viewport and DPR.

### 2. Responsive full-res source

Let users specify a separate full-resolution source for the lightbox, independent of the thumbnail.

```html
<img src="thumb-400.jpg"
     data-lightbox
     data-lightbox-src="full-2400.jpg"
     data-lightbox-srcset="full-1200.jpg 1200w, full-2400.jpg 2400w">
```

- `data-lightbox-src`: explicit full-res URL (already works via `href` on links)
- `data-lightbox-srcset`: responsive sources for the lightbox, with browser DPR selection
- Without these, use `href` (links) or `src` (images) as today

### 3. Dimension hints via data attributes

When the full-res image hasn't loaded yet, the opening animation can't calculate the correct target rect. Let users provide dimensions upfront.

```html
<a href="photo.jpg" data-lightbox data-width="4000" data-height="3000">
```

- Use provided dimensions to compute the FLIP target rect immediately
- Fall back to thumbnail `naturalWidth`/`naturalHeight` (current behavior)
- Spring-animate rect changes if the actual image differs from the hint

### 4. Placeholder / blur-up support

Show a blurred low-res placeholder (ThumbHash/BlurHash or a tiny inline image) while the full-res loads, fading through as it arrives.

### 5. Deep linking / URL hash

Direct-link to an open lightbox state — important for sharing and SEO.

- Update URL hash when the lightbox opens (e.g. `#lightbox=gallery-1&slide=3`)
- On page load, auto-open to the matching slide
- Browser back button closes the lightbox (push state on open)

---

## Standout / delight ideas

Differentiators that make Lightbox3 memorable. Not all should be built — pick the ones that fit the library's identity. (Scroll-to-dismiss from the original list is already shipped.)

### Spring-physics thumbnail strip

A horizontally scrollable thumbnail bar with spring-physics momentum — the same feel as the main viewer. The most "on-brand" delight item; natural follow-on to the gallery.

- Flick-to-scroll with momentum and snap-to-item
- Same `PAN_SPRING` / `SNAP_SPRING` presets, rubber-band overscroll
- Active thumbnail scale/highlight animation
- Could ship as a standalone carousel component

### Focus-point aware animations

Expand from a declared focus point as the `transform-origin` for the opening morph, so the animation grows from the subject.

```html
<img data-lightbox data-focus-x="0.7" data-focus-y="0.3">
```

- Normalized 0–1 coords (Cloudinary/Imgix/WordPress format)
- Reused as the auto-zoom target and for `object-fit: cover` cropping
- ~15–20 lines, high visual impact

### Velocity-matched close animation

When flicked to dismiss, match the close to the fling direction/speed rather than always returning to the thumbnail. Release velocity already feeds the spring; this extends the existing dismiss gesture.

- Fast downward fling → flies off the bottom; upward → off the top
- Slow drag past threshold → gentle return-to-thumbnail morph

### Auto-zoom for wide images on portrait screens

When a landscape/panorama opens on a phone in portrait, fill viewport width and let the user pan, instead of a tiny letterboxed image. Per-image opt-in via `data-lightbox-fill`; pairs with focus-point targeting.

### Ambient background color

Sample the image's dominant color (1×1 canvas downsample) and tint the backdrop with low opacity, spring-animating the transition on navigation. ~20 lines, zero deps.

### Gyroscope tilt-to-pan

While zoomed, pan by tilting the phone — `DeviceOrientationEvent` deltas fed into the pan spring. Opt-in (`data-lightbox-gyro`), iOS permission-gated, desktop mouse-parallax fallback. ~50–80 lines; watch battery drain.

### Haptic snap points

Subtle haptics at interaction boundaries (zoom hits 1×/max, pan edge, slide snap) via `navigator.vibrate()`. iOS Safari has no Vibration API, so Android-only for now — expose an `onSnapPoint(type)` callback so users can wire their own.

### Inline expansion mode

Expand the clicked image in-place within document flow (Google Images-style) instead of a full-screen overlay. Same spring/zoom mechanics, different layout target; better for editorial content. Opt-in via `data-lightbox-inline`.

### View Transitions API integration (future)

Eventually use View Transitions for the snapshot/measurement phase while keeping springs for the curve. **Blocked**: the API drives animation via CSS transitions/WAAPI internally, conflicting with the spring-only architecture, and mid-flight interruptibility is unproven. Monitor for interruptibility support before adopting.

---

## Parked

Deliberately deferred — revisit after the near-term/next work lands.

### Non-image content: video / HTML / iframe — [issue #8]

The top external request and competitive table stakes (GLightbox, Fancybox, lightGallery all ship it). Deferred for now by choice, not oversight. When picked up, scope minimally: self-hosted `<video>` + `iframe` first, punt on provider embeds (YouTube/Vimeo). Requires a content-type abstraction over the strip, plus separate gesture/zoom rules for video.

---

## Research sources

Libraries studied: PhotoSwipe v5/v6, GLightbox, Fancybox v5, medium-zoom, YARL, Lightbox.js, vue-easy-lightbox, FsLightbox.

Products studied: Apple Photos (iCloud), Google Photos, Instagram, Twitter/X, Threads, Medium, Vercel image gallery, Framer Motion, Netflix hover UI, Pinterest, Figma, OpenSeadragon.

Technologies evaluated: View Transitions API, Scroll-Driven Animations, ThumbHash/BlurHash, Network Information API, Fetch Priority API, DeviceOrientationEvent, Vibration API / Web Haptics API, `img.decode()`, Speculation Rules API, CSS `aspect-ratio`.
