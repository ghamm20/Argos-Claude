"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Trash2, FileText } from "lucide-react";
import { useArgos } from "@/lib/store";
import { Button } from "@/components/ui/button";

interface DocumentMeta {
  id: string;
  filename: string;
  ingestedAt: number;
  chunkCount: number;
  byteSize: number;
}

interface ProgressEvent {
  stage: string;
  current?: number;
  total?: number;
  error?: string;
  result?: { docId: string; chunkCount: number; embeddingDurationMs: number };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function VaultPanel() {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setVaultCounts = useArgos((s) => s.setVaultCounts);
  const setVaultIngesting = useArgos((s) => s.setVaultIngesting);
  const accent = useArgos((s) => s.accentColor());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/vault/list", { cache: "no-store" });
      if (!r.ok) return;
      const json = (await r.json()) as {
        documents: DocumentMeta[];
        totalChunks: number;
      };
      setDocs(json.documents);
      setVaultCounts(json.documents.length, json.totalChunks);
    } catch {
      /* ignore */
    }
  }, [setVaultCounts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setProgress({ stage: "uploading" });
      setVaultIngesting(file.name);
      const fd = new FormData();
      fd.append("file", file);
      let res: Response;
      try {
        res = await fetch("/api/vault/upload", { method: "POST", body: fd });
      } catch (e) {
        setError(`upload failed: ${e instanceof Error ? e.message : String(e)}`);
        setProgress(null);
        setVaultIngesting(null);
        return;
      }
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        setError(`upload failed ${res.status}: ${t}`);
        setProgress(null);
        setVaultIngesting(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const obj = JSON.parse(line) as ProgressEvent;
              if (obj.stage === "error") {
                setError(obj.error || "ingestion error");
                setProgress(null);
                setVaultIngesting(null);
                return;
              }
              setProgress(obj);
            } catch {
              /* malformed line, skip */
            }
          }
          nl = buf.indexOf("\n");
        }
      }
      setVaultIngesting(null);
      await refresh();
      setProgress(null);
    },
    [refresh, setVaultIngesting]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void upload(files[0]);
    },
    [upload]
  );

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void upload(file);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [upload]
  );

  const remove = useCallback(
    async (docId: string) => {
      await fetch("/api/vault/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId }),
      });
      await refresh();
    },
    [refresh]
  );

  const progressLabel = (p: ProgressEvent): string => {
    switch (p.stage) {
      case "uploading":
        return "Uploading…";
      case "extracting":
        return "Extracting text…";
      case "chunking":
        return "Chunking…";
      case "embedding":
        return p.current && p.total
          ? `Embedding ${p.current}/${p.total}…`
          : "Embedding…";
      case "done":
        return "Done.";
      default:
        return p.stage;
    }
  };

  return (
    <section className="flex-1 flex flex-col min-w-0 px-10 py-6 overflow-hidden">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[20px] font-semibold tracking-wide text-neutral-200">
          Vault
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
          {docs.length} {docs.length === 1 ? "doc" : "docs"}
        </div>
      </div>
      <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-6">
        Local · sha256 dedup · nomic-embed-text · cosine retrieval
      </div>

      <label
        data-testid="vault-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className="block rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors"
        style={{
          borderColor: dragOver ? accent : "rgba(64,64,64,0.6)",
          background: dragOver ? `${accent}10` : "rgba(10,10,10,0.4)",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.docx,.md,.markdown,.txt"
          onChange={onFileSelect}
        />
        <Upload
          size={24}
          className="mx-auto mb-2 text-neutral-500"
          strokeWidth={1.5}
        />
        <div className="text-neutral-300 text-[13px]">
          Drop a file here or click to upload
        </div>
        <div className="text-neutral-600 text-[10px] uppercase tracking-[0.18em] mt-2">
          .pdf · .docx · .md · .txt
        </div>
      </label>

      {progress && (
        <div className="mt-4 text-[12px] text-neutral-300 flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full animate-pulse"
            style={{ background: accent }}
          />
          {progressLabel(progress)}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
          {error}
        </div>
      )}

      <div className="mt-8 flex-1 overflow-y-auto">
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 mb-2">
          Documents
        </div>
        {docs.length === 0 ? (
          <div className="text-center text-neutral-600 text-[12px] mt-8">
            No documents indexed.
          </div>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded-md border border-neutral-800 bg-black/40 px-3 py-2.5"
              >
                <div className="flex items-start gap-3 min-w-0 flex-1 mr-3">
                  <FileText
                    size={14}
                    strokeWidth={1.5}
                    className="text-neutral-500 mt-0.5 shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-[13px] text-neutral-200 truncate">
                      {d.filename}
                    </div>
                    <div className="text-[10px] text-neutral-500 mt-0.5">
                      {d.chunkCount} chunks · {fmtSize(d.byteSize)} ·{" "}
                      {fmtTime(d.ingestedAt)}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void remove(d.id)}
                  className="text-neutral-500 hover:text-red-400 hover:bg-transparent"
                  title="Delete"
                  data-testid={`delete-${d.id}`}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
