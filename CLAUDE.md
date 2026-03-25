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
