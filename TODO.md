
BUGS
- [x] bug: clicking an image in gallery quickly after transition closes it rather than zooms in
- [ ] animating in from a cropper object fit thumb nail

FEATURES
- [ ] gallery thumbnail strip
- [ ] Old LB2 features: link support in captions, what else

UI POLISH
- [ ] test trackpad scrolling across the UI, think it needs work
- [ ] scrolling should close, or scrolling should be blocked
- [ ] caption rendering and transitioning from one to the other
- [ ] zooming in too much on tap on mobile, dial in the defaults later
- [ ] interface visual design - specular shean on the items, with some glassiness? light mode?
- [ ] rounded corners support?
- [ ] increase size of UI on bigger screens?


RELEASE
- [ ] decide on releasing under lightbox2 package name or a new one.  current thinking: brand new library, link to lightbox 3 from lightbox 2 page

MAYBE
- [ ] web haptics
- [ ] CSS Custom Properties for Physics and Theming


BRAINSTORMING

- Velocity-aware transitions - Open/close animation duration adapts to gesture velocity and travel distance. A fast flick dismisses quickly. A slow drag gets a slower spring-back. The system reads the user's energy and matches it.
- Subtle squash/stretch under stress - During drag-to-dismiss, the image slightly scales down as it moves away from center (like Fancybox's compact mode: interpolate from current scale to ~77% over 33% of viewport drag). On fling, the image tilts in the drag direction. On spring-back overshoot, the image very slightly compresses then expands. These are 1-2% effects — felt more than seen.