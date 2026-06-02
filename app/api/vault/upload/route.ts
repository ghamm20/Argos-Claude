import { NextRequest } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { tmpUploadDir } from "@/lib/vault/paths";
import { ingest } from "@/lib/vault/store";
import { UnsupportedFileType } from "@/lib/vault/extract";
// Vision Phase 1 (2026-06-02) — file vision: images get a gemma4-turbo
// description that becomes the doc's searchable text via the RAG pipeline.
import { isImageFilename, describeImage, getVisionModel } from "@/lib/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap upload size to keep accidental drops of huge files from
// crashing the ingest pipeline. 50 MB is generous for typical
// documents (PDFs in this range are already huge) and matches
// what most vault workflows ship in production.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Vision: only inline a thumbnail data-URL for small images. Without an
// image-resize dependency (none allowed), we don't downscale — large images
// store thumb=null and rely on the stored original. Small images (≤256 KB)
// inline their own bytes as the thumb.
const THUMB_MAX_BYTES = 256 * 1024;

function safeFilename(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._\- ]+/g, "_");
}

function imageMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "expected multipart/form-data with 'file' field" },
      { status: 400 }
    );
  }

  const fileField = form.get("file");
  if (!(fileField instanceof File)) {
    return Response.json({ error: "missing 'file' field" }, { status: 400 });
  }
  if (fileField.size > MAX_FILE_BYTES) {
    return Response.json(
      {
        error: `file exceeds ${MAX_FILE_BYTES} bytes (${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB); got ${fileField.size}`,
      },
      { status: 413 }
    );
  }
  const filename = safeFilename(fileField.name);
  if (filename.length === 0) {
    return Response.json({ error: "invalid filename" }, { status: 400 });
  }

  await fsp.mkdir(tmpUploadDir(), { recursive: true });
  const tmpPath = path.join(tmpUploadDir(), `${Date.now()}-${filename}`);
  const buf = Buffer.from(await fileField.arrayBuffer());
  await fsp.writeFile(tmpPath, buf);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: unknown): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };
      try {
        let result;
        if (isImageFilename(filename)) {
          // ---- File vision: image → description → searchable text ----
          emit({ stage: "extracting" });
          const b64 = buf.toString("base64");
          let description: string;
          try {
            description = await describeImage(b64);
          } catch (visErr) {
            // Graceful, honest failure — clear message, no crash. The
            // original image is still cleaned up in finally.
            emit({
              stage: "error",
              error: `vision description failed (${
                visErr instanceof Error ? visErr.message : String(visErr)
              }). Is Ollama running with ${getVisionModel()} pulled?`,
            });
            return;
          }
          const thumb =
            buf.length <= THUMB_MAX_BYTES
              ? `data:${imageMime(filename)};base64,${b64}`
              : null;
          result = await ingest(tmpPath, {
            originalFilename: filename,
            onProgress: (p) => emit(p),
            precomputedText: description,
            extraMeta: { kind: "image", description, thumb },
          });
        } else {
          result = await ingest(tmpPath, {
            originalFilename: filename,
            onProgress: (p) => emit(p),
          });
        }
        emit({ stage: "done", result });
      } catch (e) {
        if (e instanceof UnsupportedFileType) {
          emit({ stage: "error", error: e.message });
        } else if (e instanceof Error) {
          emit({ stage: "error", error: e.message });
        } else {
          emit({ stage: "error", error: String(e) });
        }
      } finally {
        try {
          await fsp.unlink(tmpPath);
        } catch {
          /* best effort */
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
