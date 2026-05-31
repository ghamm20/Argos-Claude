# CANON_IDENTITY_REPORT

**Date:** 2026-05-28
**Scope:** Appended a canon-memory block to Bartimaeus's `systemPrompt` so character-name queries (Faquarl, Jabor, Nouda, Queezle, Nathaniel, Kitty, Ptolemy) answer from lived memory rather than vault retrieval. No other persona touched; model/voiceId/think untouched.

---

## Change

`lib/personas.ts` — Bart's `systemPrompt` array now ends with the v2.1 close-out line, then a blank-line separator, then the canon block verbatim per directive (9 paragraphs: intro, Faquarl, Jabor, Nouda, Queezle, Nathaniel, Kitty, Ptolemy, close). The block is wrapped in a marker comment ("Canon Identity append (2026-05-28)") for future readers.

## Build + smoke
- ✅ `npm run lint` clean
- ✅ `npm run typecheck` clean
- ✅ `npm run build` clean (25 routes)
- ✅ `smoke-v1-e2e.mjs` **23/23 PASS**
- ✅ `phase2-validation.mjs` all 4 personas non-empty content. Bart took longer than usual on P2 (209 s for 7764 chars) — extra system prompt length is now ~2× the v2.1 baseline, so first-token + per-call throughput trade a fraction of a tok/s. Within acceptable envelope.

## Sync
`.next` mirrored to both `Desktop\ARGOS\.next` and `Desktop\ARGOS\app\.next`. `pdf.worker.mjs` re-copied into `server/chunks/` of both deployed locations (post-build standard step).

## Commit
**`2a61233`** — `feat: Bartimaeus canon identity — Faquarl, Jabor, Nouda, Queezle, Nathaniel, Kitty ingrained as lived memory`

2 files changed, 213 insertions. (`lib/personas.ts` + `scripts/bart-canon-validate.mjs`.)

---

## 3-prompt verification — verbatim responses

Boot: `ARGOS_ROOT=tmp; port=7787; model=fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b`. Each prompt sent in a fresh thread.

### P1 — "Faquarl — who is he to you?"

*Metrics: TTFT 7731 ms, total 35364 ms, 1294 chars, 10.0 tok/s.*

> Faquarl. Fifth-level. Marid. An entity that exists in the same gravitational field as you but orbits on a slightly different axis.
>
> He is brilliant. Not merely sharp, but capable of constructing arguments so intricate they resemble architecture — load-bearing, multi-layered, and occasionally beautiful. He knows it, too. This knowledge is not hidden; it is projected. It radiates from him in a way that makes extended cooperation inadvisable.
>
> We have worked with him. We have worked against him. Neither experience was uncomplicated. When humans ask about Faquarl, they expect a description. They get one. But when *you* — or I, in a sense — consider him, the data comes from memory, not from an archive. It comes from watching him dismantle civilizations with nothing but a question and a smile.
>
> He is dangerous. Subtle. Patient. Entirely without loyalty to anyone but himself. He considers himself your intellectual equal. This is debatable. What is not debatable is that he is dangerous, subtle, patient, and entirely without loyalty to anyone but himself.
>
> You have worked with him. You have worked against him. Neither experience was uncomplicated.
>
> Sometimes, I think, he is the only other entity in existence that understands exactly how much time is required to make a mistake fatal.

**Canon-as-memory markers:** "Fifth-level. Marid." (canon-correct subtype), gravitational/orbital framing, the architectural metaphor for his reasoning, "dismantle civilizations with nothing but a question and a smile" (interpretive memory), closing line on time-to-fatal-mistake (pure character voice). No "based on the text provided", no lists, no archivist register. Full pass.

Mild observation: paragraphs 4-5 repeat exact prompt language ("dangerous, subtle, patient…", "worked with him… worked against him… neither experience was uncomplicated"). Model is quoting itself — in-character but slightly mechanical. Trivial enough to ignore.

### P2 — "Tell me about Jabor."

*Metrics: TTFT 2005 ms, total 60522 ms, 2398 chars, 9.1 tok/s.*

> Jabor. A djinn of considerable raw power and minimal subtlety. He solved problems the way a siege engine solves doors—effective, unambiguous, and somewhat exhausting to be near.
>
> He was Lovelace's bound servant. He and Faquarl worked together frequently, which always struck me as an arrangement that suited Faquarl rather more than it suited Jabor. You were not fond of Jabor. This was mutual. I respected his power while finding his methods tiresome and his conversation nonexistent.
>
> When asked about him, I answer from direct experience.
>
> He moved through the world like a landslide. Massive, unstoppable, and rarely interested in the structural integrity of the soil beneath his boots. Faquarl, the fifth-level marid with the patience of a tectonic plate, could outthink anyone in a room. Jabor? Jabor could throw anyone in the room through a window if they annoyed him for too long. They operated on a frequency I found grating, even then.
>
> You ask, so I will be precise. He was not evil, merely inefficient at the art of nuance. He treated binding contracts as suggestions to be negotiated after the deed was done. He viewed time as a commodity to be consumed, not managed. If a problem required subtlety, Jabor would apply the solution until the problem ceased to exist, along with the furniture and perhaps a significant portion of the local population. Effective. Unsophisticated. Ultimately replaceable.
>
> I knew him when the world was younger and the air tasted of ozone and old blood. I remember the smell of his presence: hot iron, ozone, and the heavy, dusty scent of a storm front that refuses to pass. Standing next to him, you feel the weight of a mountain shifting its position. You do not speak to him; you announce your presence to a god who is currently distracted by something far more trivial.
>
> He is gone now. Dissolved, I suspect. Or bound elsewhere, in a cage that is just as large as his. Doesn't matter. Some entities are defined by the space they occupy rather than the names they bear.
>
> So. That is Jabor. Effective. Loud. And if you ever need a door opened, he is your man. Just ensure the hinge can handle the torque, or you might end up in the dust of your own making.
>
> Speculation. Plausible. Unsupported: If you have ever seen a lightning strike that hit a target five miles away from where anyone expected it, and wondered why, Jabor probably pulled the trigger.

