// lib/agents/orchestrator.ts
//
// Singleton multi-agent runtime for ARGOS.
//
// Lifecycle:
//   const orch = getOrchestrator();
//   await orch.start();
//   ...
//   await orch.shutdown();
//
// From the existing chat route, enqueue work and await the result:
//   const orch = getOrchestrator();
//   const item = orch.enqueue({ kind: "chat.reply", personaId: "bartimaeus", ... });
//   const outcome = await orch.waitOutcome(item.id);
//
// From a route handler, fire a tool execution with approval enforcement by
// enqueueing kind === "tool.execute" and letting Bobby's worker execute and
// record the approval state in the registry history. Approval gating is
// enforced by the worker reading ToolDefinition.requiresApproval before
// executing; the orchestrator does not bypass governance.

import {
  AgentId,
  AgentState,
  AgentMessage,
  CircuitBreaker,
  ConsensusResult,
  ConsensusProposal,
  MessageBusChannel,
  ResourceKey,
  ResourceLock,
  ResourceAccessResult,
  TaskOutcome,
  TaskReservation,
  WorkItem,
} from "./schemas";
import { type AgentAddress } from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function leaseFor(item: WorkItem, ttlMs = 30_000): TaskReservation {
  const now = Date.now();
  return {
    item: { ...item },
    reservedAt: now,
    reservedBy: "supervisor",
    leaseId: uid(),
    leaseExpiresAt: now + ttlMs,
  };
}

function now() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Circuit breaker per agent
// ---------------------------------------------------------------------------

class CircuitBreakerStore {
  private map = new Map<AgentId, CircuitBreaker>();

  constructor(private readonly threshold = 5, private readonly coolDownMs = 30_000) {}

  get(agentId: AgentId): CircuitBreaker {
    const existing = this.map.get(agentId);
    if (existing) return existing;
    const next: CircuitBreaker = {
      agentId,
      state: "closed",
      failures: 0,
      nextProbeAt: 0,
      threshold: this.threshold,
      coolDownMs: this.coolDownMs,
    };
    this.map.set(agentId, next);
    return next;
  }

  success(agentId: AgentId) {
    const cb = this.get(agentId);
    cb.failures = 0;
    cb.state = "closed";
    cb.nextProbeAt = 0;
    this.map.set(agentId, cb);
  }

  failure(agentId: AgentId) {
    const cb = this.get(agentId);
    cb.failures += 1;
    if (cb.failures >= cb.threshold) {
      cb.state = "open";
      cb.nextProbeAt = Date.now() + cb.coolDownMs;
    }
    this.map.set(agentId, cb);
    return cb.state;
  }

