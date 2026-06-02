// components/vision/ScreenshotButton.tsx
//
// Vision Phase 1 (2026-06-02) — screenshot capture button for the chat
// toolbar. Uses getDisplayMedia (Chrome/Edge, no new deps). On capture the
// PNG frame is handed up and appears as an image preview in the composer,
// labelled "Screenshot". Self-hides where the API is unavailable; permission
// denial / cancel is handled gracefully (no error, no crash).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera } from "lucide-react";
import {
  captureScreenshot,
  screenshotSupported,
  type AttachedImage,
} from "@/lib/vision-client";

interface ScreenshotButtonProps {
  onCapture: (image: AttachedImage) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
  /** Hide when the composer already holds the max images. */
  atCapacity?: boolean;
}

export function ScreenshotButton({
  onCapture,
  onError,
  disabled,
  atCapacity,
}: ScreenshotButtonProps) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSupported(screenshotSupported());
  }, []);

  const onClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { image, error } = await captureScreenshot();
      if (image) onCapture(image);
      else if (error) onError?.(error);
      // image=null + error=null → user cancelled the picker; stay silent.
    } finally {
      setBusy(false);
    }
  }, [busy, onCapture, onError]);

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy || atCapacity}
      title={
        atCapacity
          ? "Max images attached"
          : "Capture a screenshot (you'll pick the screen/window)"
      }
      aria-label="Capture screenshot"
      className={
        "rounded p-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed " +
        (busy
          ? "text-[#10b981] bg-[#10b981]/15"
          : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60")
      }
    >
      <Camera className={"h-3.5 w-3.5 " + (busy ? "animate-pulse" : "")} />
    </button>
  );
}
