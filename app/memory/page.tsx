// app/memory/page.tsx
//
// Phase 9 — operator-facing memory inspection + editing surface.
//
// Replaces the previous v2-stub placeholder. Live UI that:
//   - shows the operator profile and lets the operator edit it inline
//   - lists all memories grouped by persona, then tier
//   - shows importance / created / tags per entry
//   - prune button per entry (DELETE /api/memory/prune)
//   - "Add memory" form for explicit operator-written entries
//
// Style: functional > beautiful, dark theme, zero new deps. Lives at
// /memory and is reachable from the existing left rail nav.

"use client";

import { useCallback, useEffect, useState } from "react";

type Tier = "short_term" | "entity" | "operator_profile" | "project";
type PersonaScope = "bartimaeus" | "juniper" | "sage" | "bobby" | "shared";

interface MemoryEntry {
  id: string;
  schema_version: number;
  tier: Tier;
  persona_id: PersonaScope;
  created_at: string;
  updated_at: string;
  content: string;
  source: "conversation" | "operator_explicit" | "system";
  importance: number;
  tags: string[];
  pruned: boolean;
  audit_hash: string;
}

interface OperatorProfile {
  name: string;
  role: string;
  context: string;
  preferences: Record<string, string>;
  last_updated: string;
}

const PERSONAS: PersonaScope[] = [
  "bartimaeus",
  "juniper",
  "sage",
  "bobby",
  "shared",
];
const TIERS: Tier[] = ["short_term", "entity", "operator_profile", "project"];

const PERSONA_ACCENTS: Record<PersonaScope, string> = {
  bartimaeus: "#10b981",
  juniper: "#84cc16",
  sage: "#eab308",
  bobby: "#3b82f6",
  shared: "#a3a3a3",
};

function shortIso(s: string): string {
  // "2026-05-27T13:45:01.234Z" → "2026-05-27 13:45"
  if (!s) return "";
  return s.replace("T", " ").slice(0, 16);
}

