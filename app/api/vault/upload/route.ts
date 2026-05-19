import { NextRequest } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { tmpUploadDir } from "@/lib/vault/paths";
import { ingest } from "@/lib/vault/store";
import { UnsupportedFileType } from "@/lib/vault/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFilename(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._\- ]+/g, "_");
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
        const result = await ingest(tmpPath, {
          originalFilename: filename,
          onProgress: (p) => emit(p),
        });
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
