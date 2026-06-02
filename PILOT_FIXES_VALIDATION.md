# PILOT_FIXES_VALIDATION.md — three pilot issues (2026-06-02, v2.3.1)

Honest live results. Two issues fully fixed; one is infrastructurally fixed but
blocked by a model limitation that needs an owner decision.

---

## PROBLEM 1 — Bart not using chain_search_to_read — ✅ FIXED

**A) Detector now fires on explicit re-search requests** ("go look", "look it
up", "search the web", "find out", "google it", "look on the internet"). These
set `usePriorMessage: true`, and the chat route uses the IMMEDIATE PRIOR user
message as the query (not the literal command).

**B) Entity/company/current-event queries route to chain_search_to_read** (not
web_search). The detector returns `suggestedTool: "chain_search_to_read"` for
office-holder + news-event categories; the chat route forces the chain and
injects the read page-content (`buildChainBlock`).

Smoke `current-facts:smoke` 21/21:
- "who is the CEO of Lever Soap" → `chain_search_to_read` ✓
- "go look on the internet" → fires, `usePriorMessage: true` ✓
- "look it up" / "search the web for that" → fire ✓
- weather still → `open_meteo_weather` (not chain) ✓

Live (Bartimaeus, royhodge812/Orchestrator):
- **"Who is the CEO of Microsoft"** → **"Satya Nadella is the Chairman and Chief
  Executive Officer of Microsoft."** — routed to chain, read pages, real answer. ✓
- "Who is the CEO of Lever Soap" → honest "no current CEO" — *Lever Soap is a
  defunct brand (Lever Brothers → Unilever, 2001); there is no current company by
  that name to have a CEO.* The mechanism is correct; the example has no answer.

Tool-awareness updated: "chain_search_to_read FIRST … web_search alone returns
shallow snippets … only use web_search for navigational queries."

## PROBLEM 3 — Enter key doesn't send — ✅ FIXED

`components/ChatPane.tsx` composer keydown:
- **Enter** (no Shift) → send (ignores IME composition)
- **Shift+Enter** → newline (default)
- **Cmd/Ctrl+Enter** → still sends (muscle memory)
- Placeholders updated to "(Enter to send, Shift+Enter for newline)".

Verified: typecheck/lint/build clean; `smoke-h2 (chat)` green.

## PROBLEM 2 — Bart denies having memory — ✅ RESOLVED (model swap, v2.3.2)

**UPDATE (2026-06-02, v2.3.2):** Owner-approved model swap fixed this. Bart's
bound model changed from `royhodge812/Orchestrator:lates` →
`aratan/gemma-4-E4B-q8-it-heretic:latest`. Live 2-turn gate
(`scripts/validate-bart-memory.mjs`) now PASSES:
- Turn 1: "My project is codenamed Asher" → *"Understood. Asher. A designation…
  I shall file it under 'Current Obsession'"* (in character).
- Turn 2: "What did I just tell you my project is codenamed?" → **"You told me
  your project is codenamed Asher."** Contains "Asher", no memory denial. ✓
The infra/prompt groundwork below was correct all along; it just needed a model
that honors context. The new model also fits the 8 GB rig better (8.1 vs 9.6 GB).
Honest note: the gemma-4 model is somewhat MORE verbose than Orchestrator (and
occasionally emits markdown footnote syntax) — restraint character lands, brevity
is looser. Accepted per the owner's evaluation ("better Bart than Orchestrator").

The original diagnosis (kept for the record) follows.

---

### Original diagnosis — INFRA FIXED, BLOCKED BY MODEL (pre-swap)

**Diagnosis (the important part).**

A) **Conversation context IS passed.** Verified in `app/api/chat/route.ts`: the
full `body.messages` array (every turn) is sent to the model as the Ollama
message list. Not a context bug.

B) **The prompt now tells Bart he has memory** — added a forceful memory-
capabilities block to his persona, then escalated it, then moved it to the
absolute end, then added a final conversation-memory reminder as the LAST system
content immediately before the thread (max recency). Four strategies.

**Result: Bart still denies it.** On a clean 2-turn conversation where the
operator says "My project is codenamed Asher" (and Bart even acknowledges
"Asher" in turn 1), turn 2 "What did I just tell you my project is codenamed?"
yields: *"You have not told me what project you are working on."*

**Control test — same route, same conversation, different model (Bobby /
notmythos-8b):** *"You told me that your project is codenamed 'Asher'."* ✓ every
time.

**Conclusion:** this is a **model-integrity limitation of `royhodge812/
Orchestrator`** (Bart's owner-locked model). It reflexively recites a "no memory
of past interactions" disclaimer and ignores visible context — and it is **not
promptable** (four strategies failed). It is NOT a route bug (Bobby proves the
path is correct) and NOT a persona-logic bug (the prompt is correct and forceful).

**What shipped for Problem 2 (correct + harmless):**
- Accurate memory-capabilities text in Bart's persona.
- A last-position conversation-memory reminder in the chat route (only on
  multi-turn sessions; general wording; Bobby/Juniper/Sage unaffected — they
  already handle context correctly).
- These take effect the moment Bart is bound to a context-respecting model.

**OWNER DECISION (made, 2026-06-02):** swapped Bart's bound model to
`aratan/gemma-4-E4B-q8-it-heretic:latest` — see the RESOLVED note at the top of
this section. Memory now works.
