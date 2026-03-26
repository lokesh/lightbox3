# Lightbox3

## Animation Architecture

**Use `requestAnimationFrame` + spring physics for all animations and gestures.** Do not use the Web Animations API (WAAPI) or CSS transitions.

### Why

- **Single system**: One spring engine drives everything — open/close morph, zoom, pan momentum, snap-back. No mixing of animation paradigms.
- **Interruptible**: Any animation can be grabbed mid-flight. A user can catch an image during momentum, during a zoom transition, etc. rAF loops cancel cleanly; WAAPI `fill: forwards` creates layer priority conflicts with inline styles.
- **Velocity-aware**: Release velocity from gestures feeds directly into the spring's initial velocity. WAAPI has no concept of this — you'd need to pre-compute the entire curve.
- **Compositor-friendly**: All interactive animations use `transform` only (translate + scale), which stays on the GPU compositor thread.

### Interruptibility

**All animations must be interruptible.** A user must be able to grab, tap, or redirect any in-progress animation at any time. Never lock out input while an animation is running.

- Before starting any new animation, call `stopSpring()` to cancel the current rAF loop.
- Read the current spring state (position + velocity) as the starting point for the new animation — don't snap to a predefined start.
- Never use `isAnimating` as a gate that blocks user input during gestures. It should only prevent conflicting *programmatic* transitions (e.g. open during close), not block pointer events.

### Completion-only flags are traps

Never use a boolean that is only set on animation *completion* (e.g. `zoomed`) to gate user input. These flags create dead windows where clicks/taps are silently swallowed for the entire duration of the animation.

- **`zoomed`** is `true` only after zoom-in finishes and stays `true` until zoom-out finishes. During the zoom-out animation it is still `true`, so any check like `if (this.zoom.zoomed) return` blocks input for the entire transition.
- To check "is a zoom in effect right now (idle or animating)?" test the live spring state: `this.zoom.zoomed || this.zoom.scale !== 1`.
- Same principle applies to `isOpen` — set it when the action *begins* (overlay created), not when the animation lands.

### Side-effects must not live in onComplete

Never put essential side-effects (image loading, state transitions) inside an animation's `onComplete` callback. If the animation is interrupted, the callback never fires and the side-effect is lost. Start async work (e.g. full-res image load) immediately and guard the result with a check that the lightbox is still showing the relevant content.

### Spring long tail

Springs settle mathematically long after they are visually done — position and velocity creep toward zero but take many extra frames to cross the threshold. Never wait for full settlement to perform DOM cleanup or state transitions that the user can perceive.

- For close animations, use an `earlyComplete` check (e.g. `opacity < 0.01`) to remove the overlay as soon as it's invisible, not when every spring has settled.
- For zoom-in, allow panning as soon as `scale > 1` rather than waiting for the zoom spring to fully settle.

### Pointer event ordering

Browser event order is: `pointerdown` → `pointermove` → `pointerup` → `click`. State read in one handler must survive until later handlers in the same sequence have consumed it.

- `dragMoved` must stay `true` through the `click` handler so it can suppress the click. Clear it *in the click handler* after checking it, not in `pointerup`.

### Reentrant transitions

A transition (e.g. close) must not restart itself when the user repeats the triggering input (e.g. pressing ESC multiple times). Use a dedicated flag (`isClosing`) to guard against re-entry. The flag is set when the transition begins and cleared only in the final cleanup (`finishClose`).

### Overlay must not block during exit

The overlay sits above the page and captures all pointer events. During the close animation, set `pointer-events: none` on the overlay so clicks pass through to thumbnails underneath. This lets the user click a new thumbnail to interrupt the close and immediately open a new image.

### How it works

- `springStep()` is the core: a damped harmonic oscillator stepped via semi-implicit Euler integration
- Each animated property gets its own `SpringState` (position + velocity)
- A single `requestAnimationFrame` loop ticks all active springs each frame
- Springs self-terminate when position and velocity are within threshold of target

## Tests

No tests for now. Do not add or suggest tests.

### Spring presets

- `SPRING_OPEN` (stiffness: 260, damping: 24) — open morph, zoom in
- `SPRING_CLOSE` (stiffness: 300, damping: 28) — close morph, zoom out
- `PAN_SPRING` (stiffness: 170, damping: 26) — pan momentum (softer, more glide)
- `SNAP_SPRING` (stiffness: 300, damping: 30) — rubber band snap-back (stiffer)
