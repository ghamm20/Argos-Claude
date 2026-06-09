# ARGOS — Principal-Engineer Scope Review

**Reviewer:** Claude Fable 5 (Claude Code session)
**Date:** 2026-06-09
**Mode:** Recon-only. No code changes, no pushes, no new deps.
**Source of truth:** disk + git at `C:\Users\Gordy\dev\Argos-Claude`, HEAD `c3dce6f`.
**Method:** Every claim below is grep/read/git-verified. Claims that failed verification are called out explicitly. Negatives are not softened.

---

## 0. Verdict up front

The scope document is **substantially accurate on architecture, git state, and the integrity machinery**, but its **persona/model table (§1.2) is wrong on two of four personas** and it carries one **self-contradiction** about Bart's model. The codebase itself is in good shape: the integrity guards are real and provably run on *both* inference paths, the file_ops boundary is correctly enforced twice, and secrets are masked on egress. The single largest *unflagged* security consideration is **cloud data egress on the Nous path** — when a persona is set to the Nous backend, the entire assembled system prompt (operator memory, vault chunks, prior tool results) leaves the box. That is correct behavior for cloud inference, but it is the headline confidentiality fact for a system branded "local-first / USB-native," and it is not surfaced in the document.

---

## 1. Document verification

### 1.1 Confirmed TRUE

| Claim | Evidence |
|---|---|
| HEAD `c3dce6f` == origin/main, tree clean | `git status -sb` → `## main...origin/main`, no pending |
| Tag `v2.4.2` → `af28800` (behind HEAD) | `git rev-list -n1 v2.4.2` = `af28800…` |
| `package.json` version `2.4.2` | `require('./package.json').version` = `2.4.2` |
| `v1.0.0` == `d8c1750` | `git rev-list -n1 v1.0.0` = `d8c1750…` |
| Commit `5a335b9` = requireValidSession auth gate, BART audit 2026-06-04 | `git log -1 5a335b9` exact message match |
| `RETIRED_DEFAULT_MODELS` self-heal in `lib/settings.ts` | [lib/settings.ts:242-250](lib/settings.ts) — set + `normalizeDefaultModel` |
| `requireValidSession` exists in `lib/auth.ts` | [lib/auth.ts:152-187](lib/auth.ts) |
| INTEGRITY DOCTRINE prepended to EVERY persona | [lib/personas.ts:131](lib/personas.ts) def; applied at lines 230, 388, 410, 441 (all four personas) |
| file_ops custom text format + ARGOS_ROOT path bounding | [lib/tools/file-ops.ts](lib/tools/file-ops.ts) + [lib/tools/fs-guard.ts:15-27](lib/tools/fs-guard.ts) `resolveWithinRoot` |
| Nous path sends full system prompt incl. tool-awareness block | [app/api/chat/route.ts:949-954](app/api/chat/route.ts) passes `ollamaMessages` (index 0 = `systemPrompt`) to `callNous` |
| Juniper → `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b` | [lib/personas.ts:166](lib/personas.ts) `MODEL_JUNIPER` |
| Bobby → `CyberCrew/notmythos-8b:latest` | [lib/personas.ts:184](lib/personas.ts) `MODEL_BOBBY` |

### 1.2 Confirmed FALSE — flag these

**(F1) §1.2 "Bartimaeus → `royhodge812/Orchestrator:latest`" — WRONG.**
Actual: `MODEL_BART = "aratan/gemma-4-E4B-q8-it-heretic:latest"` ([lib/personas.ts:165](lib/personas.ts)). Orchestrator is explicitly *retired* from the default slot ([lib/settings.ts:242-245](lib/settings.ts)). The document **contradicts itself**: §1.1 (the v2.3.7 row) correctly records "Bart: royhodge812/Orchestrator → aratan/gemma-4… in v2.3.2", then §1.2 re-asserts Orchestrator as "locked." The code agrees with §1.1, not §1.2.

