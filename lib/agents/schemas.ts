// lib/agents/schemas.ts
//
// Message bus + orchestrator contracts for the multi-agent layer.
// Compatible with the existing Next.js route handlers and lib/auth.ts
// token model. This file is intentionally dependency-light so it can
// be imported from routes, lib/, and tests without creating cycles.

// ---------------------------------------------------------------------------
// Core agent identities
// ---------------------------------------------------------------------------

export type AgentId = "bartimaeus" | "juniper" | "sage" | "bobby" | "supervisor";

export const AGENT_META: Record<AgentId, { name: string; role: string }> = {
  bartimaeus: { name: "Bartimaeus", role: "operator_primary" },
  juniper:    { name: "Juniper",    role: "conversationalist" },
  sage:       { name: "Sage",       role: "research_synthesis" },
  bobby:      { name: "Bobby",      role: "code_ops" },
  supervisor: { name: "Supervisor", role: "orchestrator" },
};

// ---------------------------------------------------------------------------
// Envelope / addressing
// ---------------------------------------------------------------------------

export type AgentAddress = {
  to: AgentId | AgentId[];
  /** Optional fallback when `to` is offline. */
  fallback?: AgentId;
};

// ---------------------------------------------------------------------------
// Work item contract
// ---------------------------------------------------------------------------

export type WorkKind =
  | "chat.reply"
  | "research.run"
  | "tool.execute"
  | "memory.write"
  | "memory.extract"
  | "task.create"
  | "loop.run"
  | "dispatch.fire"
  | "broadcast";

export type Priority = "low" | "normal" | "high" | "critical";

export interface WorkItem {
  id: string;
  kind: WorkKind;
  priority: Priority;
  /** Human/operator-visible tag. Useful for audit and the Tools UI. */
  label?: string;
  /** The originating request context, if any. */
  requestContext?: {
    /** The Next.js chat session id, when this work is tied to a conversation. */
    sessionId?: string | null;
    /** The raw operator message that triggered delegation. */
    operatorMessage?: string;
    /** HTTP authorization bearer, copied so child tasks don't need the header. */
    bearerToken?: string | null;
  };
  /** Persona/routing hints. */
  personaId?: "bartimaeus" | "juniper" | "sage" | "bobby";
  /** Tool call specifics when kind === tool.execute. */
  toolCall?: {
    toolId: string;
    params: Record<string, unknown>;
  };
  /** Research specifics when kind === research.run. */
  research?: {
    stream: string;
    query?: string;
  };
  /** Arbitrary payload the worker interprets. */
  payload: Record<string, unknown>;
  /** Routing hint used by the supervisor. */
  suggestedAgent?: AgentId;
  /** Retry budget. Defaults to 2. */
  maxRetries?: number;
  /** Epoch ms deadline. */
  deadlineAt?: number;
}

// ---------------------------------------------------------------------------
// Agent-local state — each agent owns this in its execution context
// ---------------------------------------------------------------------------

export type AgentState = {
  agentId: AgentId;
  status: "idle" | "working" | "error" | "draining";
  /** Namespace-qualified queue key. */
  queueKey: string;
  memoryNamespace: string;
  /** Bookkeeping for isolation boundaries. */
  inFlightCount: number;
  lastActivityAt: number | null;
  /** Optional diagnostics for the HUD / operator view. */
  lastError?: { code: string; message: string; at?: number };
};

// ---------------------------------------------------------------------------
// Task queue / reservation contract
// ---------------------------------------------------------------------------

export type TaskReservation = {
  item: WorkItem;
  reservedAt: number;
  reservedBy: AgentId;
  /** Heartbeat token. Completion must echo this. */
  leaseId: string;
  /** Wall-clock expiry for the lease. */
  leaseExpiresAt: number;
};

export type TaskOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: { code: string; message: string } }
  | { status: "requeued"; reason: string };

// ---------------------------------------------------------------------------
// Failure isolation / circuit breaker
// ---------------------------------------------------------------------------

export type CircuitBreakerState = "closed" | "open" | "half_open";

export type CircuitBreaker = {
  agentId: AgentId;
  state: CircuitBreakerState;
  /** Failure count toward the threshold. */
  failures: number;
  /** Epoch ms when an open breaker may be probed again. */
  nextProbeAt: number;
  /** Configurable threshold. */
  threshold: number;
  /** Configurable cool-down. */
  coolDownMs: number;
};

// ---------------------------------------------------------------------------
// Inter-agent message bus
// ---------------------------------------------------------------------------

export type MessageBusChannel =
  | "work.claim"
  | "work.complete"
  | "work.fail"
  | "work.requeue"
  | "agent.heartbeat"
  | "agent.error"
  | "resource.lock"
  | "resource.unlock"
  | "consensus.propose"
  | "consensus.vote"
  | "broadcast";

export interface AgentMessage {
  channel: MessageBusChannel;
  /** Originating agent. supervisor originates many control messages. */
  from: AgentId;
  /** Logical recipient; subscribers filter on this. */
  to: AgentId | AgentId[];
  /** Correlation id across the lifecycle of one work item. */
  correlationId: string;
  /** Echoed from the reservation. */
  leaseId?: string;
  /** When the work item this message refers to is known. */
  workItem?: WorkItem;
  /** Structured body for control channels. */
  body?: Record<string, unknown>;
  /** Epoch ms. */
  sentAt: number;
}

// ---------------------------------------------------------------------------
// Resource locking — conflict resolution primitive
// ---------------------------------------------------------------------------

export type ResourceKey = string; // e.g. "settings", "vault", "memory.extraction", "session:xyz"

export interface ResourceLock {
  resource: ResourceKey;
  owner: AgentId;
  /** Short lease so crashed workers don't hold locks forever. */
  expiresAt: number;
  /** Observers waiting on the lock. */
  waiters: { agentId: AgentId; at: number }[];
}

export type ResourceAccessResult =
  | { granted: true; lock: ResourceLock }
  | { granted: false; blockedBy: AgentId; retryAfterMs: number };

// ---------------------------------------------------------------------------
// Consensus — for decisions requiring multi-agent agreement
// ---------------------------------------------------------------------------

export type ConsensusProposal = {
  id: string;
  topic: string;
  /** The decision being put to a vote. */
  question: string;
  /** Options. */
  options: string[];
  /** Agents eligible to vote. */
  voters: AgentId[];
  /** Deadline epoch ms. */
  expiresAt: number;
  votes: Record<AgentId, string>;
};

export type ConsensusResult =
  | { resolved: true; winner: string; tallies: Record<string, number> }
  | { resolved: false; reason: "expired" | "tie" | "quorum_not_met"; tallies: Record<string, number> };

// ---------------------------------------------------------------------------
// Supervisor routing hints (used by the router and the API layer)
// ---------------------------------------------------------------------------

export type RoutingDecision = {
  agentId: AgentId;
  reason: string;
  /** If true, supervisor proposes splitting the work into multiple agents. */
  parallel?: boolean;
  /** Suggested parallel agents. */
  delegates?: AgentId[];
};
