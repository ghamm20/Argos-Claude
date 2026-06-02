// components/vision/ImageDropButton.tsx
//
// Vision Phase 1 (2026-06-02) — image attach button for the chat composer,
// sits left of the mic. Opens a file picker (jpg/png/gif/webp, ≤10 MB, max 3
// per message). Selected files are read to data URLs and handed up; the parent
// shows previews above the input and sends them with the next message.

"use client";

import { useCallback, useRef } from "react";
import { ImagePlus } from "lucide-react";
import {
  filesToAttachments,
  IMAGE_ACCEPT_ATTR,
  MAX_IMAGES,
  type AttachedImage,
} from "@/lib/vision-client";

interface ImageDropButtonProps {
  onAttach: (images: AttachedImage[]) => void;
  onError?: (errors: string[]) => void;
  /** Images already attached — used to enforce the max-3 cap. */
  currentCount: number;
  disabled?: boolean;
  accent?: string;
}

export function ImageDropButton({
  onAttach,
  onError,
  currentCount,
  disabled,
  accent = "#10b981",
}: ImageDropButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const remaining = Math.max(0, MAX_IMAGES - currentCount);
  const atCap = remaining === 0;

  const onPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const { images, errors } = await filesToAttachments(files, remaining);
      if (images.length > 0) onAttach(images);
      if (errors.length > 0) onError?.(errors);
      // Reset so picking the same file again re-fires onChange.
      e.target.value = "";
    },
    [onAttach, onError, remaining]
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT_ATTR}
        multiple
        className="hidden"
        onChange={onPick}
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || atCap}
        title={
          atCap
            ? `Max ${MAX_IMAGES} images per message`
            : "Attach image (JPG, PNG, GIF, WebP · ≤10 MB)"
        }
        aria-label="Attach image"
        className="absolute bottom-1.5 right-[124px] inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          borderColor: `${accent}55`,
          color: accent,
          background: "rgba(0,0,0,0.35)",
        }}
      >
        <ImagePlus className="h-4 w-4" />
      </button>
    </>
  );
}