**(F2) §1.2 "Sage → `alfaxad/wild-gemma4:e4b`" — WRONG.**
Actual: `MODEL_SAGE = "aratan/gemma-4-E4B-q8-it-heretic:latest"` ([lib/personas.ts:178](lib/personas.ts)). The v2.3.11 code comment ([lib/personas.ts:168-177](lib/personas.ts)) documents *why*: `wild-gemma4:e4b` was never installed, and on pull it **crashed llama-server every generation** (`GGML_ASSERT(ggml_can_repeat)` → `0xc0000409`) and is semantically a JSON-only fine-tune. It was rebound to gemma-4. So §1.2's "(locked)" table lists a model that is known-broken and unused.

**(F3) Orchestrator tag string.** Where Orchestrator *is* referenced, the real upstream tag is `:lates` (no trailing `t`) — see [lib/personas.ts:99-101](lib/personas.ts) and both entries in `RETIRED_DEFAULT_MODELS`. §1.2's `:latest` is doubly wrong (wrong persona binding *and* wrong tag).

### 1.3 Confirmed IMPRECISE — accurate in spirit, wrong in specifics

**(I1) §1.1 v2.4.1: "Removed 3 non-functional auth gates (tools/approve, tools/execute, orchestrator)."**
The added-then-removed gates (commit `5a335b9`) were on **settings, tools/execute, tools/approve** — *not* orchestrator. Today **no route invokes `requireValidSession` as a live gate**; the only reference is a *comment* in [app/api/orchestrator/route.ts:9-12](app/api/orchestrator/route.ts) explaining it is intentionally not gated. The function is retained/exported for a future Operator-Auth phase ([lib/auth.ts:152](lib/auth.ts)). Net effect the document describes (gates are non-functional / removed, real boundary is `/api/chat`) is **correct**; the specific endpoint list is muddled. This matches the handoff gotcha "#6 Settings POST is intentionally ungated."

**(I2) §1.2 calls the model table "(locked)".** Given F1/F2 it is not a reliable lock; treat [lib/personas.ts](lib/personas.ts) `MODEL_*` constants as the only authority.

### 1.4 Not independently re-verified (out of static-recon scope)

`check:full` 11/11 green, ParaScope 91/91, audit-log turn counts (6/8 Nous), F5-TTS window timings, MiroFish/Oculus runtime claims — these are runtime/observational and were **not** re-run here. Flagged as unverified, not as wrong.

---

## 2. Security review

### (a) v2.4.1 auth-gate removal — was anything load-bearing removed?
**No.** The removed gates were provably non-load-bearing and actively harmful:
- `requireValidSession` only enforces when `requirePin === true` **and** a PIN hash is configured ([lib/auth.ts:173](lib/auth.ts)). Out of the box neither holds, so it was always a pass-through.
- When it *was* wired to POST `/api/settings` (commit `5a335b9`) it created a **bootstrap deadlock**: the PIN hash is written *through* `/api/settings`, so gating that endpoint made it impossible to ever turn auth on, and bricked every settings save (no client attaches a bearer token except `/api/chat`). This is documented in-line at [app/api/settings/route.ts:94-108](app/api/settings/route.ts). Removing it restored function without lowering a real boundary.
- The genuine boundary — guest vs. operator system prompt + memory suppression — lives in `/api/chat` and is intact ([lib/personas.ts:72-84](lib/personas.ts) `guestSystemPrompt`).

**Residual:** `requireValidSession` is dead-but-exported. Low risk, but it is a loaded gun for a future dev who re-wires it to `/api/settings` and reintroduces the deadlock. The orchestrator comment is the only guardrail against that.

