"use client";

// components/settings/ApiKeysSection.tsx
//
// Web Capability TIER 0 (2026-06-02) — operator-facing API key management.
// Currently the GitHub PAT (lifts /search rate 60→5000/hr). Values are
// password-style, sent as plaintext over loopback, encrypted server-side at
// rest, and masked on read. "Test connection" probes the live API.

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Eye, EyeOff, CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface KeyStatus {
  configured: boolean;
  hint: string | null;
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; login?: string }
  | { kind: "fail"; error: string };

export function ApiKeysSection() {
  const [github, setGithub] = useState("");
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<KeyStatus>({ configured: false, hint: null });
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { apiKeys?: { github?: KeyStatus } };
      if (j.apiKeys?.github) setStatus(j.apiKeys.github);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (value: string | null) => {
      setSaving(true);
      setNotice(null);
      try {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKeys: { github: value } }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          setNotice(j.error ?? `save failed (${r.status})`);
          return;
        }
        setGithub("");
        setTest({ kind: "idle" });
        setNotice(value ? "Saved + encrypted." : "Cleared.");
        await refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [refresh]
  );

  const runTest = useCallback(async () => {
    setTest({ kind: "testing" });
    try {
      const body: { key: string; token?: string } = { key: "github" };
      if (github.trim()) body.token = github.trim();
      const r = await fetch("/api/web/test-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { ok?: boolean; login?: string; error?: string };
      if (j.ok) setTest({ kind: "ok", login: j.login });
      else setTest({ kind: "fail", error: j.error ?? "connection failed" });
    } catch (e) {
      setTest({ kind: "fail", error: e instanceof Error ? e.message : String(e) });
    }
  }, [github]);

  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-neutral-200">
        <KeyRound size={16} strokeWidth={1.5} className="text-neutral-500" />
        API Keys
      </div>
      <p className="mt-1 text-[12px] text-neutral-500 leading-relaxed">
        Optional external API credentials. Stored encrypted at rest
        (AES-256-GCM) under <span className="font-mono">config/</span>, masked
        on read, never logged. All web sources work keyless — keys only raise
        rate limits or unlock private data.
      </p>

      {/* GitHub */}
      <div className="mt-5 rounded-lg border border-neutral-800/70 bg-neutral-950/40 p-4">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-neutral-200">GitHub Personal Access Token</div>
          <StatusPill configured={status.configured} />
        </div>
        <div className="mt-1 text-[11px] text-neutral-500">
          Lifts the GitHub search rate from 60 → 5000 requests/hour. A
          read-only (public_repo) token is sufficient.
          {status.configured && status.hint && (
            <> Current: <span className="font-mono text-neutral-400">{status.hint}</span></>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={reveal ? "text" : "password"}
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder={status.configured ? "Enter a new token to replace…" : "ghp_…"}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md bg-neutral-900/70 border border-neutral-800 px-3 py-2 pr-9 text-[12px] font-mono text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
              aria-label={reveal ? "Hide token" : "Show token"}
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save(github.trim())}
            disabled={saving || github.trim().length === 0}
            className="rounded-md border border-emerald-600/50 text-emerald-400 px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-emerald-600/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={test.kind === "testing" || (!github.trim() && !status.configured)}
            className="rounded-md border border-neutral-700 text-neutral-300 px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-neutral-800/60 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {test.kind === "testing" && <Loader2 className="h-3 w-3 animate-spin" />}
            Test connection
          </button>
          {status.configured && (
            <button
              type="button"
              onClick={() => void save(null)}
              disabled={saving}
              className="rounded-md border border-red-700/50 text-red-400 px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-red-600/10 disabled:opacity-40"
            >
              Clear
            </button>
          )}
        </div>

        {test.kind === "ok" && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected{test.login ? ` as ${test.login}` : ""}.
          </div>
        )}
        {test.kind === "fail" && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-red-400">
            <XCircle className="h-3.5 w-3.5" />
            {test.error}
          </div>
        )}
      </div>

      {notice && <div className="mt-3 text-[11px] text-neutral-400">{notice}</div>}
    </div>
  );
}

function StatusPill({ configured }: { configured: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border"
      style={{
        borderColor: configured ? "rgba(16,185,129,0.4)" : "rgba(115,115,115,0.4)",
        color: configured ? "#10b981" : "#a3a3a3",
      }}
    >
      {configured ? "Configured" : "Not set"}
    </span>
  );
}
