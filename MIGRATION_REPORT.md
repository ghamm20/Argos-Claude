# MIGRATION_REPORT.md — ARGOS D: Drive Migration

**Date:** 2026-05-31
**Author:** Claude
**Dev source:** `C:\Users\Gordy\dev\Argos-Claude` (HEAD `ee79bb9`, clean, synced to origin/main)
**Old payload:** `C:\Users\Gordy\Desktop\ARGOS`
**New payload:** `D:\ARGOS`
**Target drive:** D: — NTFS, **Fixed**, label **"Gordy AI"**, 465.6 GB free
**Result:** **MIGRATION SUCCESS** — payload copied (83.65 GB), launcher boots from D:, Ollama serves from `D:\ARGOS\models`, UI on 7799, zero ARGOS-attributable host writes. Three honest findings flagged (§7), one minimal launcher patch applied, one launcher robustness bug documented (not patched — out of scope).

---

## 0. Tasks 1–2 — Script comprehension (read before touching anything)

### `scripts/migrate-to-usb.mjs`
Copies a production payload to `--target` matching `launchers/ARGOS_layout.md`: launchers at root, full Ollama install tree → `bin/`, `app/.next`, runtime `node_modules` (deps + crawled transitive, dev roots excluded), `app/` package/config files, the entire `~/.ollama/models` store → `models/`, empty runtime dirs (`vault logs tmp config`), `docs/` + `methodology/`, a `README.txt`, and a default `config/settings.json`.

**Does it handle a fixed (non-removable) NTFS drive?** **Yes — with no patch.** The drive-identity guard (`verifyTargetDrive`) is **opt-in**: it only runs when `--expect-label` and/or `--expect-drivetype` are passed, and returns `{ok:true, skipped:"no expectation specified"}` otherwise. There is **no hard requirement for `Removable`** anywhere. Passing `--expect-drivetype=Fixed` makes the guard *accept* a fixed drive explicitly. The H8.5 drive-letter incident this guard was built for is about label/type identity, not removability.

> **Conclusion: no patch to the migration script was required.** It migrated to a fixed NTFS drive cleanly. (Directive contingency "if the script requires USB/removable detection to pass, patch it" did not trigger.)

### `scripts/verify-host-clean.mjs`
Executable form of Seven-Rules #1 ("zero host persistence"). Snapshots file mtimes across `%APPDATA%`, `%LOCALAPPDATA%`, `%TEMP%`, `%USERPROFILE%\Documents` (`--capture-before`), again after a run (`--capture-after`), and `--diff`s. Any *added* or *mtime-increased* file outside the payload that isn't matched by its OS/browser/cache exception list is an "attributable" violation. PASS = zero attributable adds + mods.

> Note for interpretation: ARGOS writes everything under `ARGOS_ROOT=D:\ARGOS`, which is **not** one of the scanned roots (all on C:). So an ARGOS write can only ever appear in the diff if ARGOS wrote *outside* its payload — which is precisely the violation the test exists to catch. Any diff entry on a non-ARGOS path is third-party/OS noise.

---

## 1. Task 3 — Migration run

Command (run from dev source):
```
node scripts/migrate-to-usb.mjs --target=D:\ARGOS --expect-label="Gordy AI" --expect-drivetype=Fixed
```
Drive-safety guards engaged with the **real** label (see §7 Finding A) + Fixed type.

Pre-flight + result:
```
[pre-flight] drive D: label='Gordy AI', DriveType='Fixed' — OK
...
[post-smoke] running <target>/bin/ollama.exe --version ...
    [ok]   ollama version is 0.24.0
Migration complete in 296.1s
  launchers           0.03 MB
  bin              6696.83 MB   (full Ollama install tree incl. lib/ runtime DLLs)
  next                3.37 MB
  node_modules      391.70 MB
  appmeta             0.27 MB
  models          78567.79 MB
  docs                0.07 MB
  methodology         0.18 MB
  PLANNED         85660.25 MB  (83.65 GB)
  ON-DISK         85660.26 MB  (83.65 GB)   ← planned == on-disk, exact
Post-migration smoke: OK
```