### (b) `/api/settings` vault exposure
**Well-handled.** GET masks every secret — `apiKeys.github`, `elevenlabs.apiKey`, and `nousApiKey` are each replaced with `{configured, hint}` via `maskSecret`, never the ciphertext ([app/api/settings/route.ts:15-46](app/api/settings/route.ts)). POST encrypts secrets at rest before storage (`encryptSecret`) for github/elevenlabs/nous keys ([route.ts:330,354,418](app/api/settings/route.ts)) and validates types/enums on every field. **The exposure is that POST is unauthenticated** (by design — see 2a). On `127.0.0.1` single-operator that is the accepted threat model, but anything that can reach the loopback port (a malicious local process, a misconfigured Tailscale ACL exposing `100.82.169.101:7799`) can read non-secret settings and *write* settings — including flipping `inferenceBackend` to `nous` or changing `defaultModel`. Secrets stay confidential (masked on GET, write-only on POST), but **configuration is fully writable by any loopback/Tailnet caller.** Flag for the Tailscale-remote use case.

### (c) file_ops path-bounding bypass vectors
**Strong.** `resolveWithinRoot` resolves against `path.resolve(argosRoot())` and rejects any path whose `path.relative(root, abs)` is `..`, starts with `..` + sep, or is absolute ([lib/tools/fs-guard.ts:23](lib/tools/fs-guard.ts)). This correctly defeats `../` traversal, absolute paths, and `dest` on `move`. The check runs **twice** — in `validate()` (pre-approval) and again at execute time via `resolveWithinRoot(...).abs` ([lib/tools/file-ops.ts:31,67,94](lib/tools/file-ops.ts)). write/move/delete are approval-gated; delete creates a restore point first, refusing the action if the snapshot fails ([lib/tools/executor.ts:144-155](lib/tools/executor.ts)).
**Caveats worth noting (not bugs, but boundary edges):**
- The boundary is *lexical*, not `realpath`-based. A pre-existing **symlink inside ARGOS_ROOT pointing out** would let a read/write follow it past the boundary. On a USB-native NTFS payload symlinks are unlikely, but `realpath`-resolution would close it definitively.
- `argosRoot()` is the trust anchor; if it is ever derived from an attacker-influenced env var, the whole boundary moves. (Doctrine Rule 1 covers this — it derives from `ARGOS_ROOT`.)

### (d) Injection surface of the custom `<tool>` text format
**This is the most important pre-email finding.** `parseToolCalls` was hardened (v2.3.8) to scan the *entire* assistant reply for any `{"id":"<registered_tool>","params":{…}}` JSON **regardless of wrapper** ([lib/tools/chat-tools.ts:83-122](lib/tools/chat-tools.ts)). That fixed a real fabrication bug, but it means: **if model output ever contains a tool-shaped JSON blob, it is treated as a call.** The realistic injection chain is *indirect prompt injection*: a retrieved vault chunk, a web_search result, or a file_ops read returns attacker-authored text containing a literal `<tool>{"id":"file_ops","params":{"operation":"delete",...}}</tool>`; the model echoes/reflects it; the parser executes it.
**Why it is currently contained (defense-in-depth that holds):**
1. **One tool per turn** — only `calls[0]` runs ([route.ts:1285-1286](app/api/chat/route.ts)).
2. **Persona scoping** — a call outside the persona's subset is denied and audited ([route.ts:1292](app/api/chat/route.ts), [lib/persona-tool-subsets.ts:29](lib/persona-tool-subsets.ts)).
3. **Approval gate** — every dangerous op (write/move/delete/shell/send) requires explicit operator approval ([lib/tools/executor.ts:98-116](lib/tools/executor.ts)); the operator sees the disclosed params.
**The risk the email phase introduces:** an `email_send` tool makes exfiltration a *one-approval* action, and approval fatigue is real. Recommendation: keep email send approval-gated like file_ops write, show the full recipient+body in the disclosure, and consider an allowlist of recipient domains. Do **not** let the cloud (Nous) path auto-approve anything.

