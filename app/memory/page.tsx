import { StubPage, StubSection, StubBullet, StubQuote } from "@/components/StubPage";
import { argosRoot } from "@/lib/vault/paths";

export const metadata = { title: "Memory — ARGOS" };

export default function MemoryPage() {
  const root = argosRoot();
  const display = process.env.ARGOS_ROOT ? root : `${root} (dev)`;
  return (
    <StubPage
      argosRoot={display}
      title="Memory"
      status="v2"
      weekLabel="Week 10–11 · Path B"
    >
      <StubSection title="What this will do">
        <StubBullet>Long-term conversation memory that survives across sessions, not just within the current chat window.</StubBullet>
        <StubBullet>Semantic recall — &ldquo;what did we agree on about USB rule 3 last Tuesday?&rdquo; — answered from prior transcripts.</StubBullet>
        <StubBullet>User-preference learning: stable facts the user re-asserts (timezone, naming conventions, project context) are surfaced automatically.</StubBullet>
        <StubBullet>Per-persona memory persistence — Bartimaeus remembers the strategic conversation you had with Bartimaeus; Juniper does not inherit that.</StubBullet>
      </StubSection>

      <StubSection title="Why not v1">
        <StubBullet>Real memory needs the Core Brain orchestrator — separation of capability (the model) from personality (the persona prompt) from history (the memory store). That orchestrator lands in Week 10–11 of the Path B plan.</StubBullet>
        <StubBullet>v1 personas are prompt presets. They do not have a persistent memory layer; they have a system prompt and the current message history, which dies when the tab closes.</StubBullet>
        <StubBullet>Shipping a "Memory" page that secretly just dumps the message buffer to disk would be a fake feature — exactly what doctrine forbids.</StubBullet>
      </StubSection>

      <StubSection title="The distinction worth making">
        <div>
          <p>
            The <span className="font-mono text-neutral-200">Vault</span> tab is v1&rsquo;s only persistent retrieval surface — it indexes documents you have explicitly handed to ARGOS. That is content addressable by similarity to the current query.
          </p>
          <p className="mt-2">
            <span className="font-mono text-neutral-200">Memory</span> is different. Memory is implicit, derived from conversations, and reasons about &ldquo;what the user is like&rdquo; rather than &ldquo;what does this doc say.&rdquo; v1 has the first; v2 will have both.
          </p>
        </div>
      </StubSection>

      <StubSection title="Roadmap reference">
        <StubQuote>
          &ldquo;STUB (UI present, labeled &lsquo;v2&rsquo;) — Vision tab, Voice button, Memory tab&rdquo;
        </StubQuote>
        <div className="text-[11px] text-neutral-500 mt-2">
          See <span className="font-mono text-neutral-300">docs/02-SCOPE-LOCK.md</span> — Memory is the canonical v2 stub mentioned by name.
        </div>
      </StubSection>
    </StubPage>
  );
}
