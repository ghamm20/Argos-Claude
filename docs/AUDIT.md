# Audit Chain & Export

ARGOS Phase 4 (v1.0) ships a tamper-evident audit chain plus a JSON session-export bundle. This document covers the architecture, the verifier, and how to inspect / re-verify either as a third party.

## Why

Per the master plan's Tier 11 ("Audit — log every action with hash chain"):

> Append-only JSONL, hash-linked per entry. Logs every proposal lifecycle event, every workflow execution, every research fetch, every memory write, every Zone 3 → Zone 2 sanitization event. Tamper detection: verification script walks chain. Any modification breaks hash continuity.

The chain is the foundation everything later writes to. v1.0 wires the existing event surfaces; Phases 7–10 add their own `appendAudit()` calls without touching the chain machinery.

## Architecture

```
$ARGOS_ROOT/state/audit/chain.jsonl    # append-only, one entry per line
```

Each entry:

```jsonc
{
  "version": 1,
  "index": 42,                              // monotonic, 0-based
  "ts": 1779589134821,                      // unix epoch ms
  "id": "0a1b2c3d4e5f60718293a4b5c6d7e8f9", // uuid4 sans dashes
  "kind": "session.updated",                // dot-form: subject.verb
  "sessionId": "f0e1d2c3b4a59687",          // optional, session-scoped events
  "payload": { ... },                       // kind-specific
  "prevHash": "ab12cd34…",                  // hex sha256 of previous entry's hash
  "hash": "ef56ab78…"                       // hex sha256 — computed from canonical JSON of all fields above
}
```

The first entry (index 0) has `prevHash: ""`.

### Hash computation

```
hash = sha256( prevHash + ":" + canonicalJson({all fields except hash}) )
```

`canonicalJson()` produces deterministic JSON: keys sorted at every nesting level, `undefined` values omitted (matches `JSON.stringify` semantics). Implemented identically in `lib/audit.ts` and `scripts/verify-audit-chain.mjs` — the verifier doesn't need any framework-side state, just the algorithm.

### Why this format

| Choice | Alternative | Why this one |
|---|---|---|
| JSONL (one entry per line) | Single JSON array | Append-only friendly; `fs.appendFile` is POSIX-atomic for sub-PIPE_BUF writes; readable by `tail -f` |
| sha256 | sha3 / blake2 / etc | Universal, standard library, no native deps |
| Canonical JSON | Protobuf / CBOR / msgpack | Human-readable, debuggable, no schema compiler |
| Append-only file | SQLite database | Single-binary doctrine, no DB process, easy backup (cp the file) |
| Hash-chain | Merkle tree | Linear access pattern matches usage; tree complexity unnecessary at v1.0 scale |

## Event kinds (v1.0)

These wire automatically when their source code runs:

| kind | Source | Payload |
|---|---|---|
| `session.created` | `lib/sessions.ts:writeSession` (first-write detection) | `id, title, personaId, model, messageCount, lastMessageId, lastMessageRole, lastMessageHasCitations` |
| `session.updated` | `lib/sessions.ts:writeSession` (subsequent) | same as `session.created` |
| `session.deleted` | `lib/sessions.ts:deleteSession` | `id` |
| `vault.ingested` | `lib/vault/store.ts:ingest` | `docId, filename, sha256, byteSize, chunkCount, durationMs` |
| `vault.deleted` | `lib/vault/store.ts:deleteDocument` | `docId, filename, chunkCount` |
| `settings.changed` | `lib/settings.ts:writeSettings` | `changed[], defaultPersona, defaultModel` |

Audit append is **best-effort** — a failed append never blocks the underlying write. The settings/session/vault store is the authoritative state; the chain is the receipt. If the chain ever stops writing (disk full, permission revoked, etc.) the system keeps working and you just lose the receipts for that window. The verifier flags this as a gap because `index` would skip.

Reserved kinds for later phases (declared in the `AuditKind` union but not wired yet):

- `research.fetched` (Phase 3.5)
- `memory.written` (Phase 4.5)
- `proposal.created` / `proposal.applied` / `proposal.rejected` (Phase 8)
- `workflow.executed` (Phase 10)
- `persona.switched` (UI-side, not wired in v1.0)

## API

### `GET /api/receipts`

Returns the chain.

| Query | Effect |
|---|---|
| (none) | Full chain, up to last 1000 entries (`tail` parameter to override) |
| `?sessionId=ID` | Only entries scoped to that session |
| `?verify=1` | Also runs the verifier and includes the result |
| `?tail=N` | Return only the last N entries (max 1000) |

Response:

```json
{
  "count": 42,
  "sessionId": null,
  "entries": [ /* AuditEntry[] */ ],
  "verify": { "ok": true, "totalEntries": 42, "firstHash": "ab12…", "lastHash": "ef56…" }
}
```

### `GET /api/chat/sessions/:id/export`

Returns a tamper-evident JSON bundle of one session (download with `Content-Disposition: attachment`).

Bundle shape:

