# Scope Lock — Friday v1

## SHIP
- Chat with streaming via Ollama
- 4 personas: Bartimaeus (live), Juniper, Sage, Bobby
- Animated eye, dark premium UI
- Retrieval over seed docs with inline citations
- HUD: model, latency, tokens/sec, persona, retrieval, GPU/CPU, USB path, network status
- Truth-default reasoning (confidence + citations)
- Settings (model swap, persona default)
- Cross-platform launcher (Windows + macOS minimum)
- GPU detection + auto model selection

## STUB (UI present, labeled "v2")
- Vision tab, Voice button, Memory tab
- Workspace switcher (Operator only active)
- Vault management UI (drop-zone works, full mgmt later)

## CUT (do not build)
- Real voice, real vision
- State engine, ambient modes
- Easter eggs, ring activation
- Encryption at rest
- Tool system, multi-workspace

## Stack (locked, no substitutions)
Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui + Zustand + Framer Motion + Ollama + ChromaDB + nomic-embed-text

## Hardware Targets
- ThinkPad Ryzen 7, 16GB RAM, 2GB integrated GPU, Win 11 → CPU mode, qwen2.5:3b-instruct-q4_K_M
- Gaming PC, 64GB RAM, RTX 3060 → GPU mode, llama3.1:8b-instruct-q4_K_M
- Auto-detect at launch, transparent HUD labeling of mode + reason
