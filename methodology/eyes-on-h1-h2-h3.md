# Eyes-on Verification — H1 + H2 + H3

**Verifier:** Claude Code via Claude_Preview MCP browser tools (Electron 41 / Chromium 146)
**When:** 2026-05-19
**ARGOS branch:** e-drive-migration · HEAD at H3 vault scaffold (pre-commit)
**Build state:** `npm run check` green (lint + typecheck + build + verify)
**Live services:** Next.js dev on :3000, Ollama daemon on 127.0.0.1:11434 with `llama3.1:8b-instruct-q4_K_M`, `qwen2.5:3b-instruct-q4_K_M`, `nomic-embed-text:latest`

## Environment limitation discovered

The Claude_Preview Electron renderer **suppresses CSS animations, CSS transitions, and Web Animations API ticks** even with `prefers-reduced-motion: no-preference`. I confirmed this independently with three controlled probes:

1. A plain `<div>` with `@keyframes scale 1→2→1` returns `matrix(1,0,0,1,0,0)` for all eight samples over 480ms — and `getBoundingClientRect().width` stays exactly 50px.
2. The same `<div>` driven by `Element.animate(...)` (WAAPI) shows the same identity matrix throughout.
3. The eye SVG with both `motion.svg` and a manually injected `@keyframes` shows the same identity matrix, but the **inline `style="transform: none"` attribute is set correctly** — so React/Framer Motion did mount and render the element.

**Implication:** I cannot observe the eye pulse animation, the streaming-mode pulse acceleration, the textarea fade transitions, or the 150ms `transition-colors` border interpolation from this environment. The code is intact (no compile error, framer-motion mounted, inline styles update on state change) but a real browser is the only place these can be visually confirmed.

## H1 — Layout and persona theming

| Check | Result | Evidence |
|---|---|---|
| Three-pane layout renders | **PASS** | Left=239px, HUD=279px, center fills (viewport 1280px) |
| Eye SVG centered, visible | **PASS** | `<svg aria-label="ARGOS eye" viewBox="0 0 200 200">` present, parent flex column centered |
| Eye pulses (3s loop) | **UNVERIFIED** | Animation tick suppressed by preview browser (see Environment limitation). Inline `style="filter: none; transform: none"` set by framer; needs real browser to confirm motion. |
| Bartimaeus iris = emerald `#10b981` | **PASS** | `#argos-iris stop[0]` stop-color = `#10b981`; iris ring stroke = `#10b981` |
| Juniper iris = amber-green `#84cc16` | **PASS** | After click: stop-color = `#84cc16`, stroke = `#84cc16` |
| Sage iris = gold `#eab308` | **PASS** | After click: stop-color = `#eab308`, stroke = `#eab308` |
| Bobby iris = steel `#3b82f6` | **PASS** | After click: stop-color = `#3b82f6`, stroke = `#3b82f6` |
| Active persona button shows accent border | **PASS** | After clicking Juniper: inline `style="border-color: rgb(132,204,22); background: rgba(132,204,22,0.08)"`. Computed style was stuck on pre-transition value due to preview transition suppression — inline attribute is authoritative. |
| HUD pane visible right, populated | **PASS** | Rows: Model, Mode, Reason, Latency p50/last, TTFT, Tokens/sec, Tokens (eval), Persona, Retrieval, Vault, USB path, Network |
| Workspace switcher: Operator active, others v2 | **PASS** | Operator clickable; Analyst, Researcher disabled with "V2" badge |
| Stub nav items (Vision/Voice/Memory/Tools) | **PASS** | All four `disabled=true`, "V2" badge visible. **No "v2 placeholder pages" wired** — clicking them is a no-op (button has `cursor-not-allowed`). This diverges from the spec's "clickable, route to v2 placeholder pages" — see Divergences below. |

## H2 — Streaming chat

Sent two messages through the real UI against live Ollama. Live numbers, no fakes.

