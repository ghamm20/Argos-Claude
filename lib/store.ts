import { create } from "zustand";
import { PERSONA_BY_ID, type PersonaId } from "./personas";

export type ChatRole = "user" | "assistant" | "system";
export type Tab = "chat" | "vault";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  personaId?: PersonaId;
  citations?: number[];
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

const DEFAULT_MODEL = "llama3.1:8b-instruct-q4_K_M";
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

  switchPersona: (id) => set({ currentPersonaId: id }),
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
    }),

  setVaultCounts: (docs, chunks) =>
    set((s) => ({ vaultStatus: { ...s.vaultStatus, docs, chunks } })),
  setVaultIngesting: (filename) =>
    set((s) => ({ vaultStatus: { ...s.vaultStatus, ingesting: filename } })),

  eyeColor: () => PERSONA_BY_ID[get().currentPersonaId].eyeColor,
  accentColor: () => PERSONA_BY_ID[get().currentPersonaId].accentColor,
  personaName: () => PERSONA_BY_ID[get().currentPersonaId].name,
}));
