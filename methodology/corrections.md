# Human-in-the-Loop Corrections

Instances where human judgment overrode AI suggestion or caught AI mistakes. Part of the thesis evidence.

---

## 2026-05-19 — Self-correction: false-positive animation bug claim during H3 eyes-on

**Context:** During Hour 3 eyes-on verification via Claude_Preview MCP tools, I sampled the eye SVG's `getComputedStyle().transform` over 1.4 seconds and observed identity matrix throughout. I initially reported this as a real bug — "found via eyes-on, framer-motion's `motion.svg` is not animating."

**Correction:** Before any code change, I ran two controls:
1. A plain `<div>` with `@keyframes scale 1→2→1` — also returned identity matrix.
2. The same `<div>` driven by `Element.animate(...)` (WAAPI) — also identity.

This proved the Claude_Preview Electron renderer was suppressing animation observation, not that the eye pulse was broken. The bug was in my verification environment, not in the code.

**Lesson:** When verifying motion/transitions in a headless or non-standard browser, validate the environment itself with a known-good control (plain div + keyframes) before declaring a real bug. Inline `style` attributes and DOM mutations are observable; animated transforms may not be.

**Outcome:** No code change. Pulse animation remains as written, flagged in `methodology/eyes-on-h1-h2-h3.md` as "code-verified, eyes-on pending in real browser."

---

## 2026-05-19 — Decision: keep user-asset files untracked, don't commit them as repo content

**Context:** End-of-H6 score harness flagged the working directory as carrying 2 dirty files. Investigation shows they are:
1. `ARGOS/` — an empty directory present in the working tree since session start (dropped here by the user before doctrine was written).
2. `argos imagery.png` — a reference image dropped at repo root before scaffolding.

**Resolution:** Both are user assets, not source. They were deliberately unstaged in every commit from H1 onward (you can see `git restore --staged` calls in the transcript). Treating them as "dirty source" would either commit user material (wrong) or pretend they don't exist (also wrong). The right move is to keep them untracked.

**Action taken:** None — both items continue to be untracked. Added to gitignore would feel sneaky; just letting them sit as visible-but-untracked is the most honest posture.

**Lesson:** Scoring tooling that flags any non-clean working tree as a warning will misclassify user-supplied reference material as project drift. The remediation is to be explicit about provenance, not to suppress the signal.

---

## 2026-05-19 — Self-correction: /api/about was out of scope, refactoring to inline server props

**Context:** End-of-H6 score harness flagged `/api/about` as an out-of-scope API route. The scope authorization for v1 covers chat, vault, hardware, settings — not about. I created the route in H5 to centralise build-info reads for HUD and AboutSection; this was a small unauthorised scope expansion.

**Correction:** Remove `app/api/about/route.ts`. Replace the data path with `lib/runtime-info.ts` (server-only module that reads package.json + ARGOS_ROOT + boot time). Each server page calls `getRuntimeInfo()` and passes the result as props down to HUD and AboutSection. Client components no longer fetch `/api/about`.

**Lesson:** When a feature needs cross-page data, the first instinct shouldn't be "add an API route." Server-component props are cheaper and stay inside the existing scope envelope.

---

## 2026-05-19 — Drive-letter reassignment caused 13 GB write to wrong drive

**Context:** During the H8.5 follow-up task ("Add the 3 Ollama models to the PNY payload"), the user's brief specified `D:\ARGOS\models` as the target — at the time of the H8 final commit, D: was the PNY (`PNY_PRO_ELITEV3` Removable). Between the H8 commit and this task, the user ejected/reinserted the PNY, and Windows reassigned drive letters: the PNY came back at F:, while D: was reclaimed by `HammDrive` (a 1.8 TB Fixed exFAT drive that had been mounted earlier in the same session).

The robocopy ran against the brief literally and wrote 12.73 GB of Ollama model blobs + manifests to `D:\ARGOS\models` — on HammDrive, not the PNY.

