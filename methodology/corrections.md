# Human-in-the-Loop Corrections

Instances where human judgment overrode AI suggestion or caught AI mistakes. Part of the thesis evidence.

---

## 2026-05-19 — Self-correction: false-positive animation bug claim during H3 eyes-on

**Context:** During Hour 3 eyes-on verification via Claude_Preview MCP tools, I sampled the eye SVG's `getComputedStyle().transform` over 1.4 seconds and observed identity matrix throughout. I initially reported this as a real bug — "found via eyes-on, framer-motion's `motion.svg` is not animating."

**Correction:** Before any code change, I ran two controls:
1. A plain `<div>` with `@keyframes scale 1→2→1` — also returned identity matrix.
2. The same `<div>` driven by `Element.animate(...)` (WAAPI) — also identity.

This proved the Claude_Preview Electron renderer was suppressing animation observation, not that the eye pulse was broken. The bug was in my verification environment, not in the code.

**Lesson:** When verifying motion/transitions in a headless or non-standard browser, validate the environment itself with a known-good control (plain div + keyframes) before declaring a real bug. Inline `style` attributes and DOM mutations are observable; animated transforms may not be.

**Outcome:** No code change. Pulse animation remains as written, flagged in `methodology/eyes-on-h1-h2-h3.md` as "code-verified, eyes-on pending in real browser."
