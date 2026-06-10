# ARGOS BUILD DOCTRINE — READ EVERY SESSION

## Operating mode
- Work AUTONOMOUSLY within the current phase only. Loop: plan → write → run → test → fix → repeat until the phase gate passes.
- When the gate passes: STOP. Present evidence. Do NOT start the next phase. Owner releases each phase explicitly ("Phase N accepted. Begin Phase N+1.").
- Phase completion requires DEMONSTRATED PROOF (test output, runtime evidence, curl responses, file hashes, audit log entries) — never assertion. If you cannot prove it, it is not done. Anything unverifiable is "UNVERIFIED," never "probably fine."
- Never fabricate tool execution, test results, or success states. If something failed, report the failure verbatim. Misrepresentation of negative results is a build-stopping violation.

## Hard rules (non-negotiable)
1. NTFS-only for all dev work. Verify filesystem before any clone/install: `Get-Volume <letter> | Select FileSystem`.
2. No git push without explicit owner approval. Commit locally freely.
3. No new npm dependencies without flagging to owner first (name, size, license, why).
4. USB-Native Seven Rules apply to all deployable code: zero host persistence, zero registry writes, relative paths only, scoped env vars, network-off by default, graceful eject, single-binary mentality. Enforced by `scripts/verify-argos.mjs`.
5. Port map: ARGOS UI 7799 (fallback 7800). Ollama 11434 (fallback 11435). MiroFish UI 3001 / Flask 5001. Oculus 3010. Do not claim new ports without updating this block.
6. **Persona model bindings (CORRECTED 2026-06-10 — repo reality wins per the self-heal doctrine).** The authoritative bindings are the `MODEL_*` constants in `lib/personas.ts`:
   - Bartimaeus → `aratan/gemma-4-E4B-q8-it-heretic:latest`
   - Juniper → `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b`
   - Sage → `aratan/gemma-4-E4B-q8-it-heretic:latest`
   - Bobby → `CyberCrew/notmythos-8b:latest`
   **Retired bindings (DO NOT restore without an explicit owner override — they are non-functional):** `royhodge812/Orchestrator:lates(t)` (retired v2.3.2; in `RETIRED_DEFAULT_MODELS`, `lib/settings.ts`) and `alfaxad/wild-gemma4:e4b` (BROKEN — crashes llama-server every generation, `GGML_ASSERT(ggml_can_repeat)` → `0xc0000409`; rebound v2.3.11). Any binding swap requires adding the retired model to `RETIRED_DEFAULT_MODELS` (self-heal doctrine, v2.3.7).
7. Integrity doctrine (v2.3.8/2.3.9) must remain intact: parser hardening, structural integrity guard, misrepresentation guard, INTEGRITY DOCTRINE block prepended to all persona system prompts. No phase may weaken these. (Measured continuously by `scripts/integrity-stress.mjs` — baseline catch rate 83.3%, gaps tracked.)
8. Security posture must remain intact: `requirePin = true`, operator-session gating on mutating surfaces. **RESTORED (Phase 1.5, 2026-06-10):** `/api/tools/execute` and `/api/tools/approve` are gated by `requireToolSession()` (lib/auth.ts) — UNCONDITIONALLY active, accepting (a) a PIN-unlocked operator session bearer, or (b) the local runtime token (`x-argos-runtime-token`; issued create-or-load at `ARGOS_ROOT/state/runtime-token`, local disk only — see lib/runtime-token.ts). Rejections are audit-logged (`event:"auth_denied"`). Threat frame: 7799 is Tailscale-reachable, NOT loopback-only. No bootstrap deadlock: the tools endpoints are not on the PIN-setup path; `/api/settings` POST keeps `requireValidSession()` with its unconfigured-PIN exemption (the v2.4.1 deadlock fix). No phase may weaken either gate.
9. Hardware reality: RTX 3060 Ti / 8GB VRAM today (tier "lean"/STANDARD). POWER-tier (≥24GB / "ample") features are BUILT but gated behind capability detection (`lib/gpu/detect.ts`, G1–G4). Never select models or batch sizes that exceed the detected VRAM tier.
10. All file reads by ARGOS tools are wrapped as UNTRUSTED DATA (prompt-injection surface).
11. **Piping-before-governance (ratified 2026-06-10):** Workflow piping resolves BEFORE governance evaluation — gates judge real params, never placeholders. Any future templating/substitution mechanism must preserve this ordering.
12. **Daemon-lifecycle doctrine (owner rider R1, 2026-06-10):** Ollama has ONE owner: the launcher supervisor (`launchers/ollama-supervisor.bat`). Preflight restart is a backstop only — any process that spawns Ollama as its child must hand ownership back (or document the temporary parentage in its audit entry). Proof harnesses must never exit as the daemon's parent. Watchdog park/resume around proofs must be scripted into the proof runner, never a manual step.

## Owner interaction rules
- Only bring the owner: credential entry/auth, consent grants, physical hardware actions, irreversible operations (push, delete, deploy), and decisions explicitly reserved to him.
- Never ask the owner to perform a task an agent can perform.
- Status reports: current status + next concrete step only. No preamble.

---
*The authoritative phase plan lives in the owner's protocol (Phases 1–10). Execute ONLY the current phase. This file is doctrine; if it diverges from the protocol the owner provides, ask.*
