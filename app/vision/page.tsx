import { StubPage, StubSection, StubBullet } from "@/components/StubPage";
import { VisionStatusPanel } from "@/components/vision/VisionStatusPanel";
import { getRuntimeInfo } from "@/lib/runtime-info";
import { getVisionModel, visionModelAvailable } from "@/lib/vision";

export const metadata = { title: "Vision — ARGOS" };

export default async function VisionPage() {
  const runtime = await getRuntimeInfo();
  const display = runtime.isDev
    ? `${runtime.argosRoot} (dev)`
    : runtime.argosRoot;

  // Server-side model presence check (stat-only via Ollama /api/tags).
  let available = false;
  try {
    available = await visionModelAvailable();
  } catch {
    available = false;
  }

  return (
    <StubPage
      argosRoot={display}
      version={runtime.version}
      startedAt={runtime.startedAt}
      title="Vision"
      status={available ? "live" : "model-missing"}
      weekLabel="Vision Phase 1"
    >
      <StubSection title="Live status">
        <VisionStatusPanel />
      </StubSection>

      <StubSection title="What this does">
        <StubBullet>
          Image drop: attach images in the chat composer (left of the mic).
          ARGOS routes the turn to the multimodal model{" "}
          <span className="font-mono text-neutral-300">{getVisionModel()}</span>{" "}
          and returns the analysis in the active persona&apos;s voice — the
          character never changes, only the model.
        </StubBullet>
        <StubBullet>
          File vision: drop an image into the Vault and ARGOS auto-describes it,
          then makes that description searchable through the existing retrieval
          pipeline.
        </StubBullet>
        <StubBullet>
          Screenshot awareness: capture your screen via the toolbar camera
          (Chrome/Edge getDisplayMedia) — it attaches like any other image.
        </StubBullet>
        <StubBullet>
          Local &amp; honest: images are sent only to the local Ollama daemon.
          If the vision model isn&apos;t installed, image turns return a clear
          error rather than crashing.
        </StubBullet>
      </StubSection>

      <StubSection title="Requirements">
        <StubBullet>
          The multimodal model must be pulled in Ollama:{" "}
          <span className="font-mono text-neutral-300">
            ollama pull {getVisionModel()}
          </span>
          . Text-only chat is unaffected when it&apos;s absent.
        </StubBullet>
        <StubBullet>
          Screenshot capture needs a Chromium browser (Chrome/Edge) for
          getDisplayMedia; the button hides itself elsewhere.
        </StubBullet>
      </StubSection>
    </StubPage>
  );
}
