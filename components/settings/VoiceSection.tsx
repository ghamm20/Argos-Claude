// components/settings/VoiceSection.tsx
//
// v1.1 — Settings panel surface for voice capability.
//
// Shows the live `/api/voice/status` snapshot: whether STT + TTS are
// available, what binary + model paths the server resolved, and a
// human-friendly "why not" string if either is unavailable. Includes
// install instructions inline (linking to docs/VOICE.md).
//
// Refresh button reruns the probe — useful after operator drops
// binaries into tools/voice/ without restarting ARGOS.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Mic, Volume2, RefreshCw, CheckCircle2, AlertCircle, Sparkles, Play } from "lucide-react";

const ELEVENLABS_TEST_TEXT = "I am Bartimaeus. Try not to waste my time.";

/**
 * Phase 7-C — ElevenLabs (Sael, locked 2026-06-10) voice for Bartimaeus, with Piper as the
 * offline fallback. API key is masked (password field) and only ever sent to
 * the server; the GET response returns a hint, never the key.
 */
function ElevenLabsCard() {
  const [configured, setConfigured] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [voiceId, setVoiceId] = useState("aGv5jHWKBy8K5xKvYeSX");
  const [model, setModel] = useState("eleven_multilingual_v2");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        elevenlabs?: { apiKey?: { configured?: boolean; hint?: string | null }; bartVoiceId?: string; model?: string };
      };
      const el = j.elevenlabs;
      setConfigured(!!el?.apiKey?.configured);
      setHint(el?.apiKey?.hint ?? null);
      if (el?.bartVoiceId) setVoiceId(el.bartVoiceId);
      if (el?.model) setModel(el.model);
    } catch {
      /* leave defaults */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const elevenlabs: Record<string, unknown> = { bartVoiceId: voiceId.trim(), model: model.trim() };
      // Only send the key when the operator typed a new one (empty = leave as-is).
      if (keyInput.trim().length > 0) elevenlabs.apiKey = keyInput.trim();
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ elevenlabs }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setSaveMsg(`Save failed: ${j.error ?? `HTTP ${r.status}`}`);
        return;
      }
      setKeyInput("");
      setSaveMsg("Saved.");
      await load();
    } catch (e) {
      setSaveMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: ELEVENLABS_TEST_TEXT, personaId: "bartimaeus" }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; hint?: string };
        setTestMsg(`Test failed: ${j.error ?? `HTTP ${r.status}`}${j.hint ? ` — ${j.hint}` : ""}`);
        return;
      }
      const engine = r.headers.get("x-voice-engine") ?? "?";
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setTestMsg(
        engine === "elevenlabs"
          ? "Spoke via ElevenLabs (Sael)."
          : `Spoke via ${engine} (ElevenLabs not used — set a key, or it fell back).`
      );
    } catch (e) {
      setTestMsg(`Test failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="rounded-md border border-neutral-800 bg-black/30 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Sparkles size={14} strokeWidth={1.8} className="text-neutral-400" />
          <span className="text-[13px] font-medium text-neutral-100">
            ElevenLabs — Bartimaeus voice (Sael)
          </span>
        </div>
        <StatusPill available={configured} label={configured ? "Key set" : "No key"} />
      </div>
      <p className="text-[11px] text-neutral-500 mb-3 leading-relaxed">
        When a key is set, Bartimaeus speaks via ElevenLabs; on any failure he
        falls back to Piper silently. Other personas always use Piper. Key is
        encrypted at rest and never shown.
      </p>

      <label className="block text-[10px] uppercase tracking-[0.16em] text-neutral-600 mb-1">
        API key {configured && hint ? <span className="text-neutral-500 normal-case tracking-normal">(current: {hint})</span> : null}
      </label>
      <input
        type="password"
        value={keyInput}
        onChange={(e) => setKeyInput(e.target.value)}
        placeholder={configured ? "•••••••• — enter a new key to replace" : "xi-…"}
        autoComplete="off"
        className="w-full mb-3 rounded-sm border border-neutral-700 bg-black/40 px-2 py-1.5 text-[12px] font-mono text-neutral-200 outline-none focus:border-neutral-500"
      />

      <label className="block text-[10px] uppercase tracking-[0.16em] text-neutral-600 mb-1">
        Voice ID
      </label>
      <input
        type="text"
        value={voiceId}
        onChange={(e) => setVoiceId(e.target.value)}
        className="w-full mb-3 rounded-sm border border-neutral-700 bg-black/40 px-2 py-1.5 text-[12px] font-mono text-neutral-200 outline-none focus:border-neutral-500"
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="text-[11px] uppercase tracking-[0.16em] px-3 py-1.5 rounded-sm border border-neutral-600 text-neutral-300 hover:text-neutral-100 hover:border-neutral-400 transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={testing}
          title='Speak "I am Bartimaeus. Try not to waste my time."'
          className="text-[11px] uppercase tracking-[0.16em] px-3 py-1.5 rounded-sm border border-emerald-600/50 text-emerald-300 hover:border-emerald-400 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <Play size={11} strokeWidth={2} />
          {testing ? "Speaking…" : "Test voice"}
        </button>
      </div>
      {saveMsg && <div className="mt-2 text-[11px] text-neutral-400">{saveMsg}</div>}
      {testMsg && <div className="mt-1 text-[11px] text-neutral-400">{testMsg}</div>}
    </div>
  );
}

interface VoiceCapability {
  stt: {
    available: boolean;
    binary: string | null;
    model: string | null;
    reason: string | null;
  };
  tts: {
    available: boolean;
    binary: string | null;
    model: string | null;
    voices: string | null;
    reason: string | null;
  };
  argosRoot: string | null;
  toolsDir: string | null;
}

function StatusPill({ available, label }: { available: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded-sm border"
      style={{
        borderColor: available ? "rgba(16,185,129,0.4)" : "rgba(245,158,11,0.4)",
        color: available ? "#10b981" : "#f59e0b",
      }}
    >
      {available ? (
        <CheckCircle2 size={9} strokeWidth={2} />
      ) : (
        <AlertCircle size={9} strokeWidth={2} />
      )}
      {label}
    </span>
  );
}

function PathRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="text-neutral-600 uppercase tracking-[0.16em] w-16 shrink-0">
        {label}
      </span>
      <span
        className="font-mono text-neutral-400 truncate"
        title={value ?? "—"}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}

export function VoiceSection() {
  const [cap, setCap] = useState<VoiceCapability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/voice/status", { cache: "no-store" });
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as VoiceCapability;
      setCap(j);
      setLastChecked(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-[15px] font-medium text-neutral-100">Voice</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title="Re-probe voice capability"
          className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
        >
          <RefreshCw size={11} strokeWidth={2} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>
      <p className="text-[12px] text-neutral-500 mb-6">
        Whisper STT + Kokoro TTS — operator-supplied binaries. Drop them
        in <span className="font-mono">$ARGOS_ROOT/tools/voice/</span>;
        UI auto-detects on next refresh.
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-300">
          Probe failed: {error}
        </div>
      )}

      {cap && (
        <div className="space-y-4">
          {/* STT card */}
          <div
            className="rounded-md border bg-black/30 px-4 py-3"
            style={{
              borderColor: cap.stt.available
                ? "rgba(16,185,129,0.3)"
                : "rgba(64,64,64,0.6)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Mic size={14} strokeWidth={1.8} className="text-neutral-400" />
                <span className="text-[13px] font-medium text-neutral-100">
                  Speech-to-text (Whisper)
                </span>
              </div>
              <StatusPill
                available={cap.stt.available}
                label={cap.stt.available ? "Ready" : "Not installed"}
              />
            </div>
            {cap.stt.available ? (
              <div className="space-y-1 mt-2">
                <PathRow label="Binary" value={cap.stt.binary} />
                <PathRow label="Model" value={cap.stt.model} />
              </div>
            ) : (
              <div className="text-[12px] text-amber-500/80 mt-1.5 leading-relaxed">
                {cap.stt.reason ?? "Not installed."}
                <br />
                Install: drop <span className="font-mono">whisper-cli(.exe)</span>{" "}
                into{" "}
                <span className="font-mono">
                  {cap.toolsDir ?? "$ARGOS_ROOT/tools/voice"}/whisper/
                </span>{" "}
                + a <span className="font-mono">ggml-*.bin</span> into the{" "}
                <span className="font-mono">models/</span> subdir. See{" "}
                <span className="font-mono">docs/VOICE.md</span>.
              </div>
            )}
          </div>

          {/* TTS card */}
          <div
            className="rounded-md border bg-black/30 px-4 py-3"
            style={{
              borderColor: cap.tts.available
                ? "rgba(16,185,129,0.3)"
                : "rgba(64,64,64,0.6)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Volume2 size={14} strokeWidth={1.8} className="text-neutral-400" />
                <span className="text-[13px] font-medium text-neutral-100">
                  Text-to-speech (Kokoro)
                </span>
              </div>
              <StatusPill
                available={cap.tts.available}
                label={cap.tts.available ? "Ready" : "Not installed"}
              />
            </div>
            {cap.tts.available ? (
              <div className="space-y-1 mt-2">
                <PathRow label="Binary" value={cap.tts.binary} />
                <PathRow label="Model" value={cap.tts.model} />
                <PathRow label="Voices" value={cap.tts.voices} />
              </div>
            ) : (
              <div className="text-[12px] text-amber-500/80 mt-1.5 leading-relaxed">
                {cap.tts.reason ?? "Not installed."}
                <br />
                Install: drop <span className="font-mono">kokoros(.exe)</span>{" "}
                into{" "}
                <span className="font-mono">
                  {cap.toolsDir ?? "$ARGOS_ROOT/tools/voice"}/kokoro/
                </span>{" "}
                + a <span className="font-mono">kokoro-*.onnx</span> and{" "}
                <span className="font-mono">voices*.bin</span> into the{" "}
                <span className="font-mono">models/</span> subdir.
              </div>
            )}
          </div>

          {/* Roots */}
          <div className="rounded-md border border-neutral-800 bg-black/20 px-4 py-3 text-[11px] text-neutral-500">
            <div className="space-y-1">
              <PathRow label="Tools dir" value={cap.toolsDir} />
              <PathRow label="ARGOS root" value={cap.argosRoot} />
            </div>
          </div>

          {lastChecked && (
            <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-600">
              Last probe: {lastChecked}
            </div>
          )}
        </div>
      )}

      {/* Phase 7-C — ElevenLabs (Bartimaeus). Independent of the local Piper
          probe, so it renders even when no binaries are installed. */}
      <div className="mt-4">
        <ElevenLabsCard />
      </div>
    </div>
  );
}
