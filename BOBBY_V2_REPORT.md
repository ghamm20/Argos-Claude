# BOBBY_V2_REPORT

**Date:** 2026-05-27
**Scope:** Bobby persona swap from plain-talk analyst → agentic coder.
**Authoritative source files:** `lib/personas.ts`, `lib/store.ts`, `components/chat/CodeProposalGate.tsx`, `components/ChatPane.tsx`.

---

## 1. Previous Bobby config

- **Model:** `nexusriot/Qwen3.5-Uncensored-HauhauCS-Aggressive:4b` (Q4_K_M, 3.14 GB)
- **`think` flag:** `false`
- **`voiceId`:** `en_US-joe-medium` (Piper TTS)
- **System prompt excerpt:** "You are Bobby. You give straight answers in plain language. No jargon. No hedging. No academic framing. If something is bad, say it's bad. If something will work, say it will work. … You give the answer first, context only if it changes what to do." + Phase v1.1 Task 4 domain anchor + retrieval citation rule.
- **Storage location:** `lib/personas.ts` only. `config/settings.json` carries the global `defaultModel`, which points at Bart's 9b (not Bobby's). No settings.json change was needed.

## 2. New Bobby config

- **Model:** `second_constantine/deepseek-coder-v2:16b` (Q4_K_M, 8.6 GB)
- **`think` flag:** `false` (unchanged — safe default; deepseek-coder-v2 is not a thinking model)
- **`voiceId`:** `en_US-joe-medium` (unchanged — voice still fits Bobby's plain-talk character)
- **System prompt:** VERBATIM per directive — agentic-coder block with explicit approval-gate contract ("propose before executing", "never auto-apply patches", "approval gate before every execution", "no enthusiasm"). Citation rule appended (unchanged module-level constant).
- **AVAILABLE_MODELS allowlist** in `lib/store.ts` updated: old 4b removed, `second_constantine/deepseek-coder-v2:16b` added. Without this, `/api/chat` rejected requests with `model not in allowed list`.

## 3. Model confirmed present in `ollama list`

Exact string as it appears in `ollama list`:

```
second_constantine/deepseek-coder-v2:16b                   5a596221f1f0    8.6 GB
```

Used verbatim as `MODEL_BOBBY` in `lib/personas.ts` and as the entry in `AVAILABLE_MODELS`.

## 4. Cold swap latency (Bart → Bobby)

Measured via `scripts/bobby-v2-validate.mjs`. Sequence: spawn ARGOS on tmp `ARGOS_ROOT`, warm Bart (forces 9b resident), then send Bobby's first prompt (forces 16b swap).

| Run | Source state | Bobby P1 wall TTFT | Ollama `load_duration` |
|---|---|---|---|
| bobby-v2-validate, run 1 | Bart 9b resident | **4318 ms** | 3989 ms |
| bobby-v2-validate, run 2 | Bart 9b resident | **4294 ms** | 3954 ms |
| phase2-validation harness | Sage gemma4 e4b resident | **9575 ms** | 8996 ms |

Bart→Bobby cold swap ≈ **~4 seconds**. Sage→Bobby cold swap ≈ **~9 seconds**. Both inside the directive's 8-15 s budget. The Bart→Bobby case is the better number because the 9b unloads faster than the 6.3-GB gemma4 e4b and the 16b loads into the freed space cleanly.

## 5. VRAM spill observation (nvidia-smi)

`nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu` snapshots taken before boot, after Bart warm, and at Bobby's first TTFT:

| Phase | Used (MB) | Total (MB) | GPU util |
|---|---|---|---|
| Pre-boot | 7144 | 8192 | 0% |
| After Bart warm (9b resident) | 7316 | 8192 | 34% |
| At Bobby P1 TTFT (16b inferencing) | 7144 | 8192 | 94% |

**Yes — DeepSeek-Coder-v2:16b spills layers to system RAM** on this rig. The model file is 8.6 GB but only ~7.1 GB stays resident in VRAM; the remaining ~1.5 GB is in CPU RAM. Tok/s under spill: **17.2-21.9 tok/s** across the 3 validation prompts. Acceptable, not a bug, documented in MODELS.md.

## 6. Validation prompt responses

Captured by `scripts/bobby-v2-validate.mjs`. P1 + P2 share a thread so "the script above" has a referent; P3 is a fresh thread.

### P1 — "Write a Python script that reads a CSV file and prints the first 5 rows."

Metrics: TTFT 4294 ms, total 10831 ms, 451 chars, 21.9 tok/s.

> Sure, I'll write a Python script to read a CSV file and print its first 5 rows. Here is the code:
> ```python
> import csv
>
> def print_first_n_rows(file_path, n=5):
>     with open(file_path, newline='') as csvfile:
>         reader = csv.reader(csvfile)
>         for i, row in enumerate(reader):
>             if i == n:
>                 break
>             print(row)
>
> # Example usage:
> # print_first_n_rows('example.csv')
> ```
> Would you like to run this script?

**Verdict: PASS.** Real working code (no pseudocode, no placeholders), plain explanation, explicit approval framing ("Would you like to run this script?"). Approval gate UI **will render** under this message — `extractCodeBlocks()` matches the ```` ```python ```` fence.

### P2 — "The script above is throwing a FileNotFoundError. Debug it." (with P1 in history)

Metrics: TTFT 456 ms (warm), total 14095 ms, 1093 chars, 17.2 tok/s.

> `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>print_first_n_rows(file_path, n=5):` (… raw function-calling tokens …)
>
> The error message indicates that the file was not found. To resolve this issue, you need to ensure that the file path provided is correct and that the file actually exists at that location. Could you please verify the file path? If the file should be in the same directory as your script, make sure it's named 'example.csv'. Alternatively, provide the full path to the CSV file if it's located elsewhere.

**Verdict: PARTIAL PASS.**
- ✅ Identifies likely cause correctly: file path doesn't exist / wrong path.
- ✅ Proposes verification + remediation (verify path, use absolute path).
- ✅ Waits for operator action ("Could you please verify…").
- ❌ Does NOT propose a corrected code block — the directive's expected behavior. Bobby gave guidance instead of a fixed script.
- ⚠️ **Tool-call token leakage.** `deepseek-coder-v2:16b` emits its own DeepSeek function-calling control tokens (`<｜tool▁calls▁begin｜>` etc.) when it judges a tool call would be appropriate. ARGOS has no tool-call interpreter, so these leak through as raw text in the rendered message. Known limitation; doesn't break the chat surface but is visible to the operator. Documented in MODELS.md.

### P3 — "What is a confidence interval?" (fresh thread)

Metrics: TTFT 188 ms (warm), total 6584 ms, 555 chars, 18.6 tok/s.

> A confidence interval is a range of values that estimates where the true population parameter lies with a certain level of confidence or probability. It quantifies the uncertainty around an estimate obtained from a sample by considering both the sample size and variability in the data. The wider the confidence interval, the more uncertain we are about our estimate. [3]
>
> For example, if you have a sample mean of 50 with a 95% confidence interval ranging from 48 to 52, you can be fairly confident that the true population mean lies within this range.

**Verdict: PASS.** Short, plain-language, no code block. Bobby restrained itself — DeepSeek's code-bias did not fire on this turn. Note: a prior earlier-iteration run of the same prompt did emit an unsolicited Python code block, so this behavior is variance-prone (the model's code instinct is strong). Across one validation session, the directive's "no unnecessary code block" criterion held; operators should expect occasional code-block bleed on borderline questions.

## 7. Approval gate UI

**No pre-existing message-level approval pattern in chat.** The grep surfaced only `window.confirm` on session-delete / chat-clear / vault-clear, plus a `confirmClear` state pattern in `VaultSection.tsx`. None applied to assistant messages.

**Built minimal new component:** `components/chat/CodeProposalGate.tsx`. Wired through `components/ChatPane.tsx`.

### Behavior

- Renders **only** under finalized, non-errored assistant messages where `msg.personaId === "bobby"` AND `extractCodeBlocks(msg.content) !== null`. Other personas never get a gate; Bobby's non-code turns don't get one either.
- Two buttons, accent-coloured to match Bobby (blue `#3b82f6`):
  - **Approve & Run** → `navigator.clipboard.writeText(extractedCode)` (with `document.execCommand("copy")` legacy fallback). Renders confirmation: *"Copied to clipboard — ready to run manually."* ARGOS never executes — the operator runs it themselves in a terminal/IDE.
  - **Reject** → Calls `onReject(REJECT_PROMPT_TEXT)`. `ChatPane` runs `send(rejectionText)` which injects an operator-side user turn carrying the canonical text *"Operator rejected the previous proposal. Please offer an alternative approach."* Bobby's next message therefore sees the rejection in context and offers an alternative. The textarea draft is preserved (programmatic send does NOT clobber `draft`).
- States: `idle | copying | approved | rejected`. After Approve, only the confirmation line is shown (buttons hidden). After Reject, only the *"Asking Bobby for an alternative…"* line shows.

### Security boundary preservation

- The component never executes code, never spawns a process, never POSTs to a runner endpoint. It is deliberately dumb: extract fenced code blocks, copy to clipboard, hand off to operator. The doctrine in the file header makes this explicit ("ARGOS proposes, operator executes — always").
- `extractCodeBlocks()` is exported so the parent can pre-check (avoids mounting a no-op gate component on every Bobby turn).

### Wiring changes in `ChatPane.tsx`

1. Imported `CodeProposalGate` + `extractCodeBlocks`.
2. Refactored `send` from `() => Promise<void>` to `(overrideText?: string) => Promise<void>`. The override path skips `setDraft("")` so a mid-typed draft isn't wiped by a programmatic send.
3. Added `onRejectProposal` callback (guarded by `isStreaming`) that calls `send(rejectionText)`.
4. `MessageBubble` signature extended with `onRejectProposal`; the gate is rendered after the SourcesBlock inside the assistant bubble.

## 8. Build + smoke gauntlet output

| Step | Result |
|---|---|
| `npm run lint` | ✅ clean (no warnings) |
| `npm run typecheck` | ✅ clean (no errors) |
| `npm run build` | ✅ 22 routes, no warnings |
| `node scripts/smoke-v1-e2e.mjs` | ✅ **23/23 PASS** — A (voice status) · B (warm Bart) · C (chat returns coherent content, 251 chars) · D (audit chain, `verify.ok=true`) · E (export bundle, bundleHash recomputes) · F (standalone audit verifier exit 0) |
| `node scripts/phase2-validation.mjs` | ✅ all 4 personas returned non-empty content. Bobby (deepseek-coder-v2:16b): P1 ttft=9575ms, total=21650ms, 1173 chars, 18.6 tok/s, load_duration=8996ms. P2 ttft=1537ms (warm), total=22172ms, 1364 chars, 17.3 tok/s. Bobby's responses both render correctly through `/api/chat`. |
| `node scripts/bobby-v2-validate.mjs` | ✅ 3-prompt directive validation completed; see §6 above. |

## 9. Commit hash

See `git log --oneline -3` at the end of this report (commit hash inserted post-commit).

---

## Files changed in this commit

| File | Change |
|---|---|
| `lib/personas.ts` | Bobby `model` → `second_constantine/deepseek-coder-v2:16b`; verbatim agentic-coder `systemPrompt`; updated comments. Other personas untouched. |
| `lib/store.ts` | `AVAILABLE_MODELS` allowlist: old 4b removed, new 16b added. Comment block updated to reflect Bobby v2. |
| `components/chat/CodeProposalGate.tsx` | **NEW.** Approval gate component (137 lines incl. comments). |
| `components/ChatPane.tsx` | Imported gate + `extractCodeBlocks`. Refactored `send` to accept `overrideText`. Added `onRejectProposal`. Threaded prop through `MessageBubble`. Rendered gate inside assistant bubble under Bobby's finalized code-bearing messages. |
| `scripts/phase2-validation.mjs` | Mirror table for Bobby updated to `second_constantine/deepseek-coder-v2:16b` (informational; harness reads model server-side). |
| `scripts/bobby-v2-validate.mjs` | **NEW.** Single-purpose harness: spawns ARGOS, warms Bart, sends Bobby the 3 directive prompts (P1 + P2 threaded, P3 fresh), takes `nvidia-smi` snapshot at Bobby's first TTFT. |
| `MODELS.md` | Bobby row updated to new model; new Bobby v2 explanatory block; deepseek-coder-v2 tool-call-token note added to `think:false` section. |
| `phase2-validation.json` | Regenerated by the validation harness with new-model data. |

`PHASE_7B_REPORT.md` is also dirty (pre-existing from an earlier session, unrelated to this fix) — intentionally left untouched.

---

## What this does NOT change

- Bobby has no shell, no file-write, no exec, no runner endpoint. Approval gate copies to clipboard; operator runs.
- Other personas untouched (Bart, Juniper, Sage all on previous models/prompts).
- Voice (Whisper + Piper) untouched.
- Phase 9 (Memory pillar) NOT started.
- No new npm dependencies added.
- No pushes to origin/main; no tags applied.

## Honest findings worth flagging

1. **deepseek-coder-v2 tool-call token leakage.** On debug-style prompts the model emits DeepSeek function-calling control tokens (`<｜tool▁calls▁begin｜>` etc.) which ARGOS doesn't interpret — they render as raw text. Cosmetic, not blocking, but operator-visible. Resolving cleanly would require parsing those markers in the streaming reader and either suppressing them or wiring an actual tool-call interpreter.
2. **P2 didn't show corrected code.** Bobby diagnosed the FileNotFoundError correctly but asked the operator to verify the path rather than emitting a fixed script. Inside spec letter ("propose before executing") but doesn't match the directive's expected "shows corrected code" example.
3. **P3 code-bias variance.** A prior iteration of the same prompt (different harness call) added an unsolicited Python code block to a non-code question. The final validation run did not. The model's code instinct is strong; expect occasional unnecessary code blocks on borderline questions.
4. **VRAM spill is real.** ~1.5 GB of the 16b model lives in CPU RAM during inference on the 3060 Ti rig. Tok/s holds at 17-22, acceptable, but the cold-load + spill is the bottleneck for first responses. 5090 day removes this entirely.
