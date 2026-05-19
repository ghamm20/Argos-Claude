import { listDocuments, totalChunkCount } from "@/lib/vault/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const docs = await listDocuments();
  const chunks = await totalChunkCount();
  return Response.json({ documents: docs, totalChunks: chunks });
}
