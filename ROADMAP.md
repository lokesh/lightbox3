# Lightbox3 Roadmap

> **Convention:** This is a forward-looking roadmap. When an item ships, **remove it from this file entirely** — don't mark it done or keep a changelog here. Git history is the record of completed work; this file tracks only what's still ahead.

Direction: keep the two things that make Lightbox3 distinct — **dead-simple drop-in setup** and **best-in-class mobile physics** — and fill the gaps around them before chasing scope. Video / non-image content is deliberately parked (see [Parked](#parked)); the near-term focus is small correctness gaps and open GitHub issues.

---

## Near-term: gaps & GitHub issues

Small, high-return work. Do these before opening any large new surface.

### N1. `img.decode()` in the preload pipeline (measure first)

`decoding="async"` is already set on the displayed and preloaded images — that captures most of the off-main-thread decode win at zero risk. Only pursue an explicit `img.decode()`-gated pipeline if profiling on a real mobile device still shows decode jank.

- Profile navigation between large cached images on a real phone first
- If jank persists: `await img.decode()` on the **visible element at its render size** (not the detached preload object — that can re-decode when displayed scaled), guarded against close/interrupt
- Fall back gracefully where `decode()` is unsupported or rejects

### N2. Project hygiene

Not features, but they gate everything else and signal a maintained project.

- **CI**: add `.github/workflows` running lint + build. Unblocks safe Dependabot merges
- **GitHub Releases**: cut releases with notes (npm & tags are already in sync at v1.1.0)

---

## Next: responsive images

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

### 3. Deep linking / URL hash

Direct-link to an open lightbox state — important for sharing and SEO.

- Update URL hash when the lightbox opens (e.g. `#lightbox=gallery-1&slide=3`)
- On page load, auto-open to the matching slide
- Browser back button closes the lightbox (push state on open)

---

## Standout / delight ideas

Differentiators that make Lightbox3 memorable. Not all should be built — pick the ones that fit the library's identity. (Scroll-to-dismiss from the original list is already shipped.)

### Spring-physics thumbnail strip

A horizontally scrollable thumbnail bar with spring-physics momentum — the same feel as the main viewer. The most "on-brand" delight item; natural follow-on to the gallery. **Still in the design/riff stage — we expect to prototype multiple layouts before committing.**

**Physics (settled):**
- Flick-to-scroll with momentum and snap-to-item
- Same `PAN_SPRING` / `SNAP_SPRING` presets, rubber-band overscroll at both ends
- Active thumbnail scale/highlight animation; indicator tracks the strip's **live spring position** during swipes (not just on settle), so the main image and the strip move as one system
- Could ship as a standalone carousel component

#### The layout problem: caption + strip both want the bottom

Today the chrome is a single **floating pill**, centered at `bottom: 16px` (12px on mobile), backdrop-blur, radius 48px, laid out as `[caption · counter · close]`, `max-width: min(90vw, 600px)`. It already hides when zoomed and is absent for single images. The strip has to share that bottom zone. Candidate arrangements to prototype:

**A. Stacked pills (strip above caption).** Two floating pills, both centered, strip riding just above the caption pill. Keeps the established pill language; each element stays content-width. Cost: two stacked layers eat vertical space at the bottom of the image — heavier on short/portrait screens. Feels most "native photos app."

**B. Split — strip one side, caption other.** Strip floats bottom-left (or full-width-ish), caption pill bottom-right (or opposite). Resolves the vertical-stacking weight, but the centered-caption identity is lost and the two compete for horizontal room; the caption can currently run wide (up to 600px / 10-line clamp), so this needs a caption size cap.

**C. Merged pill.** Thumbnails live *inside* the chrome pill — a scrollable thumb rail as one row, caption as a second row within the same blurred container. One coherent object, one blur, one hide/show spring. Risk: a tall two-row pill starts to feel like a docked bar rather than a light floaty element; horizontal thumb scroll inside a rounded pill needs careful edge masking.

**D. Auto-hide / peek.** Strip is not persistent — it slides up from the bottom edge on hover (desktop) or tap (mobile), overlapping the image, and retracts after idle. Caption stays as-is. Keeps the default view clean and dodges the coexistence problem most of the time; the collision only exists while the strip is peeked. Pairs naturally with the floaty look.

#### Floaty vs. docked (leaning floaty)

Preference is for the strip to **float over the bottom of the image** — same as the caption — rather than dock below the image in its own reserved band. Floaty keeps the image large and matches the existing blur-pill aesthetic; thumbnails get a translucent, backdrop-blurred backing so they read over any image. The tradeoff to watch: floating thumbnails occlude the bottom of the photo, so we likely want them to auto-hide or dim when not in use (pushes toward **D**, or a stacked-but-auto-hiding hybrid of **A + D**).

#### Coordination behaviors (apply to whichever layout wins)

- Hide with the rest of the chrome when zoomed; absent for single-image galleries
- During the peek/retract, animate on the same chrome-opacity spring so strip + caption feel like one system
- Tapping a thumb triggers the normal navigate transition; the strip re-centers the new active thumb with momentum
- Keep the overlay `pointer-events` discipline — the strip must not block dismiss/swipe on the image behind it

#### Prototype plan

Build a throwaway demo toggling between approaches **A / C / D** (skip **B** unless A and C both feel wrong) so we can feel them on a real phone before wiring the real spring integration. Decide on: persistent vs. auto-hide, floaty vs. docked, and whether caption and strip share a container. Mobile is the deciding surface — a persistent strip + caption may simply be too much furniture on a small portrait screen, which would settle us on **D**.

#### Open questions

- Does the strip auto-hide, and if so on what trigger (idle timer, zoom, first navigate)?
- Thumbnail source: reuse the page thumbnails' `src`, or a separate `data-lightbox-thumb`? (ties into the responsive-images work above)
- Desktop vs. mobile divergence — same layout both, or persistent on desktop / peek on mobile?
- How does the strip interact with the caption's variable height (short caption vs. 10-line clamp)?

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
