// components/vision/VisionStatusPanel.tsx
//
// Vision Phase 1 (2026-06-02) — live status for the Vision page. Replaces the
// "coming v2" stub. Rows:
//   1. Vision model     — server-detected (gemma4-turbo present in Ollama?)
//   2. Image drop        — live
//   3. File vision       — live (vault image → description → searchable)
//   4. Screenshot        — browser-detected (getDisplayMedia)
//   5. Camera feed       — coming (later phase)
//
// Honest status: model availability comes from /api/vision/status; screenshot
// support is detected in-browser after mount.

"use client";

import { useEffect, useState } from "react";
import { Image as ImageIcon, FileSearch, Camera, Video } from "lucide-react";
import { screenshotSupported } from "@/lib/vision-client";

type Level = "live" | "off" | "soon";

interface VisionStatus {
  ok: boolean;
  model: string;
  available: boolean;
}

function Dot({ level }: { level: Level }) {
  const color = level === "live" ? "#10b981" : level === "soon" ? "#737373" : "#f59e0b";
  return (
    <span
      className="inline-block h-2 w-2 rounded-full shrink-0"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}

function Row({
  icon,
  title,
  level,
  state,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  level: Level;
  state: string;
  detail: string;
}) {
  const stateColor =
    level === "live" ? "#10b981" : level === "soon" ? "#9ca3af" : "#f59e0b";
  return (
    <div className="flex items-start gap-3 rounded-md border border-neutral-800/70 bg-black/30 px-4 py-3">
      <span className="mt-0.5 text-neutral-500">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-neutral-200">{title}</span>
          <Dot level={level} />
          <span
            className="text-[10px] uppercase tracking-[0.18em]"
            style={{ color: stateColor }}
          >
            {state}
          </span>
        </div>
        <div className="text-[12px] leading-relaxed text-neutral-500 mt-1">
          {detail}
        </div>
      </div>
    </div>
  );
}

export function VisionStatusPanel() {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [micShot, setMicShot] = useState<boolean | null>(null);

  useEffect(() => {
    setMicShot(screenshotSupported());
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/vision/status", { cache: "no-store" });
        if (!cancelled && r.ok) setStatus((await r.json()) as VisionStatus);
      } catch {
        /* offline — leave null */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const model = status?.model ?? "ssfdre38/gemma4-turbo:e4b";
  const available = status?.available === true;
  const modelLevel: Level = available ? "live" : "off";
  const modelState = !loaded ? "Checking…" : available ? "Live" : "Model missing";
  const modelDetail = !loaded
    ? "Querying Ollama…"
    : available
      ? `Image turns route to ${model} regardless of persona — the reply still comes back in the active persona's voice. Text turns stay on the persona's text model.`
      : `${model} isn't pulled in Ollama. Run: ollama pull ${model}. Until then, image turns will return a clear error rather than crash.`;

  const shotLevel: Level = micShot ? "live" : "off";

  return (
    <div className="space-y-2.5" data-testid="vision-status-panel">
      <Row
        icon={<FileSearch size={16} strokeWidth={1.5} />}
        title="Vision model"
        level={modelLevel}
        state={modelState}
        detail={modelDetail}
      />
      <Row
        icon={<ImageIcon size={16} strokeWidth={1.5} />}
        title="Image drop"
        level="live"
        state="Live"
        detail="Attach up to 3 images (JPG, PNG, GIF, WebP · ≤10 MB) in the chat composer — drop or pick, preview before sending, and the model analyzes them in your persona's voice."
      />
      <Row
        icon={<FileSearch size={16} strokeWidth={1.5} />}
        title="File vision"
        level="live"
        state="Live"
        detail="Upload an image to the Vault and ARGOS auto-generates a vision description, then chunks + embeds it so the image is searchable and retrievable through the normal RAG pipeline."
      />
      <Row
        icon={<Camera size={16} strokeWidth={1.5} />}
        title="Screenshot"
        level={shotLevel}
        state={micShot === null ? "Checking…" : micShot ? "Available" : "Unavailable"}
        detail={
          micShot === null
            ? "Checking browser capability…"
            : micShot
              ? "Use the camera button in the chat toolbar to capture your screen/window (you'll pick what to share). It attaches as an image — no new dependencies, browser getDisplayMedia."
              : "This browser has no getDisplayMedia. Use Chrome or Edge for screenshot capture; the button is hidden gracefully meanwhile."
        }
      />
      <Row
        icon={<Video size={16} strokeWidth={1.5} />}
        title="Camera feed"
        level="soon"
        state="Coming"
        detail="Live webcam analysis is planned for a later phase."
      />
    </div>
  );
}