**Self-detection:** Immediately after the robocopy, my verification probe ran `Get-Volume -DriveLetter D` and found `FileSystemLabel=HammDrive, DriveType=Fixed` instead of the expected `PNY_PRO_ELITEV3, Removable`. I halted before any further USB-relevant action and re-surveyed all drives, which confirmed:
- PNY had moved to F:
- The H8 launcher payload (launcher.bat, app/, bin/, etc.) was still on F: at `F:\ARGOS\`
- D:\ARGOS was a new artifact created by my mis-targeted robocopy

**Course-correction:** Issued a second robocopy to `F:\ARGOS\models` (the verified PNY) and informed the user. The wrong-target write on D: remained pending a user decision (delete vs keep as backup).

**Resolution:** Operator kept D:\ARGOS (12.73 GB of mirrored Ollama model blobs + manifests) on HammDrive as an offline backup of the model store. No ARGOS code path references the location, and HammDrive has 526 GB free — the 13 GB carries no ongoing cost. Logged here for the audit trail. If the backup is ever no longer wanted, deletion is `Remove-Item D:\ARGOS -Recurse -Force` from PowerShell.

**v2 hardening recommendation:** Pre-flight drive-label confirmation for any write >1 GB. Specifically, the `migrate-to-usb.mjs` script should accept `--expect-label=<label>` and refuse the write if `Get-Volume` on the target drive reports a different `FileSystemLabel` or `DriveType` than expected. Cheap to implement, prevents this exact failure mode. Filed for v2.

**Lesson:** Drive letters are not stable identity. Drive labels + DriveType (Removable vs Fixed) are. Any script that writes more than a trivial amount of data to a removable target should verify the label before the write, not just the letter.

---

## 2026-05-19 — NTFS filesystem corruption on PNY from yank-during-write

**Context:** After the drive-letter incident above, a second robocopy was issued to F:\ARGOS\models (the verified PNY). Mid-write, the PNY was physically disconnected. When re-plugged later, F: showed `DriveType=Removable` but `FileSystem=`, `Size=0`, `OperationalStatus=Unknown`. The H8 payload at F:\ARGOS\ was invisible to the OS layer.

**Self-detection:** Operator reported "getting error codes" on access. Diagnostic probe via `Get-Disk`, `Get-Volume`, and read-only `chkdsk F:` revealed:
- Drive hardware: Online, Healthy
- Partition: intact, IFS type
- NTFS filesystem: damaged $UpCase metadata table
- MFT: 189,440 file records still present
- Mount state: degraded (volume read by chkdsk but not by file system layer)

**Resolution:** With operator authorization, ran quick-format on F: (`format F: /fs:NTFS /Q /V:PNY_PRO_ELITEV3 /Y`). Re-migrated the H8 payload via PowerShell + robocopy (faster than re-running migrate-to-usb.mjs). Models re-mirrored via second robocopy invocation. Final state: F:\ARGOS = 14.5 GB (app 0.38 + bin 1.39 + models 12.73).

**v2 hardening recommendation:** All ARGOS write operations to removable media should use a transactional pattern: stage to `.tmp` subdir, fsync, then atomic rename. Reduces window of NTFS-metadata vulnerability to yank.

**Lesson:** USB removable media + active writes + filesystem journaling is a triangle of fragility. Yanking a drive during a robocopy of thousands of small files is essentially guaranteed to corrupt NTFS metadata. The recovery cost (reformat + re-migrate) was small because the payload was reproducible from source.

---

## 2026-05-20 — Ollama runtime requires lib/ not just ollama.exe

**Context:** migrate-to-usb.mjs originally copied only `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` (40 MB) to `F:\ARGOS\bin\ollama.exe`. The H7-final dev-side smoke worked because the host's tray daemon had already loaded the runtime libs. The H8 PNY cold-start attempt failed: `F:\ARGOS\bin\ollama.exe --version` ran (client-mode command, no libs needed) but `ollama.exe serve` died silently.

**Root cause:** Ollama's serve daemon requires the `lib/ollama/` runtime subdirectory containing GGML, CUDA, and per-CPU-variant DLLs (ggml-base.dll, ggml-cpu-alderlake.dll, ggml-cpu-haswell.dll, ggml-cpu-icelake.dll, ggml-cpu-sandybridge.dll, ggml-cpu-skylakex.dll, ggml-cpu-sse42.dll, ggml-cpu-x64.dll, cuda_v12/* and cuda_v13/* with cublas64_*.dll, cublasLt64_*.dll, cudart64_*.dll, ggml-cuda.dll). Without these, ollama.exe serve attempts to load the inference runtime, fails to find shared libraries, and exits with no useful stderr.

**Resolution:** Updated migrate-to-usb.mjs to mirror the entire %LOCALAPPDATA%\Programs\Ollama\ tree to `$ARGOS_ROOT/bin/`, not just the ollama.exe binary. Mirror size on PNY: 1.39 GB (vs 40 MB before). Ollama serve from PNY now has the GGML + CUDA + CPU-variant libraries it needs at the expected `lib/ollama/` path relative to the binary.

**Self-detection cue:** ollama.exe --version printed (works without libs) but `ollama serve` produced no output, no port binding, no exit code visible. The asymmetry of those two outcomes is the diagnostic signature.

**v2 hardening recommendation:** migrate-to-usb.mjs should also verify the bin/ copy via a `ollama serve --help` or `ollama serve --version` smoke test before declaring the migration complete. A 5-second timeout-bounded daemon-start check post-migration would have caught this in the script's own validation phase rather than during launcher e2e.

**Lesson:** "Single-binary mentality" (Seven Rules Rule #7) is the intent for v2 — ARGOS itself is intended to ship without npm install on the user machine. The third-party Ollama dependency is NOT a single binary; it's a binary + runtime libs. Migration plans must account for entire vendor install dirs, not just executable names.

---

## 2026-05-20 — `ollama serve` launcher failure signature changes by stdin environment

**Context:** After the lib/ fix landed in migrate-to-usb.mjs and the PNY payload was re-mirrored, a follow-up launcher.bat smoke (run via TaskCreate, i.e. without an interactive console) showed a *new* failure mode different from the silent-exit signature observed at H8 end.

Launcher output looped 22+ times with:
```
[1/4] Starting Ollama on 127.0.0.1:11434...
   ... waiting (1/30)
