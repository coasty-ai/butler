# Open Assist visual direction

The requested aesthetic is simple monochrome, Space Grotesk, and restrained motion inspired by JARVIS. The desktop stays a floating pill and a hidden utility window. The larger page is only a browser preview of the product.

- Black/graphite surfaces, white primary text, neutral gray secondary text and one-pixel borders. Color is not used to signal state; labels, icons and motion carry it.
- Space Grotesk Variable is bundled through Fontsource. There are no runtime font requests. Its SIL Open Font License is included in `public/licenses/Space-Grotesk-OFL.txt`. [Original font project](https://github.com/floriankarsten/space-grotesk)
- A vector orbital core replaces the earlier four-dot mark. The tray icon, native app icon and pill use the same monochrome ring language. The app icon is generated from `scripts/Icon.swift`.
- Working: two rings rotate in opposite directions, with a subtle moving edge highlight. Listening: live audio level changes the core and waveform. Approval: a slow border/core pulse. Completion: a check draws, then the pill fades away.
- Arrival takes 240 ms; text transitions take 180 ms; secondary surfaces take 200–220 ms. Hover feedback takes 150 ms. Continuous motion runs only on the visible activity indicator. Reduced-motion preferences disable these animations.

`src/ui/styles.css` supplies layout; `src/ui/motion.css` supplies the monochrome palette and motion system. Real screenshots in local review retain their original colors; interface styling does not recolor user evidence.