### (e) Nous cloud path — what leaves the box per turn
**The headline.** When `resolveBackend` returns `"nous"` for a persona, `callNous` is sent `ollamaMessages` whose index 0 is the **fully assembled `systemPrompt`** ([route.ts:908,949-954](app/api/chat/route.ts)). That prompt (`systemParts.join`, [route.ts:737-871](app/api/chat/route.ts)) can include:
- the INTEGRITY DOCTRINE + persona character,
- the **tool-awareness block** (full tool list + capabilities),
- **recent tool results** — which may contain file contents from a prior file_ops read or scraped web pages ([route.ts:744](app/api/chat/route.ts)),
- the **cross-session memory block** — operator personal facts ([route.ts:840-842](app/api/chat/route.ts)),
- **vault retrieval chunks** — potentially sensitive documents ([route.ts:846-847](app/api/chat/route.ts)),
- the full conversation thread.

All of that egresses to `https://inference-api.nousresearch.com` ([lib/inference-backend.ts:30-31](lib/inference-backend.ts)). The API key is correctly never logged ([inference-backend.ts:111](lib/inference-backend.ts)), vision turns stay local ([route.ts:939](app/api/chat/route.ts)), and failures fall back silently to local — all good. But the confidentiality fact stands: **operator memory and vault documents leave the machine the moment a persona is on the Nous backend.** Memory injection is suppressed in *guest* mode ([lib/personas.ts:77-83](lib/personas.ts)), but in operator mode + Nous it is in scope. This deserves an explicit operator-facing warning in the Inference UI ("API backend sends your memory + retrieved documents to Nous Research") and, ideally, a per-persona "never send vault/memory to cloud" guard before the agentic phase ships.

---

## 3. Integrity-doctrine audit — do the three guards run on BOTH paths? (tested by data flow, not just read)

**Yes — confirmed by the data path, which is the strongest static proof available.**

The Nous answer is *not* a parallel code path. `callNous` returns text, which is wrapped by `makeSyntheticReader` into an Ollama-shaped NDJSON stream — `{message:{content},done:false}` then `{done:true}` ([route.ts:249-263](app/api/chat/route.ts)). The single `reader` is then *either* the synthetic Nous reader *or* the live Ollama stream ([route.ts:1152-1154](app/api/chat/route.ts)). From that point **one** pipeline runs for both backends:

1. `accumulateContent` → `assistantBuf` ([route.ts:1169-1201](app/api/chat/route.ts))
2. **Parser hardening** — `parseToolCalls(assistantBuf)`; every parse failure is audited via `appendParseFailureAudit` and surfaced ([route.ts:1258-1284](app/api/chat/route.ts))
3. **Structural integrity guard** — `evaluateIntegrity(assistantBuf, …)`; violation → warning appended to the answer + `appendIntegrityViolation` forensic record ([route.ts:1403-1433](app/api/chat/route.ts))
4. **Misrepresentation guard** — `detectMisrepresentation(assistantBuf, negatives)` ([route.ts:1446-1467](app/api/chat/route.ts))

The in-code comment at [route.ts:1148-1151](app/api/chat/route.ts) asserts this ("the Nous response goes through the same integrity evaluation"), and the data flow **confirms** it — there is no branch that skips guards for Nous. The guards operate purely on `assistantBuf`, which is backend-agnostic.

**One real gap:** the guards are *post-hoc text classifiers* on the model's output. They catch fabricated tool-result claims and softened negatives, but they do **not** validate that a *correctly-formatted* tool call was semantically appropriate, and they cannot see native OpenAI `tool_calls` (which ARGOS does not read — see §4). So a cloud model that emits a native function call instead of the `<tool>` text format produces output that the guards see as a plain (toolless) answer — no fabrication is flagged because none is claimed in text, but the tool also never runs. That is the exact Nemotron malform the handoff describes, and it is a *capability* gap, not an *integrity* gap.

---

## 4. Architecture fork — custom `<tool>` text format vs. native OpenAI tool-calling on the Nous path