export default function MemoryPage() {
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<OperatorProfile | null>(
    null
  );
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  const [memories, setMemories] = useState<Record<PersonaScope, MemoryEntry[]>>(
    {
      bartimaeus: [],
      juniper: [],
      sage: [],
      bobby: [],
      shared: [],
    }
  );
  const [reloading, setReloading] = useState(false);

  // Add-memory form state
  const [addPersona, setAddPersona] = useState<PersonaScope>("bartimaeus");
  const [addTier, setAddTier] = useState<Tier>("short_term");
  const [addContent, setAddContent] = useState("");
  const [addImportance, setAddImportance] = useState("0.7");
  const [addTags, setAddTags] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      const r = await fetch("/api/memory/profile", { cache: "no-store" });
      const j = (await r.json()) as { profile: OperatorProfile | null };
      setProfile(j.profile);
      setProfileDraft(
        j.profile ?? {
          name: "",
          role: "",
          context: "",
          preferences: {},
          last_updated: "",
        }
      );
    } catch (e) {
      setProfileMsg(
        `profile load failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }, []);

  const loadMemories = useCallback(async () => {
    setReloading(true);
    try {
      const next: Record<PersonaScope, MemoryEntry[]> = {
        bartimaeus: [],
        juniper: [],
        sage: [],
        bobby: [],
        shared: [],
      };
      for (const p of PERSONAS) {
        const r = await fetch(`/api/memory/list?persona=${p}`, {
          cache: "no-store",
        });
        if (!r.ok) continue;
        const j = (await r.json()) as { entries: MemoryEntry[] };
        next[p] = j.entries;
      }
      setMemories(next);
    } finally {
      setReloading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
    void loadMemories();
  }, [loadProfile, loadMemories]);

  const saveProfile = useCallback(async () => {
    if (!profileDraft) return;
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      const r = await fetch("/api/memory/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profileDraft),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        profile?: OperatorProfile;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setProfileMsg(j.error ?? `HTTP ${r.status}`);
        return;
      }
      setProfile(j.profile ?? null);
      setProfileMsg("saved.");
      window.setTimeout(() => setProfileMsg(null), 2000);
    } finally {
      setProfileBusy(false);
    }
  }, [profileDraft]);

  const prune = useCallback(
    async (id: string) => {
      if (!window.confirm("Prune this memory entry?")) return;
      const r = await fetch(
        `/api/memory/prune?id=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        window.alert(`prune failed: HTTP ${r.status}`);
        return;
      }
      await loadMemories();
    },
    [loadMemories]
  );

  const addMemory = useCallback(async () => {
    if (!addContent.trim()) return;
    setAddBusy(true);
    setAddMsg(null);
    try {
      const importance = parseFloat(addImportance);
      const tags = addTags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await fetch("/api/memory/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          persona_id: addPersona,
          tier: addTier,
          content: addContent.trim(),
          importance: Number.isFinite(importance) ? importance : 0.7,
          tags,
        }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setAddMsg(j.error ?? `HTTP ${r.status}`);
        return;
      }
      setAddMsg("added.");
      setAddContent("");
      setAddTags("");
      await loadMemories();
      window.setTimeout(() => setAddMsg(null), 2000);
    } finally {
      setAddBusy(false);
    }
  }, [addPersona, addTier, addContent, addImportance, addTags, loadMemories]);

  const setPrefKey = (k: string, v: string) => {
    if (!profileDraft) return;
    setProfileDraft({
      ...profileDraft,
      preferences: { ...profileDraft.preferences, [k]: v },
    });
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 px-8 py-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-[20px] font-medium tracking-tight">Memory</h1>
          <p className="text-[12px] text-neutral-500 mt-1">
            Phase 9 — persistent operator profile + per-persona memories.
            Pruned entries are tombstoned, not deleted; audit chain preserved.
          </p>
        </header>

        {/* Operator profile */}
        <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-neutral-100">
              Operator profile <span className="text-neutral-500 text-[11px]">(shared)</span>
            </h2>
            <div className="text-[11px] text-neutral-500">
              {profile?.last_updated
                ? `updated ${shortIso(profile.last_updated)}`
                : "not yet seeded"}
            </div>
          </div>

          {profileDraft && (
            <div className="space-y-3">
              <label className="block text-[12px]">
                <span className="text-neutral-400">Name</span>
                <input
                  className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
                  value={profileDraft.name}
                  onChange={(e) =>
                    setProfileDraft({ ...profileDraft, name: e.target.value })
                  }
                />
              </label>
              <label className="block text-[12px]">
                <span className="text-neutral-400">Role</span>
                <input
                  className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
                  value={profileDraft.role}
                  onChange={(e) =>
                    setProfileDraft({ ...profileDraft, role: e.target.value })
                  }
                />
              </label>
              <label className="block text-[12px]">
                <span className="text-neutral-400">Context</span>
                <textarea
                  rows={3}
                  className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
                  value={profileDraft.context}
                  onChange={(e) =>
                    setProfileDraft({ ...profileDraft, context: e.target.value })
                  }
                />
              </label>

              <div className="text-[12px]">
                <div className="text-neutral-400 mb-1">Preferences</div>
                <div className="space-y-1">
                  {Object.entries(profileDraft.preferences).map(([k, v]) => (
                    <div key={k} className="flex gap-2 items-center">
                      <span className="font-mono text-neutral-500 w-40 truncate text-[11px]">
                        {k}
                      </span>
                      <input
                        className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
                        value={v}
                        onChange={(e) => setPrefKey(k, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => void saveProfile()}
                  disabled={profileBusy}
                  className="px-3 py-1.5 rounded text-[12px] bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
                >
                  {profileBusy ? "Saving…" : "Save profile"}
                </button>
                {profileMsg && (
                  <span className="text-[11px] text-neutral-400">{profileMsg}</span>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Add-memory form */}
        <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <h2 className="text-[14px] font-medium text-neutral-100 mb-3">
            Add memory <span className="text-neutral-500 text-[11px]">(explicit operator write)</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2">
            <select
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
              value={addPersona}
              onChange={(e) => setAddPersona(e.target.value as PersonaScope)}
            >
              {PERSONAS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
              value={addTier}
              onChange={(e) => setAddTier(e.target.value as Tier)}
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
              placeholder="importance 0..1"
              value={addImportance}
              onChange={(e) => setAddImportance(e.target.value)}
            />
            <input
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
              placeholder="tags, comma separated"
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
            />
          </div>
          <textarea
            rows={3}
            className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
            placeholder="memory content"
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              type="button"
              onClick={() => void addMemory()}
              disabled={addBusy || !addContent.trim()}
              className="px-3 py-1.5 rounded text-[12px] bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
            >
              {addBusy ? "Saving…" : "Add memory"}
            </button>
            {addMsg && (
              <span className="text-[11px] text-neutral-400">{addMsg}</span>
            )}
          </div>
        </section>

        {/* Memories grouped by persona */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-neutral-100">
              All memories
            </h2>
            <button
              type="button"
              onClick={() => void loadMemories()}
              disabled={reloading}
              className="text-[11px] text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
            >
              {reloading ? "Reloading…" : "Reload"}
            </button>
          </div>

          {PERSONAS.map((persona) => {
            const entries = memories[persona] ?? [];
            return (
              <div
                key={persona}
                className="mb-5 border border-neutral-800 rounded-lg overflow-hidden"
              >
                <div
                  className="flex items-center gap-2 px-3 py-2 bg-neutral-900/60 border-b border-neutral-800"
                  style={{ borderLeft: `3px solid ${PERSONA_ACCENTS[persona]}` }}
                >
                  <span
                    className="text-[11px] uppercase tracking-[0.15em]"
                    style={{ color: PERSONA_ACCENTS[persona] }}
                  >
                    {persona}
                  </span>
                  <span className="text-[11px] text-neutral-500">
                    {entries.length} entr{entries.length === 1 ? "y" : "ies"}
                  </span>
                </div>
                {entries.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-neutral-600 italic">
                    no memories yet
                  </div>
                ) : (
                  <ul>
                    {entries.map((e) => (
                      <li
                        key={e.id}
                        className="px-3 py-2 border-b border-neutral-800/60 last:border-b-0 text-[12px]"
                      >
                        <div className="flex items-baseline justify-between gap-2 mb-1">
                          <div className="text-neutral-200 flex-1">
                            {e.content}
                          </div>
                          <button
                            type="button"
                            onClick={() => void prune(e.id)}
                            className="text-[10px] text-red-400 hover:text-red-200"
                            title="Tombstone this entry (not physically deleted; audit-preserved)"
                          >
                            prune
                          </button>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-neutral-500">
                          <span className="font-mono">{e.tier}</span>
                          <span>imp {e.importance.toFixed(2)}</span>
                          <span>{shortIso(e.created_at)}</span>
                          <span>{e.source}</span>
                          {e.tags.length > 0 && (
                            <span className="font-mono text-neutral-600">
                              [{e.tags.join(", ")}]
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
