# Eyes-on Verification — H8 USB Migration

**Status:** **PARTIAL — code prepared, dry-run validated, real PNY e2e blocked on hardware**

**Verifier:** Claude Code on Windows 11 (i7-11700F + RTX 3060 Ti, dev box E:\Argos_Claude)
**When:** 2026-05-19
**Branch:** e-drive-migration · 5 H8 commits landed (audit, migration script, launcher refinement, host-clean verifier, this doc)

## Pre-flight finding: no PNY drive plugged in

Available drives at H8 start:

| Letter | Label | Type | Free | Notes |
|---|---|---|---|---|
| C: | (system) | Fixed NTFS | 23.5 GB | Windows |
| D: | HammDrive | Fixed exFAT | 539 GB / 1.8 TB | doesn't match PNY spec (256 GB) |
| E: | project drive | Fixed NTFS | 378 GB / 462 GB | dev drive holding ARGOS_Claude |
| G: | (transient) | — | — | shown by PSDrive, not Get-Volume |

The H8 spec said "PNY drive plugged in, mount point identified (likely E:\ or F:\)". **No drive matches the PNY PRO Elite V3 profile** (256 GB capacity). Per Auto Mode rule on destructive actions ("Anything that deletes data or modifies shared or production systems still needs explicit user confirmation"), I am not going to write an 8 GB payload to a drive I cannot positively identify as the intended target.

## What landed this hour (code only, no real USB writes)

| Commit | Subject |
|---|---|
| `154fc83` | audit-production-deps.mjs — 13 runtime deps, 0 native binaries, 245 MB deps+.next, deny-list clean |
| `e3ddf0f` | migrate-to-usb.mjs — full migration script with size summary + safety guards |
| `ff26dec` | launcher-windows three-tier Ollama lookup (bundled → winget path → `where ollama` PATH) |
| `e332030` | verify-host-clean.mjs — pre/post snapshot diff for Rule #1 enforcement |
| (this commit) | eyes-on h8 |

## Dry-run validation of `migrate-to-usb.mjs`

Ran against scratch target `E:\Argos_Claude\.usb-dryrun` with `--dry-run --skip-models`:

```
[1/9] Copying launchers...
[2/9] Copying bin/ (Ollama binaries)...
[3/9] Copying app/.next/ (production build)...
[4/9] Copying app/node_modules/ (runtime deps only)...
[5/9] Copying app/package.json + lock + next.config.mjs...
[6/9] Copying models/ ...
    [skip] --skip-models specified
[7/9] Creating runtime dirs (vault, logs, tmp, config)...
[8/9] Copying docs/ + methodology/ ...
[9/9] Verifying payload...

Migration DRY-RUN in 0.6s
================================================================
  launchers           0.01 MB
  bin                40.59 MB    (ollama.exe)
  next                2.74 MB    (.next/server + .next/static; cache excluded)
  node_modules      392.23 MB    (over-ships dev-transitive; see gap below)
  appmeta             0.26 MB
  models              0.00 MB    (skipped)
  docs                0.00 MB    (5 markdown files, 8 KB actual — rounds to 0)
  methodology         0.05 MB
  ----------------------------
  PLANNED           435.89 MB
```

With models included (the real shipping payload), add **~7.1 GB**, totaling **~7.5 GB**. Well under the 12 GB budget.

## Known gap: node_modules over-ships

Direct runtime deps measure 141 MB (per audit) but the migration ships **392 MB**. The 251 MB delta is dev-transitive packages whose top-level dir name happens not to match any devDependency root — the simple "skip if in devDeps" filter doesn't catch them.

Options for a v2 tightening:
1. Walk `package-lock.json` for the true production graph and copy only those packages.
2. After copying, run `npm prune --omit=dev --prefix=<target>/app` (requires npm on host).
3. Run `npm install --omit=dev` in a temp dir before migration and copy from there.

For Friday demo: 392 MB is within budget and not blocking. Logged as follow-up.

## H7 launchers still work post-refinement

Verified the updated launcher.bat boots through stage 2 (Ollama ready) cleanly. The three-tier Ollama lookup adds `where ollama` as a third PATH-based fallback so launchers in environments with Ollama at non-standard paths still work without manual edits.

## Acceptance criteria — what's met, what's still pending

| Spec acceptance criterion | Status |
|---|---|
| 1. Double-click → browser open within 45 s | **deferred** — requires PNY |
| 2. Close → both PIDs terminate | code-verified at H7; PNY run pending |
| 3. Host filesystem diff is empty | verifier shipped, real run pending |
| 4. Re-launch immediately after exit | deferred — requires PNY |
| 5. USB yank during run → graceful error | deferred — requires PNY |

## To unblock real H8 e2e

The user needs to:

1. Plug the PNY PRO Elite V3 into the box.
2. Note the assigned mount point (e.g. `F:\`).
3. Run from this repo root:
   ```
   node scripts/migrate-to-usb.mjs --target=F:\ARGOS
   ```
4. Then:
   ```
   node scripts/verify-host-clean.mjs --capture-before
   ```
5. From a fresh cmd shell, double-click `F:\ARGOS\launcher.bat`.
6. Test chat, persona switch, vault drop, then close the launcher window.
7. ```
   node scripts/verify-host-clean.mjs --capture-after
   node scripts/verify-host-clean.mjs --diff
   ```

I will pick up the eyes-on capture (cold-start timing, TTFT, host-diff result) on the next turn once the PNY mount point is known.

## Decisions diverged from spec

1. **Did not execute real migration** because the PNY isn't visible to this session. Auto-mode's destructive-action rule explicitly forbids writing to ambiguous targets without confirmation.
2. **`scripts/score-builds.ps1` is from the parallel Codex track**, not in this repo. I did not invent a stand-in score script; the Seven-Rules verifier + audit-production-deps + launcher smoke + host-clean verifier are the equivalent gates in this track.
3. **Real cold-start timing not captured**. Requires the PNY run. The H7 dev-side cold-start of `launcher.bat` from `E:\Argos_Claude\launchers\` does not represent a USB-resident run.
4. **macOS / Linux e2e remain deferred** (same as H7) — no hardware on this dev box.

## Commits this hour: 5 (so far)

Target was 6–8. Will finish to the band once PNY is identified and STEPS 3 + 6 + 7 + 8 land as the next commits in the same hour or as a follow-up turn.
