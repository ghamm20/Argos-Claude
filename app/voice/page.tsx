import { Mic } from "lucide-react";
import { StubPage, StubSection, StubBullet, StubQuote } from "@/components/StubPage";
import { argosRoot } from "@/lib/vault/paths";

export const metadata = { title: "Voice — ARGOS" };

export default function VoicePage() {
  const root = argosRoot();
  const display = process.env.ARGOS_ROOT ? root : `${root} (dev)`;
  return (
    <StubPage
      argosRoot={display}
      title="Voice"
      status="v2"
      weekLabel="Week 6 · Path B"
    >
      <StubSection title="What this will do">
        <StubBullet>Local speech-to-text via Whisper.cpp — no cloud upload of microphone audio.</StubBullet>
        <StubBullet>Local text-to-speech via Piper, with persona-specific voice models so Bartimaeus, Juniper, Sage, and Bobby each have their own timbre.</StubBullet>
        <StubBullet>Push-to-talk modal: hold a key, speak, release to send.</StubBullet>
        <StubBullet>Honest transcript: the STT output is shown verbatim before sending, so the user can correct mis-hearings rather than ship them to the model.</StubBullet>
      </StubSection>

      <StubSection title="Why not v1">
        <StubBullet>Whisper.cpp models add 1–3 GB to the USB payload (the small.en model is 466 MB; medium.en is 1.5 GB). Stacked on top of three Ollama models, that pushes us into double-digit GB.</StubBullet>
        <StubBullet>Piper voice models are 50–200 MB per persona. Four personas = 200–800 MB extra, on top of the STT model.</StubBullet>
        <StubBullet>Audio I/O permissions vary per browser, per OS, and per user. Getting that prompt-once-correctly flow right is a week of UX work we have not budgeted for v1.</StubBullet>
        <StubBullet>v1 ships text-only chat. Voice is the Week 6 deliverable on the Path B plan.</StubBullet>
      </StubSection>

      <StubSection title="Roadmap reference">
        <StubQuote>
          &ldquo;STUB (UI present, labeled &lsquo;v2&rsquo;) — Vision tab, Voice button, Memory tab&rdquo;
        </StubQuote>
        <div className="text-[11px] text-neutral-500 mt-2">
          See <span className="font-mono text-neutral-300">docs/02-SCOPE-LOCK.md</span> for the full scope lock — voice is listed under STUB with the v2 label, exactly what this page reflects.
        </div>
      </StubSection>

      <div
        data-testid="voice-input-disabled"
        aria-disabled="true"
        className="flex items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-800/70 bg-neutral-950/40 py-8 cursor-not-allowed"
      >
        <button
          type="button"
          disabled
          title="Voice — coming v2"
          className="h-12 w-12 rounded-full border border-neutral-700 flex items-center justify-center text-neutral-600"
        >
          <Mic size={20} strokeWidth={1.5} />
        </button>
        <div>
          <div className="text-[12px] text-neutral-400">Push-to-talk</div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-600 mt-0.5">
            disabled · coming v2
          </div>
        </div>
      </div>
    </StubPage>
  );
}
