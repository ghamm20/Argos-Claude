"use client";

import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, FileText } from "lucide-react";
import { useArgos } from "@/lib/store";
import { PERSONA_BY_ID } from "@/lib/personas";

export function CitationDrawer() {
  const activeCitation = useArgos((s) => s.activeCitation);
  const setActiveCitation = useArgos((s) => s.setActiveCitation);
  const currentPersonaId = useArgos((s) => s.currentPersonaId);
  const accent = PERSONA_BY_ID[currentPersonaId].accentColor;

  useEffect(() => {
    if (!activeCitation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveCitation(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeCitation, setActiveCitation]);

  const open = activeCitation !== null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) setActiveCitation(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="citation-overlay"
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]"
        />
        <Dialog.Content
          data-testid="citation-drawer"
          className="fixed inset-y-0 right-0 z-50 w-[420px] max-w-[90vw] bg-neutral-950 border-l border-neutral-800 shadow-2xl flex flex-col focus:outline-none"
          style={{ borderLeftColor: accent + "60" }}
        >
          {activeCitation && (
            <>
              <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
                <div>
                  <Dialog.Title className="text-[11px] uppercase tracking-[0.2em] text-neutral-500">
                    Source
                  </Dialog.Title>
                  <div className="flex items-center gap-2 mt-1">
                    <FileText
                      size={14}
                      strokeWidth={1.5}
                      style={{ color: accent }}
                    />
                    <div className="text-[14px] font-medium text-neutral-100 truncate">
                      {activeCitation.filename}
                    </div>
                  </div>
                </div>
                <Dialog.Close asChild>
                  <button
                    aria-label="Close source drawer"
                    data-testid="citation-close"
                    className="text-neutral-500 hover:text-neutral-200 transition-colors p-1"
                  >
                    <X size={16} strokeWidth={1.5} />
                  </button>
                </Dialog.Close>
              </div>

              <div className="px-5 py-3 border-b border-neutral-800/70 grid grid-cols-3 gap-3 text-[10px] uppercase tracking-[0.16em] text-neutral-500">
                <div>
                  <div>Citation</div>
                  <div
                    className="font-mono text-[13px] mt-1"
                    style={{ color: accent }}
                  >
                    [{activeCitation.index}]
                  </div>
                </div>
                <div>
                  <div>Chunk</div>
                  <div className="font-mono text-[13px] text-neutral-200 mt-1">
                    #{activeCitation.chunkIndex}
                  </div>
                </div>
                <div>
                  <div>Score</div>
                  <div className="font-mono text-[13px] text-neutral-200 mt-1">
                    {activeCitation.score.toFixed(3)}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 mb-2">
                  Chunk text
                </div>
                <div className="text-[13px] leading-relaxed text-neutral-200 whitespace-pre-wrap font-mono">
                  {activeCitation.text}
                </div>
              </div>
              <Dialog.Description className="sr-only">
                Source chunk preview for citation {activeCitation.index} from {activeCitation.filename}
              </Dialog.Description>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
