// components/vision/ImagePreviewStrip.tsx
//
// Vision Phase 1 (2026-06-02) — shows attached images as thumbnails above the
// chat input before sending, so the operator sees exactly what they attached.
// Screenshots are labelled "Screenshot". Each has an × to remove it.

"use client";

import { X } from "lucide-react";
import type { AttachedImage } from "@/lib/vision-client";

interface ImagePreviewStripProps {
  images: AttachedImage[];
  onRemove: (id: string) => void;
  accent?: string;
}

export function ImagePreviewStrip({
  images,
  onRemove,
  accent = "#10b981",
}: ImagePreviewStripProps) {
  if (images.length === 0) return null;
  return (
    <div
      className="mb-2 flex flex-wrap gap-2"
      data-testid="image-preview-strip"
    >
      {images.map((img) => (
        <div
          key={img.id}
          className="relative group rounded-md border overflow-hidden"
          style={{ borderColor: `${accent}55` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.dataUrl}
            alt={img.name}
            className="h-16 w-16 object-cover"
          />
          {img.kind === "screenshot" && (
            <span
              className="absolute bottom-0 inset-x-0 text-[8px] uppercase tracking-wider text-center py-0.5 text-white"
              style={{ background: "rgba(16,185,129,0.75)" }}
            >
              Screenshot
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(img.id)}
            title={`Remove ${img.name}`}
            aria-label={`Remove ${img.name}`}
            className="absolute top-0.5 right-0.5 h-4 w-4 inline-flex items-center justify-center rounded-full bg-black/70 text-neutral-200 hover:bg-red-500/80 hover:text-white transition-colors"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
