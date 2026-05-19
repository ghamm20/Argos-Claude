import { StubPage, StubSection, StubBullet, StubQuote } from "@/components/StubPage";
import { getRuntimeInfo } from "@/lib/runtime-info";

export const metadata = { title: "Tools — ARGOS" };

export default async function ToolsPage() {
  const runtime = await getRuntimeInfo();
  const display = runtime.isDev
    ? `${runtime.argosRoot} (dev)`
    : runtime.argosRoot;
  return (
    <StubPage
      argosRoot={display}
      version={runtime.version}
      startedAt={runtime.startedAt}
      title="Tools"
      status="v2+"
      weekLabel="Post-launch · Path B"
    >
      <StubSection title="What this will do">
        <StubBullet>Calculator — local arithmetic without round-tripping through the model.</StubBullet>
        <StubBullet>OCR — extract text from images, separate from the Vision feature&rsquo;s analysis.</StubBullet>
        <StubBullet>Summarization — single-pass over a doc or chunk, tunable length.</StubBullet>
        <StubBullet>Document conversion — between supported formats (md ↔ docx ↔ txt).</StubBullet>
        <StubBullet>Timeline builder — extract dated events from a vault doc into a chronology.</StubBullet>
        <StubBullet>Image analysis — narrow tool surfacing the Vision pipeline as a callable utility.</StubBullet>
        <StubBullet>Structured export — pull conversations or retrievals into JSON / CSV.</StubBullet>
      </StubSection>

      <StubSection title="Why not v1">
        <StubBullet>The tool system is post-launch entirely. v1 ships chat + retrieval. Tools are a post-v1 expansion that requires the Core Brain orchestrator (Weeks 10–11) plus a per-tool UI surface that does not currently exist.</StubBullet>
        <StubBullet>Each tool also needs an honest spec for when the model should reach for it vs answer directly. That decision layer is the same Core Brain work — a tool framework on top of personas, not bolted onto the chat input.</StubBullet>
        <StubBullet>Shipping fake tool tabs that secretly call the chat endpoint with a different system prompt would be a lie. The model can already &ldquo;summarize this&rdquo; in chat — that does not make summarization a tool.</StubBullet>
      </StubSection>

      <StubSection title="Engineering discipline">
        <div className="text-[14px] text-neutral-200 leading-relaxed">
          v1 ships zero tools by design. Engineering discipline &gt; feature breadth.
        </div>
        <div className="mt-2">
          The product Friday-demo metric is &ldquo;does the locked v1 scope work end-to-end on a USB drive with no host residue,&rdquo; not &ldquo;how many tabs are populated.&rdquo;
        </div>
      </StubSection>

      <StubSection title="Roadmap reference">
        <StubQuote>
          &ldquo;CUT (do not build) — Tool system, multi-workspace&rdquo;
        </StubQuote>
        <div className="text-[11px] text-neutral-500 mt-2">
          See <span className="font-mono text-neutral-300">docs/02-SCOPE-LOCK.md</span>. The Tool system is explicitly under CUT for v1 — this page exists so that doctrine is visible in-product, not hidden in a markdown file.
        </div>
      </StubSection>
    </StubPage>
  );
}
