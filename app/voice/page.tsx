import { StubPage, StubSection, StubBullet } from "@/components/StubPage";
import { VoiceStatusPanel } from "@/components/voice/VoiceStatusPanel";
import { getRuntimeInfo } from "@/lib/runtime-info";
import { f5Status } from "@/lib/voice-f5";

export const metadata = { title: "Voice — ARGOS" };

export default async function VoicePage() {
  const runtime = await getRuntimeInfo();
  const display = runtime.isDev
    ? `${runtime.argosRoot} (dev)`
    : runtime.argosRoot;

  // Server-side F5 detection (stat-only, no spawn). The mic / conversation
  // rows are detected in-browser by VoiceStatusPanel.
  const f5 = f5Status();

  return (
    <StubPage
      argosRoot={display}
      version={runtime.version}
      startedAt={runtime.startedAt}
      title="Voice"
      status={f5.available ? "live" : "fallback"}
      weekLabel="Phase 7-D · Voice I/O"
    >
      <StubSection title="Live status">
        <VoiceStatusPanel
          f5={{
            available: f5.available,
            reason: f5.reason,
            device: f5.device,
            daemonPort: f5.daemonPort,
          }}
        />
      </StubSection>

      <StubSection title="What this does">
        <StubBullet>
          Text-to-speech: Bartimaeus speaks in his cloned voice via local
          F5-TTS. Every Bartimaeus reply carries a 🔊 speak button. Other
          personas use the Piper voice.
        </StubBullet>
        <StubBullet>
          Speech-to-text: the mic button left of Send dictates straight into
          the composer using the browser&apos;s Web Speech API — transcription
          happens in-browser, no Whisper download, no new dependencies.
        </StubBullet>
        <StubBullet>
          Conversation (&ldquo;caveman&rdquo;) mode: the radio toggle in the
          chat toolbar runs a hands-free loop — you speak, Bartimaeus answers
          and speaks back, then the mic re-arms. Press Escape to stop.
        </StubBullet>
        <StubBullet>
          Local &amp; honest: audio playback and recognition stay on this
          machine. Dictated text is shown in the composer so you can correct a
          mis-hearing before sending.
        </StubBullet>
      </StubSection>

      <StubSection title="Requirements">
        <StubBullet>
          Microphone dictation and conversation mode use the Web Speech API,
          available in Chrome and Edge. In other browsers the mic button hides
          itself gracefully and text chat is unaffected.
        </StubBullet>
        <StubBullet>
          Bartimaeus&apos; cloned voice needs the local F5-TTS install and his
          reference clip. When F5 is unavailable, TTS falls back to Piper
          rather than failing.
        </StubBullet>
      </StubSection>
    </StubPage>
  );
}
