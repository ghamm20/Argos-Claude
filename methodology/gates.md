# Verification Gates Log

| Hour | Gate | Pass/Fail | Notes |
|------|------|-----------|-------|
| H1   | scaffold compiles + dev boots at :3000 | PASS | `Ready in 2.7s`, three-pane HTML renders with all markers |
| H1.5 | verify-argos harness self-test (5 rules, injected violations) | PASS | All 5 rules caught violations on the deliberate fixture; reverted; clean pass on real code |
| H2   | `/api/chat` error-path smoke (Ollama-down 503, bad persona 400, empty msgs 400, invalid JSON 400) | PASS | All four error paths returned the expected status + honest body |
| H2   | `npm run check` post-implementation | PASS | lint + typecheck + build + verify all clean |
| H3.CP1 | Ollama installed, daemon up, three models pulled | PASS | nomic-embed-text 274 MB, qwen2.5:3b 1.9 GB, llama3.1:8b 4.9 GB — total ~7.1 GB on disk |
| H3.CP2 | live-Ollama chat smoke (llama3.1:8b cold) | PASS | 36 tokens, 35.07 tok/s, 0 NDJSON parse errors. Cold TTFT 46.5s (one-time model load) |
| H3.CP3 | `npm run check` post-vault | PASS | All 5 routes registered as dynamic, bundle / = 132 kB |
| H3.CP4 | vault ingest+retrieve smoke against doctrine doc | PASS | top-1 hit (score 0.4715) contains "path" and "relative"; assertion held |
| H3.CP5 | eyes-on H1+H2+H3 via Claude_Preview browser | PARTIAL | All DOM/state checks passed. Animations + CSS transitions UNVERIFIED — preview Electron suppresses them. See methodology/eyes-on-h1-h2-h3.md. |
| H4 | shadcn/tailwind v3 resolution + Button primitive renders | PASS | Stripped shadcn 4 + @base-ui/react + tw-animate-css. Added @radix-ui/react-slot + react-dialog. Button cva variants resolved against new HSL theme tokens. |
| H4 | retrieval injected into chat route, retrieval event emitted | PASS | curl smoke: 56-line stream, 1 hit returned, response semantics correct. |
| H4 | citation pills render, drawer opens on click | PASS | Live browser drive: [1] pill rgb(16,185,129), drawer shows filename / chunk #0 / score 0.481 / full text. |
| H4 | Truth Mode toggle + prompt enrichment | PASS | Off-mode: declarative. On-mode: explicit "I don't know", hedging, "doesn't explicitly cover all possible use cases." |
| H4 | smoke-retrieval.mjs assertions | PASS | retrieval event present, ≥1 hit, response mentions path/relative, truth-mode hedge count non-decreasing. |
| H4 | npm run check post-H4 | PASS | All five rules pass; lint + typecheck + build green; 5 dynamic routes + 1 static. |
| H4 | eyes-on H4 via Claude_Preview | PASS (with same animation caveat) | See methodology/eyes-on-h4.md. Off-topic question yielded honest "no access" without fake citations. |