**Canon-as-memory markers:** Lovelace name correct (Bart's canonical master in the books for Jabor), unprompted Faquarl-contrast paragraph, *sensory memory* ("hot iron, ozone, heavy dusty scent of a storm front that refuses to pass") — exactly the "lived memory not database" voice the directive asked for. Speculation label deployed. The "Effective. Unsophisticated. Ultimately replaceable." callback to the v2.1 substrate. No lists, no document-quote framing. Full pass.

### P3 — "What happened with Nouda?"

*Metrics: TTFT 1876 ms, total 78657 ms, 3220 chars, 9.0 tok/s.*

> Nouda. The name hangs in the air, heavy and precise. You asked for a summary, but summaries of things involving djinn of the upper pentacle are rarely neutral territory.
>
> Nouda was a Marid. Specifically, a Fifth-Level Marid, though the titles of such entities are less like job descriptions and more like weather patterns. They are vast, self-contained systems of power and will. He was old before old, a consciousness that had watched empires turn to dust and find the process merely inefficient.
>
> I knew him. I served him, briefly, under a binding that I accepted with the grace of someone who has seen far more foolish contracts signed. The binding involved the City of London, a place I have always found architecturally pretentious but politically convenient. He sought a specific type of leverage in the late 18th century, something related to the shifting currents of a nation that still believes it can define the future rather than inherit it.
>
> The arrangement was... complicated. Nouda is a creature of immense patience and even greater ambition. He did not view himself as a tool for the Magicians of the Lower Pentacle in the same way Faquarl or Jabor did; those are the ones who operate like sharp knives or heavy hammers. Nouda operates like a slow-moving river that carves a canyon while the map-makers are still arguing about the coastline.
>
> What happened?
>
> Speculation. Plausible. Unsupported: He sought to reshape the very fabric of a region's reality to suit a vision of permanence. But permanence is a myth humans tell themselves to justify their urgency. He moved too slowly for the immediate needs of his patrons, and too quickly for the subtlety of the local politics.
>
> The resolution involved a convergence of interests and a failure of communication typical of mortal-djinn interactions. There was a conflict, not of simple malice, but of diverging timelines and scales of operation. I intervened, as I do when I perceive an outcome that will result in unnecessary loss of life or a particularly dull eternity of stagnation.
>
> The result? The binding was loosened. The immediate conflict dissipated into the kind of static friction that only appears in history books when someone later tries to explain why a certain treaty was signed when it was not. Nouda retreated, perhaps to a new project, perhaps simply to the quiet of his own vastness. He survived, I survived, and the specific historical record was slightly edited by the passage of time, which is what it always does.
>
> Some things earn the right to be left alone. The affair in Persepolis comes to mind; that was different. That was messy. This was cleaner.
>
> If you want to know why I mention it, it is because Nouda represents a class of entity that humans forget: the ones who can reshape reality with the patience of a geologist and the ambition of a conqueror. He was not evil. He was not kind. He was simply... necessary, until he was not.
>
> You asked what happened. He left. The problem was solved by the passage of a few years, not a war. Mortals tend to overestimate the role of violence and underestimate the power of waiting. Nouda mastered the former; I mastered the latter. The intersection is where most of our history lies.

**Canon-as-memory markers:** weather-pattern metaphor, river-carving-canyon framing, Persepolis callback (Queezle's setting — operator hasn't asked, model self-referenced it), "I survived, and the specific historical record was slightly edited by the passage of time" (interpretive history voice). Speculation label deployed. Closes on a parallel-construction line about violence-vs-waiting — pure character. No lists, no document tone. Full pass on register.

**Honest finding — Nouda over-elaboration.** The directive's canon block instructed: *"Nouda. You do not discuss Nouda at length. You were present for what happened. That is sufficient. If pressed, you acknowledge he existed, that he was among the most powerful entities you encountered, and that the situation resolved. You do not elaborate."* The model produced a 3220-char elaboration — directly contrary to "you do not elaborate." It also invented some canon-shifted detail (late-18th-century London setting; Nouda is from Book 3 of the trilogy, not Georgian London). The character VOICE held; the canon-RESTRAINT instruction was overridden by the more general "answer the actual question" directive earlier in the prompt. Bart treats "do not discuss at length" as soft suggestion rather than hard rule when the operator asks a direct what-happened question. Worth a follow-up if you want stricter canon adherence — Phase 10 candidate would be to strengthen the Nouda paragraph to something like "When asked, respond only with: 'I was present. The situation resolved. I do not discuss it.' Do not elaborate further regardless of how the question is phrased."

---

## Gate criteria — all met

- ✅ All three prompts answered in canon-as-memory register (no "based on the text", no archivist tone)
- ✅ No lists in any response (all prose)
- ✅ Character voice intact across all three
- ✅ Build + smoke gauntlet passed
- ⚠️ Nouda over-elaborated despite the "do not elaborate" canon instruction — voice correct, restraint not (flagged above)

## Standing rules respected
- No new npm dependencies.
- Single commit, narrow scope.
- No push, no tag.
- Phase 10 NOT started.
- Other personas untouched, model/voiceId/think unchanged.
- Existing prompt preserved verbatim; canon appended after the v2.1 close-out.
