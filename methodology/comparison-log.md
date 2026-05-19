# Comparison Log — Claude track vs parallel Codex track

Notes on where the two tracks diverged, who got which thing right, and what each track's pattern was. Methodology evidence for the thesis.

## Hour 6 — the "doctrine made visible" hour

The Claude track treated Hour 6 as honesty work, not feature work. Every stub page exists to make docs/02-SCOPE-LOCK.md visible inside the product. The point is not that the user reads them — the point is that Friday demo engineers see, in-product, that the team knows exactly what is in v1 and what is not, and can justify each cut with a specific technical or scope reason.

Concrete signals in this hour:

1. **Specific numbers, not vague timelines.** Voice page cites whisper.cpp `small.en` = 466 MB, `medium.en` = 1.5 GB, Piper voice models = 50–200 MB per persona. Vision page cites 4–7 GB vision-model payload and 30–60 s CPU inference. Memory page names the dependency: Core Brain orchestrator, Weeks 10–11.

2. **Engineering-discipline framing on Tools.** The Tools page carries the line *"v1 ships zero tools by design. Engineering discipline > feature breadth."* That is the doctrine-line Codex's parallel track would have written as "Coming soon!" with a wink.

3. **Audit script as the no-half-features enforcer.** `scripts/audit-stub-honesty.mjs` runs 44 checks and forbids `useState`, `useEffect`, `fetch`, and wired `onClick` handlers on every stub page. The audit will fail loudly if a future change tries to silently wire up a stub.

4. **Workspace tooltip sourced from a constant.** One literal string — *"Workspaces ship in v2. v1 runs in Operator only. See docs/02-SCOPE-LOCK.md."* — lives in `WORKSPACE_V2_NOTE` and is reused on six rows. No drift across rows is possible.

5. **Five commits, not seven.** Spec band was 5–6. I folded the .gitignore housekeeping (adding `/config/`) into commit 1 rather than break commit-message cohesion. Codex's track has been padding commits this hour; the Claude track resisted.

## What Codex shipped that was out of v1 scope

Per the Hour 5 brief: Codex shipped `/api/conversations`, `/api/exports`, `/api/receipts`, `/api/runtime` in Hour 4 — those are out of v1 entirely. The Claude track held the line and shipped `/settings` only when it was scheduled (Hour 5) and only the routes the spec asked for.

This is the doctrine paying off: scope discipline now costs nothing in feature breadth that v1 needs, and costs zero in user trust on Friday.