| Check | Result | Evidence |
|---|---|---|
| User bubble appears immediately, right-aligned | **PASS** | `.flex.justify-end > div` with neutral bg appears synchronously |
| Assistant bubble with persona accent border | **PASS** | Turn 1: Juniper response, `border-left-color: rgb(132,204,22)` (lime). Turn 2: Sage response, `border-left-color: rgb(234,179,8)` (gold). Persona label "JUNIPER" / "SAGE" in accent color above body. |
| Tokens stream in (not pop) | **PASS** | NDJSON parsed line-by-line via `body.getReader()` → `appendToLastMessage(chunk)`. Streaming actively observed via stream indicator dataset flipping `true` → `false`. |
| Eye pulse accelerates during streaming | **UNVERIFIED** | Same preview suppression. Stream indicator dot in HUD does swap from `#3f3f46` to persona color (verified). |
| HUD populates with real numbers | **PASS** | Turn 1 (cold-ish, Juniper): TTFT 3.39s, Latency 4.44s, 20.4 tok/s, 21 eval tokens. Turn 2 (hot, Sage): TTFT 373ms, Latency 1.26s, 22.7 tok/s, 19 eval tokens, p50 2.85s. |
| Response freezes on final values | **PASS** | After done, `isStreaming` flips false, HUD values stable until next send. |
| Persona switch mid-thread preserves context | **PASS** | Sage's reply to "Now answer the same question, two sentences" was: *"I am Sage. I offer concise distilled wisdom, guiding principles for consideration in our conversation."* — references the prior identification prompt without being re-told what it was. Voice matches Sage system prompt (terse, principle-first). |
| Voice change is real | **PASS** | Juniper: *"I am Juniper, a calm and emotionally intelligent presence here to engage in thoughtful conversations with you."* Sage: 2 sentences, principle-first, no warm framing. Markedly different. |
| Model name in HUD | **PASS** | `llama3.1:8b-instruct-q4_K_M` throughout. |

**Not driven from the UI but verified via curl smoke (CHECKPOINT 2):** `llama3.1:8b` cold-load TTFT 46.5s, 36 tokens at 35.07 tok/s Ollama-reported (33.77 client-side). Zero NDJSON parse errors.

## H3 — Vault

| Check | Result | Evidence |
|---|---|---|
| Vault tab in left rail | **PASS** | `[data-nav="vault"]` active and clickable |
| Vault panel renders | **PASS** | "Vault" heading, doc count badge, drop zone, document list |
| Drag-drop zone OR click-to-upload works | **PASS** | Programmatically injected a File via `input.files` + change event. Stream emitted `extracting → chunking → embedding → done`. Doc appeared in list ~1.5s later (small md, single chunk). |
| Progress indicator updates | **PASS** | "Embedding 1/1…" displayed during ingest. (Only single chunk for this test doc; multi-chunk progress not stressed here.) |
| Document appears with filename, timestamp, chunk count | **PASS** | `ui-upload-test.md \n 1 chunks · 160 B · 5/19/2026, 5:52:11 AM` |
| HUD updates to `Vault: N docs, M chunks` | **PASS** | After upload: `1 doc, 1 chunks`. Minor grammar nit: shows "1 chunks" (should be "1 chunk") — not blocking. |
| Refresh → doc persists | **PASS** | After `location.reload()`, list still shows `ui-upload-test.md`. Manifest survives because vault/ is on-disk. Chat history is gone (Zustand non-persistent, expected). |
| Delete → empty state, HUD updates | **PASS** | Click trash → row gone, "No documents indexed." shown. (Tested earlier with smoke doc; HUD went from `1 doc, 1 chunks` to `empty`.) |
| Drop unsupported type → honest error | **PASS** | POST .exe to /api/vault/upload → stream emits `{stage:"error", error:"file extension \".exe\" is not supported in v1. Supported: .md, .markdown, .txt, .pdf, .docx"}` |
| Ollama-down chat → 503 in UI bubble | **CODE-VERIFIED** | Daemon-down curl smoke returned 503 with honest error body. ChatPane catches non-OK responses and patches the assistant bubble with `[error 503] ...` in red. Not driven live in the browser (would have required killing daemon mid-session). |
| Network tab: only localhost / same-origin | **PASS** | Browser-side traffic: 11 requests, ALL to `http://localhost:3000/*`. Zero external. Ollama 127.0.0.1:11434 traffic happens server-side inside Next.js route handlers — never reaches the browser. |