Elapsed **296 s (~5 min)**. Bundled `D:\ARGOS\bin\ollama.exe --version` → `0.24.0` (proves `bin/` copied with its runtime libs intact).

---

## 2. Task 8 — Pre/post directory comparison

### Before (D: empty)
```
D:\
└── System Volume Information\        (OS-reserved; D:\ARGOS did not exist)
```

### After (`D:\ARGOS`, 83.65 GB)
| Dir | Size | Contents |
|---|---:|---|
| `models\` | 76.73 GB | full Ollama store copied from `~/.ollama/models` |
| `bin\` | 6.54 GB | full `%LOCALAPPDATA%\Programs\Ollama\` tree (ollama.exe + lib/ DLLs) |
| `app\` | 0.39 GB | `.next` prod build + runtime `node_modules` + package/config |
| `config\` | <1 MB | `settings.json` (see §4) |
| `docs\` `methodology\` | <1 MB | read-only doctrine + audit trail |
| `logs\` `tmp\` `vault\` | 0 | empty runtime dirs (populated at run) |
| **root** | — | `launcher.bat` (patched, §3), `launcher.command`, `launcher.sh`, `README.txt` |
| **TOTAL** | **83.65 GB** | |

**Persona model manifests on D: — all four roster models present:**
```
royhodge812/Orchestrator/lates                              (Bartimaeus)
fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive/9b     (Juniper)
alfaxad/wild-gemma4/e4b                                     (Sage)
CyberCrew/notmythos-8b/latest                              (Bobby)
```

---

## 3. Task 7 (part 1) — Launcher hardcoded-path patch

**Patch applied to `launchers/launcher.bat`** (source; propagated to `D:\ARGOS\launcher.bat` by the migration, confirmed on D: at line 53):

```diff
- if not defined OLLAMA_MODELS set "OLLAMA_MODELS=C:\\Users\\Gordy\\.ollama\\models"
+ if not defined OLLAMA_MODELS set "OLLAMA_MODELS=%ARGOS_ROOT%\models"
```

**Why.** The launcher's comment said it "defaults OLLAMA_MODELS to the USB-payload location," but the code hardcoded the **host** path `C:\Users\Gordy\.ollama\models`. A migrated D: payload would have read its models from host C: — defeating USB-native isolation (Seven-Rules #1) and making the 76 GB model copy pointless. The patch makes it derive from `ARGOS_ROOT`, matching the documented intent. This is the only hardcoded host path in the launcher and the only patch the migration's correctness required. Minimal (one line); no redesign.

> **Why verify-argos did not catch this (correcting the directive's premise):** `verify-argos` scans only `app/`, `components/`, `lib/`, `scripts/` for `.ts/.tsx/.js/.jsx/.mjs/.cjs/.css/.html`. It **does not scan `launchers/*.bat`**. So Rule 1 (no hardcoded abs paths) and Rule 3 (path.join usage) **structurally cannot see** a hardcoded path in a `.bat` file. The directive's expectation that "Rule 3 should catch these" does not hold for launcher scripts. Confirmed explicitly in §6.

---

## 4. settings.json correction

The migration script writes a **stale default** `config/settings.json`:
```json
{ "version":1, "defaultPersona":"bartimaeus", "defaultModel":"llama3.1:8b-instruct-q4_K_M", "updatedAt":0 }
```
`llama3.1:8b-instruct-q4_K_M` is not in the current roster and the file lacks all Phase 2 fields (PIN, requirePin). Left as-is, first boot would try to load a non-existent model.

**Fix:** overwrote `D:\ARGOS\config\settings.json` with the operator's real config from the Desktop payload (preserves the Phase 2 default model + operator PIN):
```json
{ "version":1, "defaultPersona":"bartimaeus", "defaultModel":"royhodge812/Orchestrator:lates",
  "updatedAt":1779977082469, "operatorPinHash":"3f65a2a8…90e6", "requirePin":true }
```
> Follow-up worth noting (not changed here): the migration script's hardcoded default model is itself stale and should eventually be updated to the current default. Out of scope for this migration.

---

## 5. Task 5 — Full smoke battery (`npm run check:full`)

**Where it ran:** the **dev source repo**, not `D:\ARGOS`. `check:full` runs `lint → typecheck → build → verify-argos → audit-stub-honesty → audit-production-deps → smoke-launcher` and then live `next dev` smokes — it requires the full dev environment (devDependencies, `scripts/`, source). The D: payload is a **production runtime artifact** (only `app/.next` + runtime deps; no `scripts/`, no devDeps, no source), so `npm run check:full` **cannot run from `D:\ARGOS`** — it would fail immediately on missing eslint/tsc and the absent `scripts/check-full.mjs`. The meaningful location is the dev repo; the runtime-appropriate validation for the payload is the launcher-boot + host-clean run in §6.

**Result (dev repo): 5 pass / 2 fail.** Both failures are **pre-existing and unrelated to the migration** (the only working-tree change this session is `launchers/launcher.bat`, which none of these checks scan):

```
[PASS] lint            2773ms
[PASS] typecheck       3153ms
[PASS] build          17611ms
[FAIL] verify-argos      488ms   (Rule 1 — see below)
[FAIL] audit-stub-honesty  75ms  (18 fails — see below)
[PASS] audit-production-deps 1895ms
[PASS] smoke-launcher    127ms
```

- **verify-argos Rule 1 FAIL** = `scripts/bart-canon-validate.mjs:20`, a **comment** containing the example string `C:\Users\Gordy\Desktop\ARGOS`. `git show HEAD:scripts/bart-canon-validate.mjs` confirms the line is byte-identical in the committed HEAD `ee79bb9` — pre-existing, not a storage path, not introduced here.
- **audit-stub-honesty 18 FAILs** = the **Memory** (`app/memory/page.tsx`) and **Tools** (`app/tools/page.tsx`) pages, which the audit expects to be inert *v2-deferred stubs* but which were **deliberately built into real features in Phases 9/10/11** (they legitimately use `useState`/`useEffect`/`fetch`). The audit is **stale**; Vision/Voice still pass. Pre-existing divergence, unrelated to migration.

> lint + typecheck + **build all green** — the artifact that produced the D: payload is sound. The two reds are known/stale and predate this work.

---

## 6. Tasks 4 + 6 — Launcher boot from D: + host-clean

### Boot (Task 4)
The launcher was started from `D:\ARGOS\launcher.bat`. Two harness adjustments were needed to faithfully exercise it; both are explained in §7:
- launched via PowerShell so the child uses Windows `timeout.exe` (not the MSYS `timeout` that shadows it under Git-bash — Finding D);
- with `OLLAMA_HOST` removed from the child env so the launcher used its **native port fallback** to coexist with the developer's already-running system Ollama on 11434 (Finding C).

**Observed — launcher booted from D: cleanly:**
| Component | Evidence |
|---|---|
| Ollama daemon | Listening **127.0.0.1:11435** (native fallback; 11434 held by system daemon). `ollama.log`: `cmd="D:\ARGOS\bin\ollama.exe runner …"` — **running from the D: binary**, GPU detected (RTX 3060 Ti, 8 GiB), `GET /api/tags 200`. |
| Models source | `GET /api/tags` on 11435 → **14 models served from `D:\ARGOS\models`**, including Bart's Orchestrator and Juniper's Qwen3.5. |
| Next.js UI | Listening **0.0.0.0:7799**, `next.log`: "Ready in 309ms"; `GET http://127.0.0.1:7799/` → **HTTP 200**. |
| Full stack | `POST /api/model/warm {royhodge812/Orchestrator:lates}` **through the D: app** (7799 → 11435 → `D:\ARGOS\models`) → `{"ok":true, …}`, cold-loaded in 28.8 s from the D: drive. |
| Isolation | ARGOS wrote **only** to `D:\ARGOS\logs\` (launcher/next/ollama/oculus/superagi logs). Nothing on the host. |

> Cold model load was 28.8 s off the D: drive vs ~0.2–5 s off the C: NVMe in earlier Phase 2 tests — a one-time per-model cold-load cost of the slower fixed drive, not a swap-latency regression. Worth setting operator expectations.

Teardown was **scoped by PID** (killed only 11435 Ollama + 7799 Next + the launcher cmd); the **system Ollama on 11434 stayed alive** (verified HTTP 200 after teardown). The launcher's own blanket `taskkill /IM ollama.exe` cleanup path was deliberately **not** used.

### host-clean (Task 6)
`--capture-before` (313,072 files) → launcher run + probes → `--capture-after` (313,080) → `--diff`:
```
Exception matches (filtered): 177
Attributable additions:        0
Attributable modifications:    4
[FAIL] ...
  MOD  …\AppData\Roaming\Docker\marlin.dat
  MOD  …\AppData\Local\Docker\wsl\disk\docker_data.vhdx
  MOD  …\AppData\Local\EpicGamesLauncher\Saved\Data\…dat
  MOD  …\AppData\Local\Microsoft\PowerShell\StartupProfileData-NonInteractive
```
The verifier reports a mechanical `[FAIL]`, but **every one of the 4 modifications is non-ARGOS background activity**:
- 2× **Docker** daemon (running independently of ARGOS),
- 1× **Epic Games Launcher** background,
- 1× **PowerShell `StartupProfileData-NonInteractive`** — written by *this migration's own PowerShell test-harness calls*, not by ARGOS.

**Zero ARGOS-attributable host writes.** This is structurally expected: ARGOS writes only under `D:\ARGOS` (confirmed — all run output landed in `D:\ARGOS\logs\`), which the scanner doesn't even traverse. The four hits are simply daemons the exception list doesn't enumerate (Docker/Epic/PowerShell-startup). **Seven-Rules #1 holds for ARGOS.**

> If a future operator wants a green mechanical PASS here, the right fix is to quiesce Docker/Epic during the capture window or extend `EXCEPTION_PATTERNS` — not a code change to ARGOS. Out of scope for this migration.

---

## 7. Task 7 (part 2) — Hardcoded ARGOS_ROOT references + honest findings

**App source is clean.** `argosRoot()` (`lib/vault/paths.ts`) resolves dynamically:
```ts
return process.env.ARGOS_ROOT && process.env.ARGOS_ROOT.length > 0 ? process.env.ARGOS_ROOT : process.cwd();
```
No `Desktop\ARGOS` string anywhere in `lib/`, `app/`, or `components/`. **verify-argos Rule 5 PASSES** (every fs write derives from `ARGOS_ROOT`). The runtime proof: the app booted from `D:\ARGOS` and wrote exclusively to `D:\ARGOS` with no source change — confirming storage follows the payload location, not a hardcoded root.

### Findings

| # | Finding | Severity | Action |
|---|---|---|---|
| A | Drive label is **"Gordy AI"** (with a space), not "GordyAI" as the directive stated. | cosmetic | Used the real label; documented. |
| B | Model store is **76.7 GB** (full `~/.ollama` store, ~14 models — far more than the 4-persona roster). Payload total 83.65 GB. | info | Copied in full per directive ("run the migration"); D: has 465 GB. |
| C | **`OLLAMA_HOST=0.0.0.0` is a Machine-scoped Windows env var.** The launcher's port resolution parses `host:port` via `tokens=2 delims=:`; given a bare `0.0.0.0` it yields an empty port and **skips its 11434→11435 fallback**, so its Ollama tries 11434. If a second Ollama already holds 11434 (e.g., the system tray daemon), the launcher's Ollama **fails to bind**. On a normal "plug in D:, double-click, no other Ollama running" boot it still works (binds 0.0.0.0:11434; the app's `lib/ollama-config` already translates 0.0.0.0→127.0.0.1 from the Phase 2 fix). | **real, narrow** | **Documented, NOT patched** — fixing the launcher's port-parse is launcher-logic hardening beyond this migration's scope ("patch minimally, do not redesign"). Recommended follow-up below. |
| D | Running `launcher.bat` *through Git-bash* (`cmd //c`) let the MSYS `/usr/bin/timeout` shadow Windows `timeout.exe`, so the launcher's `timeout /t 1` delays errored and its wait-loops spun instantly. | harness-only | Re-ran via PowerShell (Windows PATH). **Not operator-facing** — a real double-click uses System32. |
| E | Migration script writes a **stale default `settings.json`** (`defaultModel: llama3.1…`, no Phase 2 fields). | minor | Overwrote D: settings with the real operator config (§4). Script default itself left for a separate fix. |
| F | `check:full` is **red (5/2)** in the dev repo — both fails **pre-existing + unrelated** (comment path in `bart-canon-validate.mjs`; stale stub-honesty audit vs. built-out Memory/Tools pages). | pre-existing | Documented (§5); build/lint/typecheck green. Not touched. |

### Recommended follow-ups (NOT done — would exceed migration scope)
1. **Launcher port-parse hardening (Finding C):** when `OLLAMA_HOST` has no `:port` (e.g. `0.0.0.0`), the launcher should fall through to its own 11434→11435 netstat fallback and set a connectable `OLLAMA_HOST` — mirroring the `bindToConnect()` fix already landed in `lib/ollama-config.ts` (Phase 2). Or, simpler operationally: drop/scope the machine-wide `OLLAMA_HOST=0.0.0.0` env var, since ARGOS is designed to own Ollama exclusively.
2. **Migration-script default `settings.json`** → bump `defaultModel` to the current roster default and include Phase 2 fields.
3. **`verify-argos` scan scope** → optionally extend to `launchers/*.bat` so launcher hardcodes are caught (this migration's Finding/patch would have been auto-flagged).

---

## 8. Confirmed boot from D:\ARGOS — verdict

- [x] Migration script handles a **fixed NTFS** drive — no patch required (drive guard is opt-in; passed `--expect-drivetype=Fixed`).
- [x] Payload copied to `D:\ARGOS` — **83.65 GB**, planned == on-disk, post-smoke OK, all 4 persona models present.
- [x] `launcher.bat` **boots from D:** — Ollama runs from `D:\ARGOS\bin\ollama.exe` serving `D:\ARGOS\models`; **UI loads on 7799 (HTTP 200)**; full warm path 7799→Ollama→D: models returns `ok:true`.
- [x] **Zero ARGOS-attributable host writes** — all run output under `D:\ARGOS\logs\`; the 4 host-clean diffs are Docker/Epic/PowerShell noise.
- [x] **No hardcoded Desktop/host paths in app source** — `argosRoot()` derives from `ARGOS_ROOT`; Rule 5 PASS. Launcher's one host-path hardcode fixed (§3).
- [x] System Ollama left intact; no GitHub push; no new npm deps.

**ARGOS D: Drive Migration: SUCCESS**, with Finding C (launcher `OLLAMA_HOST=0.0.0.0` port-fallback) flagged for an owner decision before declaring the D: payload turnkey on a machine that also runs a separate Ollama.

Stopping here per directive. Phase 7-C not started.

---

## Appendix — exact commands
```
# migrate
node scripts/migrate-to-usb.mjs --target=D:\ARGOS --expect-label="Gordy AI" --expect-drivetype=Fixed
# fix settings
cp C:\Users\Gordy\Desktop\ARGOS\config\settings.json D:\ARGOS\config\settings.json
# dev-repo battery
npm run check:full           # 5 pass / 2 fail (both pre-existing)
# boot test (PowerShell, OLLAMA_HOST removed from child)
Start-Process cmd '/c "D:\ARGOS\launcher.bat"' -WindowStyle Minimized
# host-clean
node scripts/verify-host-clean.mjs --capture-before
node scripts/verify-host-clean.mjs --capture-after
node scripts/verify-host-clean.mjs --diff   # 0 ARGOS-attributable (4 non-ARGOS noise)
# scoped teardown (system Ollama 11434 left alive)
taskkill /F /T /PID <11435-ollama> ; taskkill /F /T /PID <7799-next> ; taskkill /F /T /PID <launcher-cmd>
```