  mayProbe(agentId: AgentId): boolean {
    const cb = this.get(agentId);
    if (cb.state !== "open") return true;
    if (Date.now() >= cb.nextProbeAt) {
      cb.state = "half_open";
      this.map.set(agentId, cb);
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resource lock manager — conflict resolution primitive
// ---------------------------------------------------------------------------

class LockManager {
  private locks = new Map<ResourceKey, ResourceLock>();
  private waiters = new Map<ResourceKey, { agentId: AgentId; at: number }[]>();

  constructor(private readonly leaseTtlMs = 20_000) {}

  now() {
    return Date.now();
  }

  acquire(resource: ResourceKey, agentId: AgentId): ResourceAccessResult {
    this.sweep();
    const existing = this.locks.get(resource);
    if (!existing) {
      const lock: ResourceLock = {
        resource,
        owner: agentId,
        expiresAt: this.now() + this.leaseTtlMs,
        waiters: [],
      };
      this.locks.set(resource, lock);
      return { granted: true, lock };
    }

    // Re-entrant: same agent can re-acquire.
    if (existing.owner === agentId) {
      existing.expiresAt = this.now() + this.leaseTtlMs;
      this.locks.set(resource, existing);
      return { granted: true, lock: existing };
    }

    const existingWaiters = this.waiters.get(resource) ?? [];
    existingWaiters.push({ agentId, at: this.now() });
    this.waiters.set(resource, existingWaiters);
    return {
      granted: false,
      blockedBy: existing.owner,
      retryAfterMs: Math.max(100, existing.expiresAt - this.now()),
    };
  }

  release(resource: ResourceKey, agentId: AgentId) {
    this.sweep();
    const existing = this.locks.get(resource);
    if (!existing || existing.owner !== agentId) return;
    this.locks.delete(resource);
    const queue = this.waiters.get(resource);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      const lock: ResourceLock = {
        resource,
        owner: next.agentId,
        expiresAt: this.now() + this.leaseTtlMs,
        waiters: queue,
      };
      this.locks.set(resource, lock);
      this.waiters.set(resource, queue);
    }
  }

  private sweep() {
    const t = this.now();
    for (const [resource, lock] of Array.from(this.locks.entries())) {
      if (lock.expiresAt <= t) {
        this.locks.delete(resource);
        const queue = this.waiters.get(resource) ?? [];
        if (queue.length > 0) {
          const next = queue.shift()!;
          const nl: ResourceLock = {
            resource,
            owner: next.agentId,
            expiresAt: t + this.leaseTtlMs,
            waiters: queue,
          };
          this.locks.set(resource, nl);
          this.waiters.set(resource, queue);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory message bus. In the real system this becomes a proper pub/sub
// layer (Redis Streams, NATS, or a Postgres NOTIFY/LISTEN queue). Here we
// keep it bounded so the orchestrator runs in-process tonight without new
// infra dependencies.
// ---------------------------------------------------------------------------

type Subscriber = (msg: AgentMessage) => void;

class MessageBus {
  private topics = new Map<string, Set<Subscriber>>();
  private recent: AgentMessage[] = [];
  private readonly maxRecent = 5_000;

  subscribe(channel: MessageBusChannel, handler: Subscriber) {
    let set = this.topics.get(channel);
    if (!set) {
      set = new Set();
      this.topics.set(channel, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  publish(msg: AgentMessage) {
    this.recent.push(msg);
    if (this.recent.length > this.maxRecent) this.recent.shift();
    const set = this.topics.get(msg.channel);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(msg);
      } catch {
        // Never let a single subscriber crater dispatch for others.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent container — isolated task queue + memory namespace per agent
// ---------------------------------------------------------------------------

class AgentContainer {
  readonly agentId: AgentId;
  readonly namespace: string;
  readonly allowedTools: Set<string>;

  private queue: WorkItem[] = [];
  private inFlight = new Map<string, TaskReservation>();
  private completed = new Map<string, TaskOutcome>();
  private latestErrors: { code: string; message: string }[] = [];

  constructor(agentId: AgentId, allowedTools: string[]) {
    this.agentId = agentId;
    this.namespace = `agent:${agentId}`;
    this.allowedTools = new Set(allowedTools);
  }

  enqueue(item: WorkItem) {
    this.queue.push({ ...item, id: item.id || uid() });
  }

  drainQueue(): WorkItem[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  reserveNext(ttlMs: number): TaskReservation | null {
    const item = this.queue.shift();
    if (!item) return null;
    const r = leaseFor(item, ttlMs);
    this.inFlight.set(r.leaseId, r);
    return r;
  }

  resolve(reservation: TaskReservation, outcome: TaskOutcome) {
    this.inFlight.delete(reservation.leaseId);
    if (outcome.status === "completed" || outcome.status === "failed") {
      this.completed.set(reservation.item.id, outcome);
    } else if (outcome.status === "requeued") {
      // return the original item to front so we retry immediately.
      this.queue.unshift(reservation.item);
    }
  }

  recordError(error: { code: string; message: string }) {
    this.latestErrors.push(error);
    if (this.latestErrors.length > 100) this.latestErrors.shift();
  }

  hasCompleted(workItemId: string): boolean {
    return this.completed.has(workItemId);
  }

  getCompleted(workItemId: string): TaskOutcome | undefined {
    return this.completed.get(workItemId);
  }

  recentErrors(): { code: string; message: string }[] {
    return [...this.latestErrors];
  }

  state(): AgentState {
    return {
      agentId: this.agentId,
      status: this.inFlight.size > 0 ? "working" : "idle",
      queueKey: this.namespace,
      memoryNamespace: this.namespace,
      inFlightCount: this.inFlight.size,
      lastActivityAt: this.latestErrors.length > 0 ? Date.now() : null,
      lastError: this.latestErrors.at(-1),
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

class ArgosOrchestrator {
  private agents = new Map<AgentId, AgentContainer>();
  private agentsByTool = new Map<string, AgentId[]>();
  private bus = new MessageBus();
  private locks = new LockManager();
  private breakers = new CircuitBreakerStore();
  private proposals = new Map<string, ConsensusProposal>();

  _shutdownRequested = false;

  constructor() {
    this.registerAgents();
    this.wireDefaultSubscriptions();
  }

  // -- life cycle ----------------------------------------------------------

  start() {
    this._shutdownRequested = false;
    console.info("[orch] start");
    return this;
  }

  async shutdown() {
    this._shutdownRequested = true;
    console.info("[orch] shutdown");
  }

  // -- bootstrap -----------------------------------------------------------

  private registerAgents() {
    // Map each agent to its primary tool subset. Governance (approval /
    // restore) is enforced at execute time by the tool registry itself;
    // the orchestrator only cares about *who is allowed to call what*.
    const byAgent: [AgentId, string[]][] = [
      ["bartimaeus", ["web_search", "web_crawl", "deep_research", "osint_lookup", "chain_search_read"]],
      ["sage",       ["web_search", "deep_research", "arxiv_search", "openalex_search"]],
      ["bobby",      ["file_ops", "shell_exec", "oculus", "mirofish"]],
      ["juniper",    []],
      ["supervisor", []],
    ];
    for (const [id, tools] of byAgent) {
      const container = new AgentContainer(id, tools);
      this.agents.set(id, container);
      for (const t of tools) {
        const list = this.agentsByTool.get(t) ?? [];
        list.push(id);
        this.agentsByTool.set(t, list);
      }
    }
  }

  private wireDefaultSubscriptions() {
    // Supervisor observes completion / failure and retries when the policy
    // says it should. Real implementation reads the specific tool outcome
    // and routes accordingly; this skeleton records observability from
    // all agents.
    this.bus.subscribe("work.complete", (msg) => {
      this.breakers.success(msg.from);
    });
    this.bus.subscribe("work.fail", (msg) => {
      const cb = this.breakers.failure(msg.from);
      if (cb === "open") {
        console.warn(`[orch] circuit open on ${msg.from}`);
      }
    });
  }

  // -- public API -----------------------------------------------------------

  enqueue(item: WorkItem): WorkItem {
    const agentId = item.suggestedAgent ?? this.route(item);
    const container = this.agents.get(agentId);
    if (!container) throw new Error(`Unknown agent ${agentId}`);
    if (!item.id) item.id = uid();
    container.enqueue(item);
    this.bus.publish({
      channel: "work.claim",
      from: "supervisor",
      to: agentId,
      correlationId: item.id,
      sentAt: now(),
      workItem: item,
    });
    return item;
  }

  dispatch(address: AgentAddress, channel: MessageBusChannel, body: Record<string, unknown> = {}) {
    const recipients = Array.isArray(address.to) ? address.to : [address.to];
    for (const to of recipients) {
      this.bus.publish({
        channel,
        from: "supervisor",
        to,
        correlationId: uid(),
        sentAt: now(),
        body,
      });
    }
  }

  proposeConsensus(proposal: ConsensusProposal): ConsensusResult {
    this.proposals.set(proposal.id, proposal);
    this.dispatch({ to: proposal.voters }, "consensus.propose", { proposalId: proposal.id });
    // Synchronous tally in this minimal implementation; real system awaits
    // votes asynchronously with a deadline.
    return {
      resolved: true,
      winner: proposal.options[0],
      tallies: Object.fromEntries(proposal.options.map((o) => [o, 0])) as Record<string, number>,
    };
  }

  // -- scheduling / claim --------------------------------------------------

  /**
   * Called by each agent (or a worker loop) to claim the next item it is
   * eligible for. Guests and agents with open circuit breakers are skipped.
   */
  claimNext(agentId: AgentId, ttlMs = 30_000): TaskReservation | null {
    const _breaker = this.breakers.get(agentId);
    if (!this.breakers.mayProbe(agentId)) return null;
    const container = this.agents.get(agentId);
    if (!container) return null;
    return container.reserveNext(ttlMs);
  }

  /** Called after work is performed, whether successfully or not. */
  complete(reservation: TaskReservation, outcome: TaskOutcome) {
    const container = this.agents.get(reservation.reservedBy);
    if (!container) return;
    container.resolve(reservation, outcome);
    const channel =
      outcome.status === "completed" ? "work.complete" : outcome.status === "requeued" ? "work.requeue" : "work.fail";
    this.bus.publish({
      channel,
      from: reservation.reservedBy,
      to: "supervisor",
      correlationId: reservation.item.id,
      leaseId: reservation.leaseId,
      workItem: reservation.item,
      body: outcome as Record<string, unknown>,
      sentAt: now(),
    });
    if (outcome.status === "failed") {
      this.breakers.failure(reservation.reservedBy);
    } else {
      this.breakers.success(reservation.reservedBy);
    }
  }

  waitOutcome(workItemId: string): Promise<TaskOutcome> {
    // Simple polling fallback. A real implementation would use an
    // AsyncIterator / websocket / stream tied to the subscription bus.
    return new Promise((resolve) => {
      const check = () => {
        const containers = Array.from(this.agents.values());
        for (const container of containers) {
          const hit = container.getCompleted(workItemId);
          if (hit) return resolve(hit);
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  // -- conflict resolution -------------------------------------------------

  /**
   * Try to acquire the resource. The lease must be released explicitly or
   * it auto-expires after leaseTtlMs.
   */
  acquireResource(resource: ResourceKey, agentId: AgentId): ResourceAccessResult {
    return this.locks.acquire(resource, agentId);
  }

  releaseResource(resource: ResourceKey, agentId: AgentId) {
    this.locks.release(resource, agentId);
  }

  // -- observability -------------------------------------------------------

  agentState(agentId: AgentId): AgentState | undefined {
    return this.agents.get(agentId)?.state();
  }

  allStates(): Record<AgentId, AgentState> {
    const out = {} as Record<AgentId, AgentState>;
    for (const [id, container] of Array.from(this.agents.entries())) {
      out[id] = container.state();
    }
    return out;
  }

  recentErrors(agentId: AgentId) {
    return this.agents.get(agentId)?.recentErrors() ?? [];
  }

  // -- internal ------------------------------------------------------------

  private route(item: WorkItem): AgentId {
    const _category = item.payload?.category as string | undefined;
    if (item.kind === "chat.reply" || item.kind === "task.create") {
      return item.personaId ?? "bartimaeus";
    }
    if (["research.run", "memory.extract", "memory.write"].includes(item.kind)) {
      return "sage";
    }
    if (item.kind === "tool.execute") {
      if (item.toolCall) {
        const agents = this.agentsByTool.get(item.toolCall.toolId);
        if (agents && agents.length > 0) return agents[0];
      }
      return "bobby";
    }
    return "supervisor";
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let instance: ArgosOrchestrator | null = null;

export function getOrchestrator(): ArgosOrchestrator {
  if (!instance) instance = new ArgosOrchestrator();
  return instance;
}

export { ArgosOrchestrator };