### The evidence
- The whole tool system is built on the custom text format: parser ([chat-tools.ts:83](lib/tools/chat-tools.ts)), awareness block ([chat-tools.ts:223](lib/tools/chat-tools.ts)), integrity guards keyed off text patterns ([route.ts:1403,1448](app/api/chat/route.ts)), persona scoping, approval governance ([executor.ts](lib/tools/executor.ts)). It is format-agnostic about *who* emits the text — local or cloud — so a tool-trained **local** model (hermes3/qwen3) drops in with zero wiring change.
- The Nous path is a single non-streamed POST that today sends only `{model, messages, max_tokens, stream:false}` ([inference-backend.ts:114-124](lib/inference-backend.ts)). It does **not** send a `tools` array and does **not** read `choices[].message.tool_calls`. Nemotron, an OpenAI-API model, is biased toward native function-calling, so it emits `tool_calls` (which ARGOS ignores) or a malformed text imitation. That is the root cause — confirmed: the wiring sends the format correctly; the model just doesn't use it.

### Argue both sides

**Keep the custom text format (+ a tool-reliable local model):**
- *For:* one format, one parser, one integrity surface. The guards, scoping, audit, and approval queue all already key off the text format. Adding a native path forks every one of those — you'd need integrity guards that understand structured `tool_calls`, a second audit shape, and a second approval disclosure path. The handoff's own ranking (hermes3 > qwen3) means a clean local emitter likely solves the *local* reliability problem outright with no architecture change.
- *Against:* it permanently caps cloud-model tool reliability. You are fighting every frontier model's training (they're tuned for native function-calling). It also wastes Nemotron's actual strength.

**Add native OpenAI tool-calling on the Nous path only:**
- *For:* makes cloud models tool-reliable *as designed* — pass `tools: [...]`, read `tool_calls`, map back into the existing `requestTool(...)` governance. Best path quality for the cloud tier.
- *Against:* a real fork. You must (1) translate the registry into OpenAI tool schemas, (2) read/normalize `tool_calls` back into `{id, params}`, (3) **re-point the integrity guards** — they currently inspect text, and a native call produces *no* `<tool>` text, so `evaluateIntegrity`/`detectMisrepresentation` would need a structured-call awareness or they'll mis-classify. Streaming also changes (tool_calls typically need the non-streamed or delta-assembled path). And it only helps the cloud tier, which is the *fallback* tier in a local-first product.

