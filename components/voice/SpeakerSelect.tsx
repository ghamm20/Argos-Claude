// components/voice/SpeakerSelect.tsx
//
// Voice UX output-routing fix (2026-05-27).
//
// Operator-pickable audio OUTPUT device. Symmetric to the audio-INPUT
// selector that lives inside MicButton.tsx (commit e18ff5d): enumerate
// `audiooutput` devices, hydrate from localStorage, render a small
// <select> when more than one output exists, persist on change.
//
// Why this exists: Chrome routes Web Audio playback to its current
// default OUTPUT device. When a virtual sink (DeskIn, VB-Cable,
// Voicemeeter, etc.) is installed and ranked above the operator's
// real speakers, the TTS WAV decodes correctly, the AudioContext
// unlocks correctly, source.start() fires correctly — and the audio
// vanishes into the virtual device. Operator hears nothing.
//
// The actual routing happens in components/voice/PlayButton.tsx via
// AudioContext.setSinkId(deviceId). This component is only the picker;
// the persisted value is what PlayButton consumes at click time.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listAudioOutputs,
  SPEAKER_DEVICE_LS_KEY,
} from "@/lib/voice-client";

// Heuristic match for "virtual" / loopback / hub-bus sinks we want to
// AVOID auto-selecting as the default speaker.
//
// Intentional duplication of MicButton.tsx's VIRTUAL_DEVICE_PATTERNS:
// kept local to this component because the input and output blacklists
// may diverge over time (e.g. "stereo mix" is virtual-input-only;
// "DeskIn" exists on both sides; future entries might be one-sided).
// Cheap to maintain two short lists; expensive to share and then have
// to special-case the divergence later.
const VIRTUAL_OUTPUT_PATTERNS = [
  "virtual",
  "deskin",
  "vb-audio",
  "vb audio",
  "voicemeeter",
  "loopback",
  "cable input",
  "cable output",
];

function isVirtualOutput(label: string): boolean {
  const l = label.toLowerCase();
  return VIRTUAL_OUTPUT_PATTERNS.some((p) => l.includes(p));
}

function pickDefaultOutputId(devices: MediaDeviceInfo[]): string | null {
  if (devices.length === 0) return null;
  const real = devices.find((d) => d.label && !isVirtualOutput(d.label));
  if (real) return real.deviceId;
  return devices[0]?.deviceId ?? null;
}

interface SpeakerSelectProps {
  /** Persona accent color for the outline tint — matches MicButton's
   *  selector styling so the two dropdowns read as a related pair. */
  accent: string;
  /** Hide entirely (e.g. while streaming) — for now we only disable. */
  disabled?: boolean;
}

export function SpeakerSelect({ accent, disabled }: SpeakerSelectProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // Enumerate + hydrate. Runs on mount AND on the OS-level
  // "devicechange" event (Bluetooth headset connect/disconnect,
  // USB hub plug, etc.). Labels may be blank until the page has
  // been granted mic permission at least once — same gate as inputs.
  const refreshDevices = useCallback(async () => {
    const outputs = await listAudioOutputs();
    setDevices(outputs);
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.info(
        "[SpeakerSelect] audio outputs:",
        outputs.map((d) => ({ id: d.deviceId, label: d.label || "(unnamed)" }))
      );
    }
    let persistedId: string | null = null;
    try {
      persistedId = window.localStorage?.getItem(SPEAKER_DEVICE_LS_KEY) ?? null;
    } catch {
      /* localStorage blocked — use the default-pick fallback */
    }
    const persistedStillPresent =
      persistedId !== null && outputs.some((d) => d.deviceId === persistedId);
    if (persistedStillPresent) {
      setSelectedDeviceId(persistedId);
    } else {
      // Don't WRITE the fallback to localStorage — keep the key empty
      // so a later device hot-plug can still beat the auto-pick.
      setSelectedDeviceId(pickDefaultOutputId(outputs));
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

  const onSelect = useCallback((id: string) => {
    setSelectedDeviceId(id);
    try {
      window.localStorage?.setItem(SPEAKER_DEVICE_LS_KEY, id);
    } catch {
      /* localStorage blocked — selection still applies for this session
         because PlayButton reads localStorage each click; without
         persistence it'll revert on reload but that's not fatal. */
    }
  }, []);

  // Only show the selector when there's a real choice. Single-output
  // rigs (laptop with onboard speakers only) get no dropdown.
  if (devices.length <= 1) return null;

  return (
    <select
      aria-label="Audio output device"
      title="Audio output device — persisted to localStorage; takes effect on next Speak click"
      value={selectedDeviceId ?? ""}
      onChange={(e) => onSelect(e.target.value)}
      disabled={disabled}
      // Sits one row above the mic selector (which is at bottom-11),
      // same right offset (right-[5.5rem]). The two selectors stack
      // vertically above the mic button. Visual pair, audio-routing
      // config.
      className="absolute right-[5.5rem] bottom-20 max-w-[14rem] truncate rounded-md bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-200 border border-neutral-700/60 hover:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 disabled:opacity-60 disabled:cursor-not-allowed"
      style={{
        minWidth: "9rem",
        // Subtle persona-accent ring matches the mic selector + mic
        // button outlines, so the trio reads as a connected unit.
        outline: `1px solid ${accent}40`,
      }}
    >
      {devices.map((d) => {
        const display = d.label || `Speaker (${d.deviceId.slice(0, 6)})`;
        return (
          <option key={d.deviceId} value={d.deviceId}>
            {display}
          </option>
        );
      })}
    </select>
  );
}