```jsonc
{
  "bundleVersion": 1,
  "exportedAt": 1779589134821,
  "argosVersion": "0.1.0",
  "session": { /* full PersistedSession: id, title, persona, model, messages, retrieval traces */ },
  "audit": [ /* AuditEntry[] scoped to this sessionId */ ],
  "chainSummary": { "ok": true, "totalEntries": 42, "firstHash": "…", "lastHash": "…" },
  "bundleHash": "ab12cd34…"   // sha256(canonicalJson(everything above))
}
```

Verifying a bundle:

1. Take `bundleHash` aside, recompute `sha256(canonicalJson(bundle minus bundleHash))`. Must match.
2. For each entry in `bundle.audit`, recompute `sha256(prevHash + ":" + canonical(entry minus hash))`. Each must match its stored `hash`.
3. (Optional) cross-check against the full chain at `$ARGOS_ROOT/state/audit/chain.jsonl`. The bundle's audit entries' `index`+`hash` should appear at the same positions in the live chain.

Steps 1 + 2 detect bundle tampering. Step 3 detects bundle-was-edited-vs-historical-truth divergence — useful if the operator suspects after-the-fact mutation.

## Verifier

```
npm run audit:verify
```

or directly:

```
node scripts/verify-audit-chain.mjs                      # use $ARGOS_ROOT
node scripts/verify-audit-chain.mjs --chain PATH         # explicit chain
node scripts/verify-audit-chain.mjs --bundle PATH.json   # verify a session-export bundle too
```

Exit code 0 on PASS; 1 on tamper detection or any failure.

## Tamper detection — what gets caught

The Phase 4 smoke (`scripts/smoke-audit-chain.mjs`) exercises four tamper scenarios + the genesis/empty case:

1. **Payload tamper.** Change one byte in a middle entry's payload → entry's stored `hash` no longer matches recomputed hash. Verifier flags the exact index + reports "hash mismatch — payload tampered".
2. **prevHash tamper.** Change a middle entry's `prevHash` field → `prevHash` no longer equals the actual previous entry's `hash`. Verifier flags the index + reports "prevHash mismatch" (or "hash mismatch" if the prevHash was used for hash computation).
3. **Entry deletion.** Remove a middle entry → `index` field of remaining entries no longer matches their file position. Verifier flags the gap.
4. **Genesis-only / empty chain.** Verifier passes — emptiness is valid (no events yet).

What the verifier does **not** catch:

- **Full-chain replacement** with a fresh, internally-consistent chain. The verifier checks structural integrity, not "is this the same chain as last week." A truly paranoid operator would archive the latest `lastHash` somewhere off-system (e.g., post to a private gist with timestamp) and compare manually. v2-ish concern; not v1.0 scope.
- **Hash-collision attacks on sha256.** sha256 is collision-resistant in practice; if this becomes a threat we have bigger problems.
- **Bugs in the verifier itself.** The verifier is small (~150 lines) and the smoke covers its main code paths. Self-test as part of every `npm run check`.

## Scaling

Per-entry cost:

- Append: O(chain length) due to `readChain()` to get last hash before appending. ~50ms per append at 10k entries (one disk read + one append). Acceptable at v1.0 scale.
- Verify: O(chain length). ~200ms at 10k entries.

If chain exceeds 100k entries (years of heavy use): cache the tail in memory (avoid re-reading whole chain per append). Filed as a v2 optimization; not needed at v1.0 scale.

The chain file itself: each entry is ~300-1000 bytes. 100k entries ≈ 30-100 MB. Fits comfortably on the USB.

## Failure modes

| Failure | What happens | Recovery |
|---|---|---|
| `state/audit/` dir doesn't exist | `appendAudit` creates it; first entry writes successfully | none needed |
| Chain file unreadable (permissions) | `appendAudit` throws; underlying write (session/vault/settings) succeeds anyway because audit is best-effort | fix permissions; missing audit entries can't be retroactively created |
| Disk full | `appendAudit` throws; underlying write also likely fails for the same reason | free space; chain integrity preserved (last successful append is the new tail) |
| Manifest corruption (`vault/index/manifest.json`) | Doesn't affect chain; audit is independent of vault state | re-ingest if needed; chain is untouched |
| Chain JSONL truncated mid-line (yank during write) | Verifier flags the truncated line; entries before it are valid | delete the truncated line; chain valid from genesis to last clean line |

## Doctrine compliance

- **Rule 1 (zero host persistence):** chain lives at `$ARGOS_ROOT/state/audit/`, removable with the drive.
- **Rule 2 (no network deps):** sha256 + canonical JSON + JSONL — all stdlib. No external services touched.
- **Rule 5 (no remote fetch):** audit chain is local-only; verifier is local-only.

verify-argos: all 7 rules PASS on Phase 4 source.

## See also

- `lib/audit.ts` — chain implementation
- `app/api/receipts/route.ts` — query endpoint
- `app/api/chat/sessions/[id]/export/route.ts` — bundle export endpoint
- `scripts/verify-audit-chain.mjs` — standalone verifier
- `scripts/smoke-audit-chain.mjs` — round-trip + tamper smoke
- `methodology/decisions.md` — Phase 4 entry with rationale + alternatives
