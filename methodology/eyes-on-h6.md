# Eyes-on Verification — H6 Stub Pages + Workspace Honesty

**Verifier:** Claude Code via Claude_Preview MCP browser tools
**When:** 2026-05-19
**ARGOS branch:** e-drive-migration · 5 H6 commits landed before this drive-through
**Theme:** Honesty hour — doctrine made visible inside the product

## Stub honesty audit (`scripts/audit-stub-honesty.mjs`)

44 checks across four stub pages + the workspace switcher. **All green.**

```
=== Vision (app/vision/page.tsx) ===   10/10 ok
=== Voice (app/voice/page.tsx) ===     10/10 ok
=== Memory (app/memory/page.tsx) ===   10/10 ok
=== Tools (app/tools/page.tsx) ===     10/10 ok
=== Workspace switcher (LeftRail) ===   4/4  ok
Stub honesty audit: PASS
```

Each stub asserts:
- contains `v2`
- references `Path B`
- links `docs/02-SCOPE-LOCK.md`
- has a "Why not v1" section
- has a "What this will do" section
- carries the correct week marker (Vision = 8, Voice = 6, Memory = 10, Tools = post-launch)
- does NOT import `useState` or `useEffect` (server components only)
- does NOT call `fetch(`
- does NOT have a wired `onClick` handler (preventDefault-only is allowed)

The audit is the executable form of "no half-features in stubs." If a future change accidentally wires up a stub page to a real handler, the audit fails the next CI pass.

## Server-rendered HTML for every stub route

Direct `GET` against the dev server, no client hydration needed:

| Route | Status | Bytes | v2 | Path B | scope-lock link | Why-not | What-will-do |
|---|---|---|---|---|---|---|---|
| /vision | 200 | 31638 | ✓ | ✓ | ✓ | ✓ | ✓ |
| /voice | 200 | 33518 | ✓ | ✓ | ✓ | ✓ | ✓ |
| /memory | 200 | 32657 | ✓ | ✓ | ✓ | ✓ | ✓ |
| /tools | 200 | 33033 | ✓ | ✓ | ✓ | ✓ | ✓ |

Every honesty marker is present in the server HTML — survives JS-disabled inspection.

## LeftRail nav (post-H6)

4 stub nav items now route AND keep their v2 badge:

```
[ { id: "vision",  badge: "yes" },
  { id: "voice",   badge: "yes" },
  { id: "memory",  badge: "yes" },
  { id: "tools",   badge: "yes" } ]
```

Click → real route. Badge stays visible. Engineers on Friday cannot accidentally think these are real features because the v2 badge is right next to the label.

## Vision page (live drive-through)

```
pathname        /vision
data-stub-page  vision     (present in DOM)
status badge    "V2"       (amber, border + bg tinted)
week badge     "WEEK 8 · PATH B"
sections       [what-this-will-do, why-not-v1, roadmap-reference]
```

Below the sections, a disabled file-drop zone with diagonal stripe overlay reads `coming v2` — visual proof of the planned widget without any input handler.

## Workspace switcher (LeftRail)

```
operator    active=true   disabled=false  no tooltip
research    active=false  disabled=true   tooltip="Workspaces ship in v2..."
strategy    active=false  disabled=true   tooltip="Workspaces ship in v2..."
theology    active=false  disabled=true   tooltip="Workspaces ship in v2..."
writing     active=false  disabled=true   tooltip="Workspaces ship in v2..."
survival    active=false  disabled=true   tooltip="Workspaces ship in v2..."
coding      active=false  disabled=true   tooltip="Workspaces ship in v2..."
```

All six v2 workspaces carry the same canonical tooltip ending with the literal phrase "See docs/02-SCOPE-LOCK.md." — one truth string, sourced from a constant, so it cannot drift across rows.

Click handler on disabled workspaces preventDefaults; no navigation happens. The audit explicitly checks for that pattern.

## HUD on stub pages — still live

Captured on /vision after nav from /:

```
Model:        llama3.1:8b-instruct-q4_K_M
Mode:         GPU · NVIDIA
Reason:       NVIDIA GeForce RTX 306…
Persona:      Bartimaeus
Retrieval:    ON (1 doc, 1 chunk)
Vault:        1 doc, 1 chunk
USB path:     E:\Argos_Claude (dev)
Network:      Local only
Build:        v0.1.0
Uptime:       15s  (ticking)
```

Stub pages do not disable the HUD. Live system metrics keep updating regardless of route — proves the chassis is reusable, not a fork.

## Network audit during stub session

51 browser requests, all `http://localhost:3000/*`. The stub pages themselves issue zero fetch calls (audit assertion); the requests visible are HUD hydration (`/api/about`, `/api/hardware`, `/api/vault/list`), route fetches, and Next.js hot-update WebSocket messages. Zero external.

## Spec checklist

- [x] Click Vision in LeftRail → /vision loads with honest content
- [x] Reason for v2 deferral is specific (4–7 GB payload, 30–60 s CPU inference, Week 8 deliverable)
- [x] Week number from Path B plan is cited (Week 8, Week 6, Week 10–11, post-launch)
- [x] Click Voice → same quality of honesty (Whisper.cpp 466 MB–1.5 GB, Piper 50–200 MB / persona, audio permissions UX)
- [x] Click Memory → same (Core Brain orchestrator dependency, vault-vs-memory distinction)
- [x] Click Tools → same (engineering discipline framing, "v1 ships zero tools by design")
- [x] Hover a grayed workspace → tooltip appears with v2 explanation
- [x] Click a grayed workspace → does nothing (preventDefault + disabled)
- [x] LeftRail v2 badges visible on all stub items (amber, consistent)
- [x] HUD on stub pages still shows live values (hardware, network, vault, uptime)
- [x] Network tab: stub pages make zero external requests

## Decisions / divergences

1. **Workspace list expanded** from the previous Analyst/Researcher placeholders to the spec-requested set: Operator, Research, Strategy, Theology, Writing, Survival, Coding. Operator is v1; the other six are v2. The labels are now persona-categories from the doctrine.
2. **Stub pages are pure server components.** No `"use client"`, no React state, no effects, no fetch. The HUD on these pages remains a client component (it has its own hydration); the page content does not. The audit enforces this.
3. **`config/` directory added to `.gitignore`** because H5's settings.json is per-user runtime state. Folded into commit 1 as a one-line housekeeping piece — not its own commit.
4. **5 commits this hour, not 6.** Spec said "5–6". I bundled the gitignore tweak into commit 1 rather than break the cadence; the workspace switcher honesty stayed at commit 5 as planned.
5. **Animation observability** still unobservable (carried from H3–H5). The amber v2 badge color shift, the tooltip-on-hover, the diagonal-stripe overlay on the vision drop zone — all code-verified.

## What's still browser-eyes-on for the human

- The amber v2 badges next to nav items — color saturation against the dark background
- Tooltip fade-in timing on grayed workspaces (browser-default delay ≈ 500 ms)
- Diagonal-stripe pattern on the disabled vision drop zone
- Whether the four stub pages "feel" structurally identical (intentional — same `StubPage` chassis)
