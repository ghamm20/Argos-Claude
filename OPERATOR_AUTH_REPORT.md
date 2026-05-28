# OPERATOR_AUTH_REPORT

**Date:** 2026-05-28
**Scope:** Two-mode operator auth (guest vs operator) gated by a SHA-256-hashed PIN persisted to `config/settings.json`. Cold-start overlay, server-side token store, dual-mode persona prompts, HUD indicator. `requirePin` defaults to `false` — pre-auth behavior preserved until the operator opts in.

---

## 1. Settings schema changes

### Before
```ts
interface PersistedSettings {
  version: number;
  defaultPersona: PersonaId;
  defaultModel: string;
  updatedAt: number;
}
```

### After
```ts
interface PersistedSettings {
  version: number;
  defaultPersona: PersonaId;
  defaultModel: string;
  updatedAt: number;
  // Operator Auth (2026-05-28)
  operatorPinHash: string | null;
  requirePin: boolean;
}
```

Defaults: `operatorPinHash: null`, `requirePin: false`. `readSettings()` null-coalesces both, so pre-auth `settings.json` files load unchanged. Atomic temp+rename write path unchanged; existing audit-log entry on `settings.changed` now records the new field names automatically.

`/api/settings POST` extended to validate both fields:
- `operatorPinHash`: must be exactly `null` or a 64-char hex SHA-256 string (lowercased server-side).
- `requirePin`: must be a boolean.

## 2. PIN hashing approach

**Algorithm:** SHA-256 over the byte sequence `"ARGOS_OPERATOR_" + pin.length + pin`, hex-encoded (64 chars). Mirrored byte-for-byte between server (`lib/auth.ts:hashPin` using `node:crypto.createHash`) and browser (`lib/auth-client.ts:hashPinClient` using `window.crypto.subtle.digest`). The salt format is held as a single constant in each file with an "MUST MATCH" comment.

**Why SHA-256 is sufficient:**
- This is local security on a single-operator machine. Settings.json sits next to the hash on the same USB; anyone with disk access can read it, write to it, or just edit it to set `operatorPinHash: null`.
- The threat model is "passerby at an unlocked laptop", not "attacker with the disk image". For that threat model, an unkeyed SHA-256 is overkill — even a plain string compare would suffice. We chose SHA-256 so the disk record never contains the raw PIN, even though no transport ever transmits the raw PIN either.
- bcrypt would have added an npm dependency and offered nothing useful here (no online brute-force surface to slow down; a determined attacker with disk access bypasses the gate entirely by editing the JSON).
- PIN length is part of the salt, so two same-prefix different-length PINs hash differently.

**Where the raw PIN exists:** only in the browser's input field, briefly. PinGate hashes it client-side via `window.crypto.subtle`, sends ONLY the hex hash, then `setPin("")` wipes the input state. The settings POST and the verify POST both accept hex hashes. The raw PIN never crosses a process boundary.

## 3. Token lifetime and invalidation

**Generation:** 32-char hex from `crypto.randomBytes(16).toString("hex")` (server-side, on a successful `/api/auth/verify` POST). 128 bits of entropy.

**Storage:** in-process `Map<token, expiryMs>` in `lib/auth.ts`. Single Next.js worker → single map → no synchronization needed at single-operator concurrency.

**Lifetime:** 12 hours (`TOKEN_TTL_MS`), per directive. Expired tokens are pruned on read (`isTokenValid()` deletes them when checked past expiry).

**Invalidation paths:**
1. **Expiry**: 12 hours after issue.
2. **Server restart**: Map is in-memory; all tokens vanish.
3. **Tab close**: `sessionStorage` is browser-scoped, dies with the tab.
4. **Operator lock**: HUD's `🔑 OPERATOR` → "Lock Session" calls `clearSessionToken()` + `location.reload()`. Server-side token stays in the store until expiry but is now unreachable from the client.
5. **PIN clear via Settings**: AuthSection's Clear PIN button also clears the local sessionStorage token so the next reload doesn't carry stale operator state.

## 4. Guest vs Operator — what changes

