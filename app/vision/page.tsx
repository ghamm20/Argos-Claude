import { StubPage, StubSection, StubBullet, StubQuote } from "@/components/StubPage";
import { getRuntimeInfo } from "@/lib/runtime-info";

export const metadata = { title: "Vision — ARGOS" };

export default async function VisionPage() {
  const runtime = await getRuntimeInfo();
  const display = runtime.isDev
    ? `${runtime.argosRoot} (dev)`
    : runtime.argosRoot;
  return (
    <StubPage
      argosRoot={display}
      version={runtime.version}
      startedAt={runtime.startedAt}
      title="Vision"
      status="v2"
      weekLabel="Week 8 · Path B"
    >
      <StubSection title="What this will do">
        <StubBullet>Local image analysis via LLaVA or Moondream (no cloud upload).</StubBullet>
        <StubBullet>OCR for text extracted from images.</StubBullet>
        <StubBullet>Object and scene description, returned by the active persona.</StubBullet>
        <StubBullet>Image-grounded queries — &ldquo;what&rsquo;s in this photo?&rdquo; — with retrieval cross-reference into the vault.</StubBullet>
      </StubSection>

      <StubSection title="Why not v1">
        <StubBullet>Vision-capable models add 4–7 GB to the USB payload. The current v1 USB image is sized for Ollama + the three locked models (~7.1 GB); adding LLaVA would push us past 12 GB.</StubBullet>
        <StubBullet>Inference latency on the ThinkPad target (CPU mode, 16 GB RAM, integrated GPU) is 30–60 s per image. That is not a UX we are willing to ship.</StubBullet>
        <StubBullet>v1 ships chat + retrieval. Vision is a Week 8 deliverable on the Path B plan once the inference budget is reallocated.</StubBullet>
      </StubSection>

      <StubSection title="Roadmap reference">
        <StubQuote>
          &ldquo;CUT (do not build) — Real voice, real vision&rdquo;
        </StubQuote>
        <div className="text-[11px] text-neutral-500 mt-2">
          See <span className="font-mono text-neutral-300">docs/02-SCOPE-LOCK.md</span> in the repo for the full v1 ship / stub / cut breakdown.
        </div>
      </StubSection>

      <div
        data-testid="vision-input-disabled"
        aria-disabled="true"
        className="block rounded-lg border-2 border-dashed border-neutral-800/70 bg-neutral-950/40 p-10 text-center cursor-not-allowed relative overflow-hidden"
      >
        <div className="text-neutral-600 text-[13px]">Vision input area</div>
        <div className="text-neutral-700 text-[10px] uppercase tracking-[0.2em] mt-1">
          coming v2
        </div>
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(135deg,transparent_47%,rgba(245,158,11,0.18)_50%,transparent_53%)] bg-[length:14px_14px]" />
      </div>
    </StubPage>
  );
}