### Recommendation
**Do both, in order, but gate the second on need:**
1. **First, fix the local tier with a tool-trained model** (the handoff's hermes3/qwen3 test). This is zero-architecture-change, keeps the integrity surface singular, and is the on-doctrine ("local-first") path. Make the cleanest emitter the default for the tool-using personas (Bart, Bobby). This very likely closes the *operational* gap (file_ops → tasks → email) without touching the cloud fork.
2. **Defer the native-OpenAI Nous path** to a contained, clearly-bounded change *only if* you specifically need cloud-tier tool calling. When you do it, treat it as a parallel adapter: translate registry→OpenAI schema, normalize `tool_calls`→`{id,params}`, route through the **same** `requestTool` governance, and **extend the integrity guards to recognize a structured call as a real tool invocation** (so a native call isn't seen as a toolless answer). Keep it Nous-only; never let it bypass approval.

Rationale: the integrity doctrine is ARGOS's spine and it is text-keyed. Forking the emission format forks the spine. Solve the immediate need on the side that doesn't fork it (local model swap), and only pay the fork cost where it buys something the local tier can't.

---

## 5. Top 10 risks, ranked by blast radius

| # | Risk | Blast radius | Evidence | Mitigation today |
|---|---|---|---|---|
| 1 | **Cloud egress of memory + vault on Nous backend** — operator personal facts and retrieved documents leave the box per turn | Confidentiality of all operator data; breaks the "local-first" guarantee | [route.ts:840-847,949-954](app/api/chat/route.ts) | Vision-only stays local; **no** warning or per-persona vault/memory cloud-guard. Add both before agentic phase. |
| 2 | **Indirect prompt injection → tool execution** via retrieved/web/file text reflected as a `<tool>` blob | Any tool the active persona holds (incl. file_ops delete, shell_exec) | [chat-tools.ts:83-122](lib/tools/chat-tools.ts) | Contained by 1-tool/turn + persona scope + approval gate; tightens to critical once email_send lands |
| 3 | **`shell_exec` held by Bobby** on a model that malforms calls | Arbitrary (whitelisted) command execution on host | [registry.ts:506-518](lib/tools/registry.ts), [persona-tool-subsets.ts:74-75](lib/persona-tool-subsets.ts) | **Whitelist-only + approval + restore point** — well-gated. Risk is latent: a *reliable* emitter (the planned model swap) makes this live; re-audit the whitelist then. |
| 4 | **`/api/settings` POST unauthenticated + reachable over Tailscale** (`100.82.169.101:7799`) | Any Tailnet caller can rewrite config (backend, default model) | [route.ts:93-108](app/api/settings/route.ts) | Secrets stay masked/write-only; config is writable. Verify Tailscale ACLs; consider binding settings-write to loopback only. |
| 5 | **`requireValidSession` dead-but-exported** — re-wiring to `/api/settings` reintroduces the bootstrap deadlock | Total settings lockout / unbootable auth | [lib/auth.ts:152-187](lib/auth.ts), [orchestrator/route.ts:9-12](app/api/orchestrator/route.ts) | Only the orchestrator comment warns against it. Add a code comment at the function itself. |
| 6 | **Stale persona/model doc (§1.2)** drives wrong operational decisions (e.g. pulling broken `wild-gemma4`) | Wasted time, possible re-introduction of a crashing model | [personas.ts:165,178](lib/personas.ts) vs scope doc §1.2 | Treat `MODEL_*` constants as sole authority; correct the doc. |
| 7 | **file_ops boundary is lexical, not realpath** — a symlink inside ARGOS_ROOT pointing out is followed | Read/write outside the payload | [fs-guard.ts:15-27](lib/tools/fs-guard.ts) | Low on NTFS USB payload; `realpath`-resolve to close definitively |
| 8 | **Integrity guards are text-keyed** — a native cloud `tool_calls` emission is invisible to them | A cloud tool path (if added) could bypass fabrication detection | [route.ts:1403,1448](app/api/chat/route.ts) | Don't ship the native Nous path without extending guards (see §4) |
| 9 | **Tag/version drift** — `v2.4.2` tag 2 commits behind HEAD; HUD reads `package.json`, not the tag | Provenance confusion; "what's actually deployed" ambiguity | `git rev-list v2.4.2` vs HEAD `c3dce6f` | Verify by BUILD_ID + audit log (doctrine already says so). Resolve tag placement. |
| 10 | **email_send (planned) on the custom format** turns injection #2 into one-approval exfiltration | Data exfiltration to arbitrary recipients | `email_draft`/`twilio_sms` already live ([registry.ts:406,430](lib/tools/registry.ts)) | Build send as approval-gated, full-disclosure, recipient-allowlisted; never cloud-auto-approved |

---

## 6. Notes for the next phase (non-blocking observations)

- The "email phase" is partly built already: `email_draft`, `twilio_sms`, `pushover_alert` are registered and assigned to Juniper ([persona-tool-subsets.ts:89-95](lib/persona-tool-subsets.ts)). The gap is a *send* action + reliable emission, not green-field tooling.
- `frankfurter_fx` is listed in Bobby's subset but the comment says it "joins in Phase 2 where it is created" ([persona-tool-subsets.ts:66-84](lib/persona-tool-subsets.ts)). If it is not yet registered, `toolsForPersona` silently drops it (intersection with `KNOWN_TOOL_IDS`) — harmless, but worth confirming it's intentional.
- `makeSyntheticReader` emits `{done:true}` with no `prompt_eval_count`/`eval_count`, so the Nous path relies on `nousResult.*Tokens` for the audit (correctly handled at [route.ts:1488-1498](app/api/chat/route.ts)). Consistent.

---

*Recon-only review. Every file:line above was opened and read during this session. Runtime claims (test counts, audit turn ratios, TTS timings) were explicitly not re-executed and are marked unverified in §1.4. No code was modified; nothing was pushed.*
