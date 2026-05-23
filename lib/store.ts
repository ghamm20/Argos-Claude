import { create } from "zustand";
import { PERSONA_BY_ID, type PersonaId } from "./personas";

export type ChatRole = "user" | "assistant" | "system";
export type Tab = "chat" | "vault";

export interface CitedHit {
  index: number;
  text: string;
  filename: string;
  chunkIndex: number;
  score: number;
  docId: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  personaId?: PersonaId;
  retrievalHits?: CitedHit[];
  retrievalError?: string | null;
  isStreaming?: boolean;
  errored?: boolean;
}

export interface HudMetrics {
  latencyMs: number;
  tokensPerSec: number;
  totalTokens: number;
  timeToFirstTokenMs: number;
  p50LatencyMs: number;
  recentLatencies: number[];
}

export interface VaultStatus {
  docs: number;
  chunks: number;
  ingesting: string | null;
}

const EMPTY_METRICS: HudMetrics = {
  latencyMs: 0,
  tokensPerSec: 0,
  totalTokens: 0,
  timeToFirstTokenMs: 0,
  p50LatencyMs: 0,
  recentLatencies: [],
};

const EMPTY_VAULT: VaultStatus = {
  docs: 0,
  chunks: 0,
  ingesting: null,
};

// Phase 2 (v1.0) model roster. The four persona-bound models are the
// owner-specified canonical set; llama3.1:8b + qwen2.5:3b retained as
// fallbacks for low-VRAM / non-NVIDIA hardware tiers driven by
// lib/hardware.ts. nomic-embed-text isn't a chat model — vault only.
const DEFAULT_MODEL = "huihui_ai/gpt-oss-abliterated:20b";
export const AVAILABLE_MODELS: readonly string[] = [
  // Persona-bound (Phase 2)
  "huihui_ai/gpt-oss-abliterated:20b",                                  // Bartimaeus
  "hf.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive:Q4_K_M",    // Juniper
  "alfaxad/wild-gemma4:e4b",                                            // Sage
  "Jarcgon/gemma-4-abliterated:e2b-v2",                                 // Bobby
  // Hardware fallbacks (existing)
  "llama3.1:8b-instruct-q4_K_M",
  "qwen2.5:3b-instruct-q4_K_M",
] as const;
export function isAvailableModel(m: string): boolean {
  return AVAILABLE_MODELS.includes(m);
}
const LATENCY_WINDOW = 10;

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

interface ArgosState {
  currentPersonaId: PersonaId;
  currentModel: string;
  currentTab: Tab;
  messages: ChatMessage[];
  isStreaming: boolean;
  hudMetrics: HudMetrics;
  vaultStatus: VaultStatus;
  activeCitation: CitedHit | null;
  truthMode: boolean;
  /** The persisted-session id this chat belongs to, or null if not
   *  yet saved. Set on first auto-save after assistant completes. */
  currentSessionId: string | null;

  switchPersona: (id: PersonaId) => void;
  setModel: (m: string) => void;
  setTab: (t: Tab) => void;
  appendMessage: (m: ChatMessage) => void;
  appendToLastMessage: (chunk: string) => void;
  patchLastMessage: (patch: Partial<ChatMessage>) => void;
  setStreaming: (b: boolean) => void;
  setHudMetric: <K extends keyof HudMetrics>(key: K, value: HudMetrics[K]) => void;
  pushLatency: (ms: number) => void;
  resetHudMetrics: () => void;
  clearChat: () => void;
  setVaultCounts: (docs: number, chunks: number) => void;
  setVaultIngesting: (filename: string | null) => void;
  setActiveCitation: (hit: CitedHit | null) => void;
  setTruthMode: (b: boolean) => void;
  setCurrentSessionId: (id: string | null) => void;
  /** Replace the entire in-memory chat with a loaded persisted session. */
  loadSession: (id: string, messages: ChatMessage[], personaId: PersonaId, model: string) => void;

  eyeColor: () => string;
  accentColor: () => string;
  personaName: () => string;
}

export const useArgos = create<ArgosState>((set, get) => ({
  currentPersonaId: "bartimaeus",
  currentModel: DEFAULT_MODEL,
  currentTab: "chat",
  messages: [],
  isStreaming: false,
  hudMetrics: { ...EMPTY_METRICS },
  vaultStatus: { ...EMPTY_VAULT },
  activeCitation: null,
  truthMode: false,

  // Phase 2: persona-bound model. switchPersona ALSO updates currentModel
  // to the persona's bound model. setModel remains separately callable
  // for the Settings page's manual override.
  switchPersona: (id) =>
    set({ currentPersonaId: id, currentModel: PERSONA_BY_ID[id].model }),
  setModel: (m) => set({ currentModel: m }),
  setTab: (t) => set({ currentTab: t }),

  appendMessage: (m) =>
    set((s) => ({ messages: [...s.messages, m] })),

  appendToLastMessage: (chunk) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      const updated: ChatMessage = { ...last, content: last.content + chunk };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),

  patchLastMessage: (patch) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      const updated: ChatMessage = { ...last, ...patch };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),

  setStreaming: (b) => set({ isStreaming: b }),

  setHudMetric: (key, value) =>
    set((s) => ({ hudMetrics: { ...s.hudMetrics, [key]: value } })),

  pushLatency: (ms) =>
    set((s) => {
      const next = [...s.hudMetrics.recentLatencies, ms].slice(-LATENCY_WINDOW);
      return {
        hudMetrics: {
          ...s.hudMetrics,
          recentLatencies: next,
          p50LatencyMs: p50(next),
          latencyMs: ms,
        },
      };
    }),

  resetHudMetrics: () => set({ hudMetrics: { ...EMPTY_METRICS } }),
  clearChat: () =>
    set({
      messages: [],
      hudMetrics: { ...EMPTY_METRICS },
      isStreaming: false,
      // Clearing the chat ALSO drops the session linkage — next send
      // creates a fresh session rather than over-writing the cleared one.
      currentSessionId: null,
    }),

  setVaultCounts: (docs, chunks) =>
    set((s) => ({ vaultStatus: { ...s.vaultStatus, docs, chunks } })),
  setVaultIngesting: (filename) =>
    set((s) => ({ vaultStatus: { ...s.vaultStatus, ingesting: filename } })),
  setActiveCitation: (hit) => set({ activeCitation: hit }),
  setTruthMode: (b) => set({ truthMode: b }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),

  loadSession: (id, messages, personaId, model) =>
    set({
      currentSessionId: id,
      messages,
      currentPersonaId: personaId,
      currentModel: model,
      hudMetrics: { ...EMPTY_METRICS },
      isStreaming: false,
    }),

  currentSessionId: null,

  eyeColor: () => PERSONA_BY_ID[get().currentPersonaId].eyeColor,
  accentColor: () => PERSONA_BY_ID[get().currentPersonaId].accentColor,
  personaName: () => PERSONA_BY_ID[get().currentPersonaId].name,
}));
