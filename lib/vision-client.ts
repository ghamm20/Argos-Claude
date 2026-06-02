// lib/vision-client.ts
//
// Vision Phase 1 (2026-06-02) — browser-side image helpers for the chat
// composer: read dropped/selected files into data URLs, validate type/size,
// and capture a screenshot via getDisplayMedia (no new deps, Chrome/Edge).
//
// Browser-only ("use client" callers). Degrades gracefully — screenshot
// capture returns null (never throws) when the API is missing or the user
// denies permission.

"use client";

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image

/** Accepted MIME types + the extensions we let the file picker show. */
export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
export const IMAGE_ACCEPT_ATTR = ".jpg,.jpeg,.png,.gif,.webp,image/*";

export interface AttachedImage {
  id: string;
  /** data:image/...;base64,... — used for preview, history thumbnail, and
   *  sent to the chat API (server strips the prefix for Ollama). */
  dataUrl: string;
  name: string;
  /** "file" = dropped/picked; "screenshot" = getDisplayMedia capture. */
  kind: "file" | "screenshot";
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

/** Validate a single file's type + size. Returns a clear, human error. */
export function validateImageFile(file: File): ValidateResult {
  const typeOk =
    ALLOWED_IMAGE_MIME.has(file.type) ||
    /\.(jpe?g|png|gif|webp)$/i.test(file.name);
  if (!typeOk) {
    return {
      ok: false,
      error: `${file.name}: unsupported type (use JPG, PNG, GIF, or WebP)`,
    };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `${file.name}: ${(file.size / 1024 / 1024).toFixed(1)} MB exceeds the 10 MB limit`,
    };
  }
  return { ok: true };
}

/** Read a File into a data URL. Rejects on read error. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error(`failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Turn a FileList/array into AttachedImages, honoring the remaining-slot count
 * (max 3 total) and per-file validation. Returns the accepted images plus any
 * human-readable errors so the caller can surface them honestly.
 */
export async function filesToAttachments(
  files: FileList | File[],
  remainingSlots: number
): Promise<{ images: AttachedImage[]; errors: string[] }> {
  const list = Array.from(files);
  const images: AttachedImage[] = [];
  const errors: string[] = [];
  for (const file of list) {
    if (images.length >= remainingSlots) {
      errors.push(`Only ${MAX_IMAGES} images per message — "${file.name}" skipped.`);
      continue;
    }
    const v = validateImageFile(file);
    if (!v.ok) {
      errors.push(v.error ?? `${file.name}: invalid`);
      continue;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      images.push({ id: makeId(), dataUrl, name: file.name, kind: "file" });
    } catch (e) {
      errors.push(`${file.name}: ${(e as Error).message}`);
    }
  }
  return { images, errors };
}

// ---------- screenshot capture (getDisplayMedia) ----------

interface MediaDevicesLike {
  getDisplayMedia?: (c?: unknown) => Promise<MediaStream>;
}

/** True if the browser exposes getDisplayMedia (Chrome/Edge/most modern). */
export function screenshotSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  const md = navigator.mediaDevices as unknown as MediaDevicesLike | undefined;
  return !!md && typeof md.getDisplayMedia === "function";
}

export interface ScreenshotResult {
  image: AttachedImage | null;
  /** Set when capture failed/denied so the caller can show a clear, non-fatal
   *  message. null error + null image = user cancelled the picker silently. */
  error: string | null;
}

/**
 * Capture the current screen/window via getDisplayMedia → a single PNG frame.
 * Requires user permission (browser prompt). Degrades gracefully:
 *   - API missing            → {image:null, error:"…not supported…"}
 *   - permission denied      → {image:null, error:"Screen capture permission denied"}
 *   - user cancels picker    → {image:null, error:null}
 * Never throws.
 */
export async function captureScreenshot(): Promise<ScreenshotResult> {
  if (!screenshotSupported()) {
    return {
      image: null,
      error: "Screen capture isn't supported in this browser (use Chrome or Edge).",
    };
  }
  const md = navigator.mediaDevices as unknown as MediaDevicesLike;
  let stream: MediaStream | null = null;
  try {
    stream = await md.getDisplayMedia!({ video: true, audio: false });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError") {
      // Covers both explicit deny and the user dismissing the picker.
      return { image: null, error: null };
    }
    return {
      image: null,
      error: `Screen capture failed: ${(e as Error).message || name || "unknown"}`,
    };
  }

  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play().catch(() => {});
    // One animation frame is enough for the first frame to be paintable.
    await new Promise((r) => setTimeout(r, 120));
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return { image: null, error: "Could not get a canvas context for capture." };
    }
    ctx.drawImage(video, 0, 0, w, h);
    track.stop();
    const dataUrl = canvas.toDataURL("image/png");
    video.srcObject = null;
    return {
      image: {
        id: makeId(),
        dataUrl,
        name: "screenshot.png",
        kind: "screenshot",
      },
      error: null,
    };
  } catch (e) {
    return {
      image: null,
      error: `Screen capture failed: ${(e as Error).message}`,
    };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
