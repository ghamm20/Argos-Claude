// lib/vision.ts
//
// Vision Phase 1 (2026-06-02) — server-side vision helpers.
//
// ARGOS routes any chat turn that carries an image to a multimodal model
// (ssfdre38/gemma4-turbo:e4b) regardless of the active persona, then returns
// the analysis in that persona's voice (the persona's system prompt is still
// injected — only the MODEL changes, never the character). Text-only turns
// stay on the persona's assigned text model. The same helpers back:
//   - /api/chat vision routing (resolveChatModel / messagesHaveImages)
//   - /api/vault image ingestion (describeImage — vision → searchable text)
//   - /api/vision/status (visionModelAvailable / VISION_FEATURES)
//
// Server-only (uses node fetch against the local Ollama daemon). No external
// network — Ollama is 127.0.0.1 by Seven-Rules doctrine.

import { getOllamaBase } from "./ollama-config";

/**
 * The multimodal model. gemma4-turbo:e4b (~5.7 GB) is already pulled on the
 * rig and verified vision-capable via Ollama's native `images` field. Operator
 * can override with ARGOS_VISION_MODEL without a source change (Power-Mode
 * parity with the persona override mechanism).
 */
export const DEFAULT_VISION_MODEL = "ssfdre38/gemma4-turbo:e4b";

export function getVisionModel(): string {
  const env = process.env.ARGOS_VISION_MODEL?.trim();
  return env && env.length > 0 ? env : DEFAULT_VISION_MODEL;
}

/** Image file extensions accepted by file-vision (vault) ingestion. */
export const VISION_IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

export function isImageFilename(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return VISION_IMAGE_EXTS.has(name.slice(dot).toLowerCase());
}

/** Features advertised by /api/vision/status and the Vision page. */
export const VISION_FEATURES = {
  imageDrop: true,
  fileVision: true,
  screenshot: true, // browser getDisplayMedia — runtime-detected client-side
  cameraFeed: false, // live camera feed deferred to a later phase
} as const;

// ---------- request shape ----------

export interface VisionWireMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Base64 image payloads. Accept data-URL or raw base64; stripped before
   *  the daemon call. Only user turns carry these in practice. */
  images?: string[];
}

/** Strip a `data:image/...;base64,` prefix, returning raw base64. Ollama's
 *  native `images` field wants raw base64, not a data URL. */
export function stripDataUrl(s: string): string {
  const comma = s.indexOf(",");
  if (s.slice(0, 5) === "data:" && comma !== -1) return s.slice(comma + 1);
  return s;
}

/** True when any message carries at least one non-empty image. */
export function messagesHaveImages(
  messages: Array<{ images?: unknown }> | undefined | null
): boolean {
  if (!messages) return false;
  return messages.some(
    (m) =>
      Array.isArray(m.images) &&
      m.images.some((x) => typeof x === "string" && x.length > 0)
  );
}

/**
 * The single source of truth for vision routing, shared by the chat route and
 * the /api/vision/status probe (so the smoke tests the exact production logic).
 *   - image present → vision model, regardless of persona
 *   - text only     → the persona's assigned model (unchanged behavior)
 */
export function resolveChatModel(opts: {
  hasImages: boolean;
  personaModel: string;
}): { model: string; vision: boolean } {
  if (opts.hasImages) return { model: getVisionModel(), vision: true };
  return { model: opts.personaModel, vision: false };
}

// ---------- availability + description ----------

/** Does the local Ollama have the vision model pulled? Graceful: returns
 *  false (never throws) if Ollama is down or the tags call fails. */
export async function visionModelAvailable(): Promise<boolean> {
  const model = getVisionModel();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${getOllamaBase()}/api/tags`, {
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      const j = (await res.json()) as { models?: Array<{ name?: string }> };
      return (j.models ?? []).some((m) => m.name === model);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

const DESCRIBE_TIMEOUT_MS = 180_000; // model load + vision inference, cold-safe

const DESCRIBE_PROMPT =
  "Describe this image in detail for a searchable archive. Cover: the main " +
  "subject, any visible text (transcribe it), notable objects, colors, and " +
  "the overall scene. Be factual and specific. Do not speculate beyond what " +
  "is visible.";

/**
 * Generate a vision description of a single image (raw base64 or data URL)
 * using the vision model. Used by file-vision (vault) so images become
 * searchable through the existing RAG pipeline. Non-streaming.
 *
 * Throws on failure (Ollama down, model missing, empty output) — the caller
 * (vault upload) catches and reports a clear error rather than crashing.
 */
export async function describeImage(
  imageBase64: string,
  opts: { prompt?: string; signal?: AbortSignal } = {}
): Promise<string> {
  const model = getVisionModel();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DESCRIBE_TIMEOUT_MS);
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [
          {
            role: "user",
            content: opts.prompt ?? DESCRIBE_PROMPT,
            images: [stripDataUrl(imageBase64)],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `vision model ${model} returned ${res.status}: ${body.slice(0, 200)}`
      );
    }
    const j = (await res.json()) as { message?: { content?: string } };
    const text = (j.message?.content ?? "").trim();
    if (!text) {
      throw new Error(`vision model ${model} returned an empty description`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
