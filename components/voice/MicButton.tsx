// components/voice/MicButton.tsx
//
// Phase 5 — composer mic button.
//
// Three visible states (no recording / recording / transcribing).
// Hidden entirely if the server reports STT not available — the
// operator never sees a button that doesn't work.
//
// Tap-to-start, tap-to-stop UX. Held-to-record was considered but
// rejected: on a laptop trackpad it's awkward, and the "tap-start /
// tap-stop" model lets the operator pause to compose a sentence
// without losing the buffer.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Loader2, MicOff } from "lucide-react";
import {
  startVoiceRecorder,
  transcribeBlob,
  listAudioInputs,
  type RecorderHandle,
} from "@/lib/voice-client";

interface MicButtonProps {
  /** Called with the transcribed text when STT completes. */
  onTranscribed: (text: string) => void;
  /** Optional sessionId for audit-chain scoping. */
  sessionId?: string;
  /** Disable while the chat composer is otherwise busy. */
  disabled?: boolean;
  /** Accent color from the active persona. */
  accent: string;
}

type State =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "transcribing" }
  | { kind: "error"; message: string };

// Hard cap so we never hold an open mic forever if the operator
// walks away. 60s matches whisper.cpp's typical comfortable batch.
const MAX_RECORDING_MS = 60_000;

// localStorage key for the operator-selected audio input deviceId.
// Browser-scope persistence — sibling to argos_active_persona. Lost
// only on a manual storage wipe or different browser/profile.
const MIC_DEVICE_LS_KEY = "argos_mic_device_id";

// Heuristic match for "virtual" / loopback / hub-bus devices we want
// to AVOID auto-selecting. Real input mics (webcams, USB mics,
// onboard arrays) don't match any of these substrings. The operator
// reported Chrome auto-defaulting to "DeskIn Virtual Audio Device";
// "deskin" + "virtual" both anchor that match.
const VIRTUAL_DEVICE_PATTERNS = [
  "virtual",
  "deskin",
  "vb-audio",
  "vb audio",
  "voicemeeter",
  "stereo mix",
  "wave out",
  "loopback",
  "cable input",
  "cable output",
];

function isVirtualDevice(label: string): boolean {
  const l = label.toLowerCase();
  return VIRTUAL_DEVICE_PATTERNS.some((p) => l.includes(p));
}

/**
 * Pick a sensible default device when the operator hasn't chosen one
 * yet. Preference order:
 *   1. First non-virtual device (real mic, webcam, etc.)
 *   2. First device of any kind (fallback when all we have are
 *      virtual devices — better than no audio at all)
 *   3. null (caller falls back to letting the browser pick)
 *
 * Returns the deviceId string or null.
 */
function pickDefaultDeviceId(devices: MediaDeviceInfo[]): string | null {
  if (devices.length === 0) return null;
  const real = devices.find((d) => d.label && !isVirtualDevice(d.label));
  if (real) return real.deviceId;
  return devices[0]?.deviceId ?? null;
}

