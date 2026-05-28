// app/api/vault/reingest/route.ts
//
// Vault long-form fix (2026-05-28) — re-chunk + re-embed existing
// documents using the current chunker presets, without requiring
// re-upload.
//
// POST /api/vault/reingest
// Body shapes:
//   { docId: string }            — re-ingest a single document
//   { docIds: string[] }         — re-ingest specific documents
//   { all: true }                — re-ingest every document
//   { minByteSize: number }      — re-ingest every document at or
//                                  above this byte threshold (useful
//                                  for "refresh all long-form docs"
//                                  after the chunker heuristic ships)
//
// Returns: { results: Array<{docId, filename, ok, chunkCountBefore,
//                            chunkCountAfter, durationMs, error?}> }
//
// Re-embeds against the local Ollama (nomic-embed-text). Time-cost
// is dominated by embed throughput: ~1s per chunk on the 3060 Ti
// rig. A 500-chunk book takes ~8 minutes. Caller is expected to
// keep the connection open OR pass {all:true} and walk away.

import { NextRequest } from "next/server";
import {
  listDocuments,
  reingestDocument,
} from "@/lib/vault/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hard cap of 30 minutes — well above the worst-case full re-ingest
// of the Stroud trilogy on the 3060 Ti rig (~30-40 min for ~1700
// chunks total at 1s each). Next.js default 60s would time out.
export const maxDuration = 1800;

interface ReingestBody {
  docId?: string;
  docIds?: string[];
  all?: boolean;
  minByteSize?: number;
}

interface OneResult {
  docId: string;
  filename: string;
  ok: boolean;
  chunkCountBefore: number;
  chunkCountAfter?: number;
  durationMs?: number;
  error?: string;
}

export async function POST(req: NextRequest) {
  let body: ReingestBody;
  try {
    body = (await req.json()) as ReingestBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const allDocs = await listDocuments();
  let targets: typeof allDocs = [];

  if (typeof body.docId === "string" && body.docId.length > 0) {
    const found = allDocs.find((d) => d.id === body.docId);
    if (!found) {
      return Response.json(
        { error: `no document with docId=${body.docId}` },
        { status: 404 }
      );
    }
    targets = [found];
  } else if (
    Array.isArray(body.docIds) &&
    body.docIds.every((d) => typeof d === "string")
  ) {
    const set = new Set(body.docIds);
    targets = allDocs.filter((d) => set.has(d.id));
    if (targets.length === 0) {
      return Response.json(
        { error: "none of the supplied docIds matched any document" },
        { status: 404 }
      );
    }
  } else if (body.all === true) {
    targets = allDocs;
  } else if (
    typeof body.minByteSize === "number" &&
    body.minByteSize > 0
  ) {
    targets = allDocs.filter((d) => d.byteSize >= body.minByteSize!);
    if (targets.length === 0) {
      return Response.json(
        {
          error: `no documents at or above ${body.minByteSize} bytes`,
          results: [],
        },
        { status: 200 }
      );
    }
  } else {
    return Response.json(
      {
        error:
          "supply one of: docId (string) | docIds (string[]) | all (true) | minByteSize (number)",
      },
      { status: 400 }
    );
  }

  const results: OneResult[] = [];
  for (const doc of targets) {
    const before = doc.chunkCount;
    try {
      const r = await reingestDocument(doc.id);
      results.push({
        docId: doc.id,
        filename: doc.filename,
        ok: true,
        chunkCountBefore: before,
        chunkCountAfter: r.chunkCount,
        durationMs: Math.round(r.durationMs),
      });
    } catch (e) {
      results.push({
        docId: doc.id,
        filename: doc.filename,
        ok: false,
        chunkCountBefore: before,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return Response.json({
    count: results.length,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    results,
  });
}
