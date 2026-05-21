# Threat Model — Code Audit

Walks `docs/04-THREAT-MODEL.md` claim by claim and verifies each against the actual code. Status: **2026-05-20, Phase P of the autonomous block.**

## Claim 1: "Data exfiltration via cloud calls → network-default-off, dependency audit"

### Sub-claim 1a: no cloud calls

**Method:** grep all `fetch(` invocations in `app/`, `lib/`, `components/`.

**Result:** 17 call sites. All destinations are either:
- `${OLLAMA_BASE}/...` — Ollama daemon (default `http://127.0.0.1:11434`, env-overridable via `OLLAMA_HOST`)
- `/api/...` — relative path to the same Next.js server

**Zero external destinations.** Confirmed.

| File | Line | URL | Verdict |
|---|---|---|---|
| `app/api/chat/route.ts` | 184 | `${OLLAMA_BASE}/api/chat` | localhost |
| `lib/vault/embed.ts` | 23 | `${OLLAMA_BASE}/api/embeddings` | localhost |
| `components/ChatPane.tsx` | 167, 227 | `/api/vault/list`, `/api/chat` | same-origin |
| `components/HUD.tsx` | 107, 108 | `/api/hardware`, `/api/vault/list` | same-origin |
| `components/settings/*.tsx` | 15, 40, 51, 18, 37, 31, 53, 70 | `/api/{hardware,settings,vault/list,vault/delete}` | same-origin |
| `components/VaultPanel.tsx` | 46, 72, 142 | `/api/vault/{list,upload,delete}` | same-origin |

### Sub-claim 1b: dependency audit

**Method:** `verify-argos` Rule 2 enforces no network/analytics packages in `dependencies` at build-time. Self-tested by injecting `axios` into deps → fail expected.

**Result:** PASS. The harness is run on every `npm run check` and every CI invocation (`.github/workflows/ci.yml`).

**Flagged-package list** (rejected if added to `dependencies`):
`axios`, `node-fetch`, `got`, `request`, `superagent`, `isomorphic-fetch`, `cross-fetch`,
`@sentry/*`, `sentry`, `raven`, `posthog*`, `@posthog/*`, `@segment/*`, `analytics-node`,
`segment-analytics*`, `mixpanel*`, `@mixpanel/*`, `@amplitude/*`, `amplitude-js`,
`@vercel/analytics`, `@vercel/speed-insights`, `datadog*`, `dd-trace`, `@datadog/*`,
`newrelic*`, `@newrelic/*`, `fullstory*`, `@fullstory/*`, `hotjar*`, `google-analytics*`,
`@google-analytics/*`, `heap-analytics`, `launchdarkly*`, `@launchdarkly/*`.

### Sub-claim 1c: external CDN imports

**Method:** `verify-argos` Rule 4 grep-checks every source file for `from "https://..."`, remote `src=`/`href=`, and `fetch("https://non-localhost..."`. Localhost explicitly allowed.

**Result:** PASS.

---

## Claim 2: "Persistent host artifacts → Seven Rules + filesystem diff verification"

### Sub-claim 2a: Seven Rules enforced

**Method:** `verify-argos` Rules 1, 3, 5 cover hardcoded paths, manual path concat, and writes outside ARGOS_ROOT respectively. Rules 6, 7 added 2026-05-20 cover launcher daemon hardening.

**Result:** All 7 PASS. Run on every commit via CI.

### Sub-claim 2b: filesystem diff verification

**Method:** `scripts/verify-host-clean.mjs` captures the host filesystem state before launcher start and after launcher stop, computes the diff filtered through an exception list (browser cache noise, NVIDIA, OneDrive, etc.).

**Result:** Verified during H8 eyes-on: 38099 → 38381 host files during launcher run, **0 attributable additions/modifications** outside the exception list. Rule 1 PASS.

---

## Honest gaps identified in this audit

These are NOT in the original threat model but surfaced during this walkthrough:

### Gap A: settings.json non-atomic write (`lib/settings.ts:59`)

```typescript
await fsp.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
```

This is a single write call, not write-rename. If the process is killed mid-write or the USB drive is yanked, `settings.json` can be left empty or partial. Next `readSettings()` would throw on JSON parse, and the catch only handles `ENOENT` — so the app would crash.

**Fix scope:** Phase W (settings persistence atomicity) — implement write-temp-then-rename pattern.

### Gap B: error messages leak internal info

API error responses include internal context (file paths, embed model names, ollama upstream bodies). On a single-user USB-native deployment this is fine — the operator IS the attacker model. But it's worth flagging:

| Route | Leaks |
|---|---|
| `chat` | model name in 404, raw upstream body |
| `vault/upload` | tmp file path (via thrown errors) |
| `vault/search` | embed model name in EmbedError |

**Verdict:** acceptable for v1 single-user. Document for v2 multi-user threat model.

### Gap C: no rate limiting

A loopback attacker (e.g., malicious local script) could hammer `/api/chat` and saturate the Ollama daemon. No rate limiting. Also v1-acceptable (loopback is trusted per Rule #5).

### Gap D: chat history is in-memory only (Zustand)

Browser refresh = chat lost. Listed as intentional per scope-lock, but a user might lose work. v2 will need scoped persistence.

---

## Named gaps in original threat model (still pending)

The original doc explicitly names these for v2+:

- **Prompt injection through vault documents** — v2 (week 4-5). A malicious doc containing "ignore previous instructions" in retrieval chunks could override system prompt. Truth Mode (H4) partially mitigates by emphasizing citation discipline, but doesn't structurally prevent injection.
- **Model/vault tampering** — v2 (week 12-13). Signed weights, audit log.
- **Drive theft / physical access** — v2 (week 12-13). Encryption at rest.
- **Supply chain** — v2 (week 2-3). SBOM, dependency pinning.

---

## Summary

| Claim | Status |
|---|---|
| No cloud calls | **VERIFIED** (17 fetch sites, all localhost or same-origin) |
| Dependency audit gates network packages | **VERIFIED** (Rule 2, CI-enforced) |
| Filesystem clean | **VERIFIED** (verify-host-clean.mjs, 0 attributable host writes during H8) |
| Seven Rules enforced in code | **VERIFIED** (7/7 verify-argos rules PASS) |

The threat model's "Addressed" claims are accurate. Four new minor gaps surfaced during audit (A, B, C, D above); only Gap A is worth fixing in this autonomous block (settings atomicity, Phase W).