export function MicButton({
  onTranscribed,
  sessionId,
  disabled,
  accent,
}: MicButtonProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);

  // Voice UX (2026-05-27): operator-pickable audio input. Chrome was
  // auto-selecting "DeskIn Virtual Audio Device" instead of the real
  // C922 webcam mic. Enumeration runs on mount + after each record
  // (labels only populate after the first getUserMedia grant).
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // Recorder + abort handles need to survive re-renders.
  const recorderRef = useRef<RecorderHandle | null>(null);
  const sttAbortRef = useRef<AbortController | null>(null);
  const tickRef = useRef<number | null>(null);

  // Capability probe on mount. Polls again if the user enables voice
  // later (caught by the periodic refresh in the parent — Phase 5
  // doesn't ship a Settings toggle yet, so a refetch on next mount
  // is the recovery path).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/voice/status", { cache: "no-store" });
        if (!r.ok) {
          if (!cancelled) setAvailable(false);
          return;
        }
        const j = (await r.json()) as { stt?: { available?: boolean } };
        if (!cancelled) setAvailable(!!j.stt?.available);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Device enumeration + selection hydration. Runs once on mount AND
  // re-runs whenever the OS hot-plugs an audio device (Chrome fires
  // `devicechange` on the mediaDevices target). Labels may be empty
  // until the page has been granted mic permission; refresh() is also
  // called after each successful record so the dropdown picks up real
  // names once Chrome reveals them.
  const refreshDevices = useCallback(async () => {
    const inputs = await listAudioInputs();
    setDevices(inputs);
    if (typeof console !== "undefined") {
      // Operator-facing diagnostic: lets them see what Chrome sees
      // and compare against the directive's reported mismatch
      // (C922 expected vs. DeskIn Virtual selected).
      // eslint-disable-next-line no-console
      console.info(
        "[MicButton] audio inputs:",
        inputs.map((d) => ({ id: d.deviceId, label: d.label || "(unnamed)" }))
      );
    }
    // Resolve selectedDeviceId:
    //   1. honor a previously-stored choice if it still exists
    //   2. else pick a sensible default (first non-virtual)
    let persistedId: string | null = null;
    try {
      persistedId = window.localStorage?.getItem(MIC_DEVICE_LS_KEY) ?? null;
    } catch {
      /* localStorage blocked — fall through to default */
    }
    const persistedStillPresent =
      persistedId !== null && inputs.some((d) => d.deviceId === persistedId);
    if (persistedStillPresent) {
      setSelectedDeviceId(persistedId);
    } else {
      const fallback = pickDefaultDeviceId(inputs);
      setSelectedDeviceId(fallback);
      // Don't write the fallback to localStorage — leave the key
      // empty so a later device hot-plug can still beat the default.
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    if (
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      "addEventListener" in navigator.mediaDevices
    ) {
      const onChange = () => void refreshDevices();
      navigator.mediaDevices.addEventListener("devicechange", onChange);
      return () => {
        navigator.mediaDevices.removeEventListener("devicechange", onChange);
      };
    }
    return undefined;
  }, [refreshDevices]);

  const onSelectDevice = useCallback((id: string) => {
    setSelectedDeviceId(id);
    try {
      window.localStorage?.setItem(MIC_DEVICE_LS_KEY, id);
    } catch {
      /* localStorage blocked — selection still applies for this session */
    }
  }, []);

  // Tick the elapsed counter while recording.
  useEffect(() => {
    if (state.kind !== "recording") {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    setElapsed(0);
    tickRef.current = window.setInterval(() => {
      setElapsed(Date.now() - state.startedAt);
    }, 200) as unknown as number;
    return () => {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [state]);

  // Safety: if recording exceeds MAX_RECORDING_MS, auto-stop.
  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = window.setTimeout(() => {
      if (recorderRef.current) {
        void stop();
      }
    }, MAX_RECORDING_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Unmount cleanup — cancel recorder + STT abort.
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      sttAbortRef.current?.abort();
    };
  }, []);

  const start = useCallback(async () => {
    if (disabled) return;
    try {
      const handle = await startVoiceRecorder({
        deviceId: selectedDeviceId ?? undefined,
      });
      recorderRef.current = handle;
      setState({ kind: "recording", startedAt: Date.now() });
      // First successful getUserMedia grants device-label visibility;
      // refresh so the dropdown shows real names instead of (unnamed).
      void refreshDevices();
    } catch (e) {
      // If the persisted device is gone (unplugged webcam, etc.),
      // Chrome throws OverconstrainedError. Clear the bad pin and
      // re-enumerate so the next attempt picks a working default.
      const msg = e instanceof Error ? e.message : String(e);
      const isOverconstrained =
        e instanceof Error &&
        (e.name === "OverconstrainedError" ||
          /overconstrained|deviceid/i.test(msg));
      if (isOverconstrained && selectedDeviceId) {
        try {
          window.localStorage?.removeItem(MIC_DEVICE_LS_KEY);
        } catch {
          /* ignore */
        }
        setSelectedDeviceId(null);
        void refreshDevices();
      }
      setState({
        kind: "error",
        message: msg,
      });
      // Reset to idle after a moment so the operator can retry.
      window.setTimeout(() => setState({ kind: "idle" }), 2500);
    }
  }, [disabled, selectedDeviceId, refreshDevices]);

  const stop = useCallback(async () => {
    const handle = recorderRef.current;
    recorderRef.current = null;
    if (!handle) return;
    setState({ kind: "transcribing" });
    try {
      const wav = await handle.stop();
      const controller = new AbortController();
      sttAbortRef.current = controller;
      try {
        const text = await transcribeBlob(wav, {
          sessionId,
          signal: controller.signal,
        });
        if (text) onTranscribed(text);
        setState({ kind: "idle" });
      } finally {
        sttAbortRef.current = null;
      }
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      window.setTimeout(() => setState({ kind: "idle" }), 3500);
    }
  }, [onTranscribed, sessionId]);

  // Don't render anything until we know whether voice is available.
  // null state == probe-in-flight (still mounting); false == hide.
  if (available === null) return null;
  if (!available) return null;

  const isRecording = state.kind === "recording";
  const isTranscribing = state.kind === "transcribing";
  const isError = state.kind === "error";

  // Voice UX (2026-05-27): added visible text labels alongside the icon
  // — operator couldn't tell from the icon alone whether recording was
  // active or processing had hung. Old behavior: silent icon swap.
  // New behavior: "● Recording…" / "Processing…" labels with elapsed
  // timer; the button background also flips red while recording.
  const title = isError
    ? `voice error — ${state.message}`
    : isRecording
      ? `recording (${(elapsed / 1000).toFixed(1)}s) — click to stop`
      : isTranscribing
        ? "transcribing…"
        : "voice input — click to record";

  const ariaLabel = isError
    ? title
    : isRecording
      ? "Recording — click to stop and send"
      : isTranscribing
        ? "Processing — transcribing audio"
        : "Voice input — click to record";

  const label = isError
    ? "Error"
    : isRecording
      ? `● Recording ${(elapsed / 1000).toFixed(1)}s`
      : isTranscribing
        ? "Processing…"
        : "Speak";

  const bgColor = isError
    ? "rgba(239, 68, 68, 0.85)"
    : isRecording
      ? "rgba(239, 68, 68, 0.85)" // red while recording
      : isTranscribing
        ? "rgba(115, 115, 115, 0.55)" // neutral while processing
        : "rgba(38, 38, 38, 0.70)"; // calm idle

  // Show the device selector only when there's a real choice to make.
  // Single-device rigs (laptop with onboard mic only) get no dropdown.
  const showSelector = devices.length > 1;

  return (
    <>
      {showSelector && (
        <select
          aria-label="Microphone input device"
          title="Microphone input device — persisted to localStorage"
          value={selectedDeviceId ?? ""}
          onChange={(e) => onSelectDevice(e.target.value)}
          disabled={isRecording || isTranscribing}
          // Sits immediately above the mic button at the same right
          // offset. Overlaps the textarea's bottom-right corner —
          // acceptable because the operator isn't typing while
          // choosing a mic, and the dropdown is a setup-time control
          // they'll pick once per browser then forget about.
          className="absolute right-[5.5rem] bottom-11 max-w-[14rem] truncate rounded-md bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-200 border border-neutral-700/60 hover:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ minWidth: "9rem" }}
        >
          {devices.map((d) => {
            // Labels are empty until the page has mic permission.
            // Show a short hash of the deviceId as a stable fallback.
            const display = d.label || `Mic (${d.deviceId.slice(0, 6)})`;
            return (
              <option key={d.deviceId} value={d.deviceId}>
                {display}
              </option>
            );
          })}
        </select>
      )}
      <button
        type="button"
        onClick={() => {
          if (isRecording) void stop();
          else if (!isTranscribing && !isError) void start();
        }}
        disabled={disabled || isTranscribing}
        title={title}
        aria-label={ariaLabel}
        data-mic-state={state.kind}
        className={`absolute right-[5.5rem] bottom-1.5 inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-neutral-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
          isRecording ? "animate-pulse" : ""
        }`}
        style={{
          background: bgColor,
          outline: isRecording
            ? "1px solid rgba(239,68,68,0.9)"
            : `1px solid ${accent}40`,
        }}
      >
        {isTranscribing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isError ? (
          <MicOff className="h-4 w-4" />
        ) : (
          // Same Mic icon in idle and recording — color/bg + label do
          // the state-signaling. Pulse animation is on the whole button
          // so the red square pulses, not just the icon (more visible).
          <Mic className="h-4 w-4" />
        )}
        <span>{label}</span>
      </button>
    </>
  );
}
