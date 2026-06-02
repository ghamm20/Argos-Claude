// components/tools/ToolApprovalDialog.tsx
//
// Tools Phase (2026-06-02) — operator approval gate for a dangerous tool.
// Shown when a tool_approval_required event fires. Discloses what the tool
// will do, the risks, and whether it is reversible. APPROVE / DENY, with a
// 60-second countdown that AUTO-DENIES (governance default = no). Escape
// denies. Blocks input until resolved.

"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";

export interface ToolApprovalReq {
  approvalId: string;
  toolId: string;
  tool: string;
  description: string;
  risks: string;
  reversible: boolean;
}

export function ToolApprovalDialog({
  req,
  onResolve,
}: {
  req: ToolApprovalReq;
  onResolve: (decision: "approve" | "deny") => void;
}) {
  const [secs, setSecs] = useState(60);

  // 60s countdown → auto-deny. Reset whenever a new request appears.
  useEffect(() => {
    setSecs(60);
    const t = setInterval(() => {
      setSecs((s) => {
        if (s <= 1) {
          clearInterval(t);
          onResolve("deny");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.approvalId]);

  // Escape always denies.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onResolve("deny");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [req.approvalId, onResolve]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      data-testid="tool-approval-dialog"
    >
      <div className="w-[460px] max-w-[92vw] rounded-lg border border-amber-600/60 bg-neutral-950 p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-[13px] font-medium uppercase tracking-[0.12em]">
              Tool approval required
            </span>
          </div>
          <span
            className="text-[11px] font-mono px-1.5 py-0.5 rounded border"
            style={{
              color: secs <= 10 ? "#ef4444" : "#a3a3a3",
              borderColor: secs <= 10 ? "#7f1d1d" : "#404040",
            }}
            title="Auto-denies on timeout"
          >
            {secs}s
          </span>
        </div>

        <div className="text-[14px] text-neutral-100 font-medium mb-1">{req.tool}</div>
        <div className="text-[12px] text-neutral-400 mb-3">{req.description}</div>

        <div className="rounded border border-amber-800/50 bg-amber-950/30 px-3 py-2 mb-3">
          <div className="text-[10px] uppercase tracking-[0.16em] text-amber-400 mb-1">
            Risk disclosure
          </div>
          <div className="text-[12px] text-amber-100/90">{req.risks}</div>
        </div>

        <div className="text-[12px] mb-4">
          <span className="text-neutral-500">Reversible: </span>
          <span style={{ color: req.reversible ? "#10b981" : "#ef4444" }}>
            {req.reversible ? "yes" : "NO — cannot be undone"}
          </span>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve("deny")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-red-700/60 text-red-300 hover:bg-red-900/30"
          >
            <X className="h-3.5 w-3.5" /> Deny
          </button>
          <button
            type="button"
            onClick={() => onResolve("approve")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-emerald-600/60 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60"
          >
            <Check className="h-3.5 w-3.5" /> Approve
          </button>
        </div>
      </div>
    </div>
  );
}