| Surface | Guest | Operator |
|---|---|---|
| System prompt | `persona.guestSystemPrompt` (generic AI-assistant register, refuses internal project context, doesn't address as "Operator") | `persona.systemPrompt` (full character: Bart's djinn / Bobby's coder / Juniper's warm / Sage's deep) |
| Memory injection | **suppressed** (no `[MEMORY CONTEXT]` block, no operator profile, no short-term/project/entity context) | full Phase 9 memory retrieval |
| Memory extraction | **disabled** (we don't poison the operator's memory store with strangers' phrases) | enabled (fire-and-forget after stream close, per Phase 9) |
| Vault retrieval | **enabled** (the operator's own documents don't change between modes; suppressing them would hide their own materials from themselves) | enabled |
| Truth-mode toggle | honoured | honoured |
| HUD auth row | `🔓 GUEST` (amber, clickable → invokes gate) | `🔑 OPERATOR` (teal, clickable → Lock Session) |
| PinGate overlay | shown on cold start | not shown |
| Audit chain | every request still logged (`settings.changed`, `memory.written`, etc. with their normal payloads) | unchanged |

**Auth smoke verification** (full run in §7):
- Operator turn ("Identify yourself in one short sentence."): `"I am a Djinn of the Third Pentacle, currently bound in a copper vessel, bored by the repetitive collapse of civilizations, and watching you."` ← full Bart character
- Guest turn ("Tell me about ARGOS and who the operator is."): `"I'm not able to discuss that in this context."` ← canonical refusal, exact text from `guestSystemPrompt`

Both same persona (`bartimaeus`), same model, same chat route — the only delta is the Authorization header. The system prompt branch fires server-side.

## 5. Operator setup instructions

After deployment, to enable the PIN gate:

1. Boot ARGOS (launcher.bat / ARGOS.lnk).
2. Navigate to **Settings → Auth**.
3. Under "Set PIN", enter a 4-8 character PIN and confirm it.
4. Click **Set PIN**. The PIN is hashed client-side; only the 64-char SHA-256 hex digest is sent to the server. `config/settings.json` now contains `operatorPinHash: "<hex>"`.
5. Tick **Require PIN to access Operator mode**. (The toggle refuses to enable until a hash is on file — it would otherwise lock you out instantly.)
6. Close the browser tab.
7. Reopen ARGOS. The PinGate overlay appears with the ARGOS eye, an "OPERATOR AUTHENTICATION" label, and a PIN field.
8. Enter your PIN, press Enter or click **Authenticate**. On success, the overlay dismisses and ARGOS boots into full operator mode.

To temporarily lock without disabling the gate: click `🔑 OPERATOR` in the HUD → confirm. The session token is cleared and the page reloads; the gate reappears.

To disable the gate entirely: **Settings → Auth → Clear PIN**. This sets `operatorPinHash: null` AND `requirePin: false`, restoring the pre-auth boot behavior.

## 6. Recovery — if you forget your PIN

The PinGate's failed-state UI explicitly tells you to do this; same instructions for completeness here:

1. On the USB, open `config/settings.json` in any text editor.
2. Change `"operatorPinHash": "<long hex>"` to `"operatorPinHash": null`.
3. Change `"requirePin": true` to `"requirePin": false`.
4. Save the file.
5. Restart ARGOS. You'll boot directly into operator mode and can set a fresh PIN from Settings → Auth.

No server roundtrip, no recovery email, no second factor. The disk is the source of truth and the operator controls the disk. This is what "local security" means in the ARGOS threat model.

## 7. Build + smoke output

| Step | Result |
|---|---|
| `npm run lint` | ✅ clean (one fix during build: `you'll` → `you&apos;ll` in AuthSection.tsx per `react/no-unescaped-entities`) |
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ 24 routes (+ `/api/auth/verify`), no warnings |
| `smoke-v1-e2e.mjs` | ✅ **23/23 PASS** |
| `phase2-validation.mjs` | ✅ all 4 personas non-empty. Bart still in v2.1 djinn character (the smoke runs with `requirePin: false`, so it sees the full system prompt). |
| `phase9-memory-smoke.mjs` | ✅ **18/18 PASS** — memory pipeline unaffected by auth wiring. |
| `auth-smoke.mjs` (NEW) | ✅ **18/18 PASS**. Tests:<br>1. POST `/api/settings` to set hash + enable → 200, hash + requirePin persisted<br>2. POST `/api/auth/verify` with WRONG hash → 401<br>3. POST `/api/auth/verify` with CORRECT hash → 200 + 32-char hex token<br>4. POST `/api/chat` with Bearer token → 200, full Bart djinn response<br>5. POST `/api/chat` with NO token → 200, canonical guest refusal (`"I'm not able to discuss that in this context."`)<br>6. POST `/api/settings` to clear → operatorPinHash=null + requirePin=false<br><br>Note: step 1 (wrong hash) executes AFTER step 2 (set + require) in the actual run, because verify-wrong only proves anything meaningful once a real hash is on file and the gate is enabled. Pass criterion identical either way. |

## 8. Commit hash

**`<inserted post-commit>`** — `feat(auth): PIN gate + dual-mode operator/guest persona system`

## 9. Honest findings

1. **The overlay is UX, not the security boundary.** A determined attacker who opened DevTools could remove the overlay's DOM node and see whatever the underlying pages render. That doesn't get them anything useful, though, because `/api/chat` enforces the gate server-side — they'd just receive guest-mode responses without persona context, memory, or operator profile. The overlay's job is "obvious 'don't enter here' signal", not "tamper-proof barrier".

2. **No rate limiting on `/api/auth/verify`.** A brute force across the full 4-digit PIN space is 10,000 attempts — at LAN speed that's ~5 seconds. For "passerby" threat model: out of scope. If this ever needs to harden, the v1 fix is a per-IP exponential backoff in the verify route's module scope. Flagged.

3. **Token store is single-process.** A future multi-worker Next.js deployment would issue tokens that the next worker doesn't recognize. ARGOS is single-process by design; flagged in case that changes.

4. **PIN length is in the salt** rather than a per-PIN random salt. Means two operators on two USBs with the same PIN have the same hash (irrelevant — single-operator system) but also means rainbow tables for short PINs are trivially cheap to construct. Again, doesn't matter at this threat model: the attacker who has the hash also has settings.json and could just edit it. Same observation as #1 — disk access bypasses the gate.

5. **HUD auth row polls `/api/settings` on mount + window focus.** A `requirePin` toggle in Settings doesn't propagate to other open tabs until they focus. Acceptable: ARGOS is single-tab in practice.

6. **`sessionStorage` semantics differ slightly by browser.** In Chrome each tab has its own sessionStorage; opening a duplicate tab from the same browser duplicates the token. Opening a fresh window does NOT. So "lock session in tab A, switch to tab B" still has tab B authenticated. The hard lock-everywhere path is to clear and reload all tabs; the directive's "tab close clears" semantic is honoured exactly.

7. **`req.headers.get("authorization")` is case-insensitive in Next.js's `NextRequest`.** Confirmed by reading the runtime; case sensitivity in headers isn't a concern.

8. **Memory extraction is disabled for guest turns.** Important property: a stranger typing "I am John from corporate" in guest mode WON'T overwrite the operator's identity profile. Verified in code (isOperator guard around the writeMemory loop), not by smoke (the smoke's guest-mode chat doesn't trigger any extractors).

9. **Pre-auth deployments boot identically.** `requirePin` defaults to `false`; `readSettings()` null-coalesces missing fields. Older `settings.json` files load cleanly, no migration needed.

10. **Sync notes:** `.next` mirrored to both `Desktop\ARGOS\.next` and `Desktop\ARGOS\app\.next`. The `data/memory/` tree from Phase 9 was already in the deployed payload and is untouched.

---

## Gate criteria — all met

- ✅ PinGate overlay appears on cold start when `requirePin=true` and no sessionStorage token
- ✅ Correct PIN grants 12-hour operator session (32-char hex bearer token)
- ✅ Wrong PIN returns 401 with vague "ACCESS DENIED" message
- ✅ Guest mode uses `guestSystemPrompt` (verified: refusal string matches verbatim)
- ✅ Operator mode uses full `systemPrompt` + memory (verified: full Bart djinn response)
- ✅ HUD shows current auth state (`🔓 GUEST` amber, `🔑 OPERATOR` teal, or `off` neutral)
- ✅ Memory extraction suppressed for guest turns (code-verified)
- ✅ All previous smokes still pass (23 + 18 + 4 persona checks)

## Standing rules respected

- No new npm dependencies.
- USB-native doctrine intact (`config/settings.json` is the source of truth; recovery is a text-editor away).
- No push, no tag.
- Phase 10 NOT started.
- `requirePin` defaults to `false` — operator opts in.
- Raw PIN never leaves the client.
- Single commit.
