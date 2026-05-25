# Scope Lock — v1.0 (frozen 2026-05-24)

The original Friday-v1 scope-lock from the build sprint is preserved at the bottom of this file as a historical artifact. The current section reflects what actually shipped.

---

## CURRENT — v1.0 LOCKED

For the full lockdown manifest with deferrals + the "is this v1.0?" acceptance checklist, see [`06-V1.0-LOCKDOWN.md`](06-V1.0-LOCKDOWN.md).

### SHIPS

- Chat with streaming via Ollama (`127.0.0.1:11434` with `11435` fallback)
- **4 personas**: Bartimaeus (live default), Sage, Bobby, Juniper (selectable)
- Animated eye, dark premium UI, persona-accent color system
- **Vault**: PDF / DOCX / MD / TXT → in-memory cosine retrieval over `nomic-embed-text` 768-dim embeddings (no Chroma)
- **Per-persona retrieval policy** + 3-bucket confidence (HIGH ≥0.55 / MED ≥0.40 / LOW ≥0.25)
- **Auto-ingest** from `vault/dropbox/` on launcher boot, archives to `.processed/` / `.errored/`
- HUD: persona, model, swap-status, latency, tokens/sec, retrieval breakdown, vault stats, mode + reason, citations used, session id, USB path, network, build, uptime
- Truth Mode toggle with citation enforcement injected into persona prompt
- Settings: persona default + model + hardware probe + vault management — atomic write to `config/settings.json`
- Session persistence + history browser (atomic temp-write + fsync + rename)
- **Markdown export** + **JSON tamper-evident bundle export** with `bundleHash`
- **Append-only hash-chained audit log** at `state/audit/chain.jsonl` + `/api/receipts` query + standalone verifier (`scripts/verify-audit-chain.mjs`)
- **Voice I/O scaffold** (Whisper STT + Kokoro TTS) — UI hides when binaries absent
- Tools dock (Oculus / SuperAGI / LookingGlass scaffold via `tools/registry.json`)
- Cross-platform launcher (Windows `.bat`, macOS `.command`, Linux `.sh`) — port-fallback + 10 MB log rotation + tool-boot block
- GPU / Metal / CPU auto-detection (`lib/hardware.ts`)
- Seven USB-Native Rules — enforced at every commit via `npm run verify`

### CUT (not built — kept here for historical clarity)

- Real cloud sync
- State engine, ambient modes
- Easter eggs, ring activation
- Encryption at rest (filesystem-level only in v1.0)
- In-chat tool-calling (Tools dock launches externally; in-chat workflow is v2)
- Multi-workspace switcher (UI exists as stub; Operator workspace only)
- AGI / sentience framing

### Hardware reality (Phase 1.5 measured)

The current rig is **RTX 3060 Ti / 8 GB VRAM**, not the original plan's 4090. Phase 1.5 measured operating profile drives current model selection:

- Bartimaeus / Sage → `e4b:latest` (gemma4 7.5B Q4_K_M, 5.3 GB on disk, ~4.9 GB VRAM, 19-21 tok/s)
- Bobby / Juniper → `gemma2-2b-local:latest` (gemma2 2B, 1.7 GB on disk, 132 tok/s)
- Embeddings: `nomic-embed-text` (768-dim, 274 MB)

20 B+ models are deferred to a future Power Mode / 5090 branch. See `06-V1.0-LOCKDOWN.md`.

### Stack (locked, no substitutions for v1.0)

- Next.js 14 (App Router) + TypeScript + Tailwind v3 + shadcn primitives (Radix) + Zustand + Framer Motion + Ollama
- **No Chroma.** Phase 1 decision: in-memory cosine until chunk count exceeds ~50k.

---

## HISTORICAL — Original Friday v1 scope-lock (preserved verbatim)

> This was the build-sprint scope as captured during the original H-phase work. Several items here either landed differently (Cipher dropped, Chroma rejected) or were re-prioritized across phases. Kept for audit trail; the CURRENT section above is the authoritative v1.0 scope.

### SHIP
- Chat with streaming via Ollama
- 4 personas: Bartimaeus (live), Juniper, Sage, Bobby
- Animated eye, dark premium UI
- Retrieval over seed docs with inline citations
- HUD: model, latency, tokens/sec, persona, retrieval, GPU/CPU, USB path, network status
- Truth-default reasoning (confidence + citations)
- Settings (model swap, persona default)
- Cross-platform launcher (Windows + macOS minimum)
- GPU detection + auto model selection

### STUB (UI present, labeled "v2")
- Vision tab, Voice button, Memory tab
- Workspace switcher (Operator only active)
- Vault management UI (drop-zone works, full mgmt later)

### CUT (do not build)
- Real voice, real vision
- State engine, ambient modes
- Easter eggs, ring activation
- Encryption at rest
- Tool system, multi-workspace

### Stack (locked, no substitutions)
Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui + Zustand + Framer Motion + Ollama + ChromaDB + nomic-embed-text

> ChromaDB ended up rejected — see `methodology/decisions.md` "no Chroma" entry. Voice ended up shipping as a scaffold (binaries operator-supplied). Vision and Memory remain stubs as planned.

### Hardware Targets (original)
- ThinkPad Ryzen 7, 16GB RAM, 2GB integrated GPU, Win 11 → CPU mode, qwen2.5:3b-instruct-q4_K_M
- Gaming PC, 64GB RAM, RTX 3060 → GPU mode, llama3.1:8b-instruct-q4_K_M
- Auto-detect at launch, transparent HUD labeling of mode + reason

> Phase 1.5 measurement updated this — see CURRENT section. The qwen2.5:3b model was flagged for degenerate-token output under memory pressure and is no longer in the v1.0 roster.
