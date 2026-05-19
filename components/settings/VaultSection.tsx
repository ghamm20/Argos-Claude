"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useArgos } from "@/lib/store";

interface DocumentMeta {
  id: string;
  filename: string;
  ingestedAt: number;
  chunkCount: number;
  byteSize: number;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function VaultSection() {
  const setVaultCounts = useArgos((s) => s.setVaultCounts);
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/vault/list", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        documents: DocumentMeta[];
        totalChunks: number;
      };
      setDocs(j.documents);
      setTotalChunks(j.totalChunks);
      setVaultCounts(j.documents.length, j.totalChunks);
    } catch {
      /* offline */
    }
  }, [setVaultCounts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    async (docId: string) => {
      setBusy(true);
      try {
        await fetch("/api/vault/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docId }),
        });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const clearAll = useCallback(async () => {
    setBusy(true);
    try {
      for (const d of docs) {
        await fetch("/api/vault/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docId: d.id }),
        });
      }
      await refresh();
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }, [docs, refresh]);

  const totalBytes = docs.reduce((s, d) => s + d.byteSize, 0);

  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">Vault</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Document index management. Upload happens from the Vault tab.
      </p>

      <div className="rounded-md border border-neutral-800 bg-black/30 px-4 py-3 mb-6 grid grid-cols-3 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
            Docs
          </div>
          <div className="text-[18px] font-mono text-neutral-100 mt-0.5">
            {docs.length}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
            Chunks
          </div>
          <div className="text-[18px] font-mono text-neutral-100 mt-0.5">
            {totalChunks}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
            On-disk
          </div>
          <div className="text-[18px] font-mono text-neutral-100 mt-0.5">
            {fmtSize(totalBytes)}
          </div>
        </div>
      </div>

      {docs.length === 0 ? (
        <div className="text-[12px] text-neutral-500 text-center py-8 border border-dashed border-neutral-800 rounded-md">
          Vault is empty. Drop a doc from the Vault tab.
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-md border border-neutral-800 bg-black/30 px-3 py-2.5"
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
                    {new Date(d.ingestedAt).toLocaleString()}
                  </div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                onClick={() => void remove(d.id)}
                className="text-neutral-500 hover:text-red-400 hover:bg-transparent"
                title="Delete"
                data-testid={`settings-delete-${d.id}`}
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </Button>
            </div>
          ))}
        </div>
      )}

      {docs.length > 0 && (
        <div className="mt-6 pt-4 border-t border-neutral-800/60">
          {confirmClear ? (
            <div className="flex items-center gap-2 text-[12px] text-neutral-300">
              <span>
                Delete all {docs.length} doc{docs.length === 1 ? "" : "s"}?
              </span>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void clearAll()}
                data-testid="vault-clear-confirm"
              >
                Delete
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmClear(true)}
              className="text-red-400 hover:bg-red-500/10 border-red-500/40"
            >
              <Trash2 size={12} strokeWidth={1.5} className="mr-1.5" />
              Clear vault
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
