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

---

## 2026-05-19 — Decision: keep user-asset files untracked, don't commit them as repo content

**Context:** End-of-H6 score harness flagged the working directory as carrying 2 dirty files. Investigation shows they are:
1. `ARGOS/` — an empty directory present in the working tree since session start (dropped here by the user before doctrine was written).
2. `argos imagery.png` — a reference image dropped at repo root before scaffolding.

**Resolution:** Both are user assets, not source. They were deliberately unstaged in every commit from H1 onward (you can see `git restore --staged` calls in the transcript). Treating them as "dirty source" would either commit user material (wrong) or pretend they don't exist (also wrong). The right move is to keep them untracked.

**Action taken:** None — both items continue to be untracked. Added to gitignore would feel sneaky; just letting them sit as visible-but-untracked is the most honest posture.

**Lesson:** Scoring tooling that flags any non-clean working tree as a warning will misclassify user-supplied reference material as project drift. The remediation is to be explicit about provenance, not to suppress the signal.

---

## 2026-05-19 — Self-correction: /api/about was out of scope, refactoring to inline server props

**Context:** End-of-H6 score harness flagged `/api/about` as an out-of-scope API route. The scope authorization for v1 covers chat, vault, hardware, settings — not about. I created the route in H5 to centralise build-info reads for HUD and AboutSection; this was a small unauthorised scope expansion.

**Correction:** Remove `app/api/about/route.ts`. Replace the data path with `lib/runtime-info.ts` (server-only module that reads package.json + ARGOS_ROOT + boot time). Each server page calls `getRuntimeInfo()` and passes the result as props down to HUD and AboutSection. Client components no longer fetch `/api/about`.

**Lesson:** When a feature needs cross-page data, the first instinct shouldn't be "add an API route." Server-component props are cheaper and stay inside the existing scope envelope.