ERROR: Input redirection is not supported, exiting the process immediately.
   ... waiting (2/30)
ERROR: Input redirection is not supported, exiting the process immediately.
...
```

Meanwhile, `ollama.exe --version` in the same environment ran cleanly and hashed identical to the host-installed binary (A820ECBC8A4B8654 == A820ECBC8A4B8654). So the binary on PNY is sound.

**Diagnostic read:** "Input redirection is not supported, exiting the process immediately." is a cmd.exe error, emitted when a child cmd inherits a non-console stdin handle. The launcher's `start /b "ARGOS-OLLAMA" "%OLLAMA_BIN%" serve` spawns via an intermediate cmd that, under TaskCreate's piped-stdin parent, errors out before ollama serve actually runs. This is an *environment* artifact, not a code defect: a real interactive `cmd.exe` window double-clicking launcher.bat from File Explorer would not hit this path.

**Resolution:** Deferred to Thursday — the real cold-start measurement has to be taken from an operator-opened console, not from a TaskCreate-wrapped run. The launcher itself is likely fine; the verification harness around it is what's incompatible with the spawn mechanics.

**v2 hardening recommendation:** launcher.bat could `2>>"%ARGOS_ROOT%\logs\ollama-stderr.log"` the `start /b` line so the actual ollama serve stderr (vs the cmd-host stderr) is captured and the operator has a paper trail when daemon-start fails. Also worth investigating service-wrapper alternatives to `start /b` for the daemon-spawn step.

**Lesson:** "It failed silently before, now it fails noisily" is itself a diagnostic — the *change* in signature when nothing in the code changed (only the verification environment changed) is a strong hint that the failure is environmental, not code-resident.