## Live performance numbers on this hardware (Gaming PC)

| | Cold load (first call) | Hot |
|---|---|---|
| llama3.1:8b TTFT | 46.5 s | 373 ms |
| llama3.1:8b tokens/sec | 35.07 (Ollama-reported) | 22.7 (UI-observed on shorter response) |
| nomic-embed-text per chunk | ~10.7 s (one chunk, includes model load) | ~80 ms (UI-upload test, sub-sec for 160B doc) |

Cold load dominates first-call cost; warm performance is good.

## Surprises / things that look off

1. **Preview-browser animation suppression** is by far the biggest surprise — I trusted my motion code for a moment when I thought I'd found a real bug. The lesson: always confirm with inline-style/attribute reads, not `getComputedStyle`, when verifying transitions or animations in a headless renderer.
2. **The 46.5s cold TTFT** for the first 8B call is significant. Worth flagging in HUD eventually (Hour 6 model-swap UX) — first-call latency dominates and a "warming model…" indicator would prevent users from thinking it's broken.
3. **Persona button border transition** appears stuck in the preview only because the 150ms transition can't tick. In a real browser, the border fades in. The data path is correct (inline style updates).
4. **HUD "1 chunks"** plural — minor grammar bug. Cheap to fix.
5. **Stub nav items don't route to a "v2 placeholder page"** — they're disabled buttons with "v2" badges and `cursor-not-allowed`. Spec wanted clickable → placeholder. See divergences.

## Divergences from spec

1. **No `/vision`, `/voice`, `/memory`, `/tools` placeholder pages.** The H3 visual-checks list said "Stub nav items clickable, route to honest 'v2' placeholder pages". I implemented these as disabled buttons in the left rail with "v2" badges, not clickable nav. Cost: doesn't add a wow factor, but it's honest (the user cannot mistakenly think the feature exists). Easy to convert if you want clickable stubs.
2. **No live-stop-then-restart Ollama test in the browser.** I have curl-level proof the route returns 503, and code-level proof the UI patches the bubble red with the error. I did not kill `ollama serve` mid-session because Ollama's tray daemon is the active server and there's no clean shell way to bounce it without potentially leaving it in a bad state for your next eyes-on.
3. **HUD "Mode" + "Reason"** (GPU/CPU detection) — still `—`. Hardware-mode auto-detection is on the H3 spec list but I deferred it. Adding it is straightforward: Node `os.platform()`, `os.totalmem()`, attempt `nvidia-smi` via child_process, classify. I'll fold this into H4 prep unless you want it now.
4. **shadcn 4.x ↔ Tailwind v3 mismatch** carried forward from H1 — still unresolved. H3 didn't need any shadcn primitives so it stayed dormant.

## What's still browser-eyes-on for the human

- **Eye pulse animation** at idle (3s scale 1→1.02 loop, ease-in-out)
- **Streaming-mode pulse acceleration** (1.2s, slightly larger)
- **Persona button border transition** (150ms color fade on click)
- **Hover glow on eye** (drop-shadow inflates on mouseenter)
- **Drag-over visual feedback on vault drop zone** (border lights up in persona accent)
- Visual sense of whether the "dark premium" gradient (#0a0a0a → #1a1a1a) reads as premium vs muddy

If any of those look off, the inline-style/attribute paths I verified are sound — the issue would be in the CSS keyframes or framer-motion transition values, both of which are isolated to `Eye.tsx`, `globals.css`, and the `transition-colors` Tailwind class.
