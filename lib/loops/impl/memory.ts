// lib/loops/impl/memory.ts
//
// Memory / retrieval loops: Memory Consolidation (11), Ouroboros RAG (9),
// Skill Acquisition (12), Active Learning (16). These read ARGOS's real state
// (the operator fact store) and the ground-truth benchmark.

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { LoopDefinition, LoopContext } from "../loop";
import { personaModel, loopModelCall } from "../loop";
import { loopFail, type LoopResult } from "../types";
import { readFacts } from "../../memory-extract";
import { readAllTraces } from "../trace-store";
import { runBenchmark } from "../benchmark";
import { argosRoot } from "../../vault/paths";

function inputStr(ctx: LoopContext, key: string, fallback = ""): string {
  const v = ctx.input?.[key];
  return typeof v === "string" ? v : fallback;
}

function terms(s: string): string[] {
  return Array.from(
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
    )
  );
}

// --- Loop11: Memory Consolidation (Sunday 3AM) ------------------------------
// Read the operator fact store and propose a deduped/consolidated set. Low-risk
// memory proposal — NOT auto-applied (append-only doctrine; operator applies).
export const memoryConsolidation: LoopDefinition = {
  id: "memory_consolidation",
  loopNumber: 11,
  name: "Memory Consolidation",
  description: "Consolidate + dedupe the operator fact store (Sunday 3AM).",
  trigger: "scheduled",
  schedule: { dayOfWeek: 0, hour: 3, minute: 0, label: "Sunday 3AM" },
  async run(_ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const facts = await readFacts();
      if (facts.length === 0) {
        return {
          loopId: "memory_consolidation",
          loopNumber: 11,
          ok: true,
          summary: "no facts to consolidate",
          claimedImprovement: false,
          claimedScore: null,
          benchmarkBefore: null,
          benchmarkAfter: null,
          evidence: [],
          proposals: [],
          data: { factCount: 0 },
          error: null,
          durationMs: Date.now() - start,
        };
      }
      // Archive a snapshot of the current facts BEFORE consolidating (additive
      // history under data/memory/archive/YYYY-MM/).
      const month = new Date().toISOString().slice(0, 7);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let archivePath: string | null = path.join(argosRoot(), "data", "memory", "archive", month, `facts-${stamp}.jsonl`);
      try {
        await fsp.mkdir(path.dirname(archivePath), { recursive: true });
        await fsp.writeFile(archivePath, facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
      } catch {
        archivePath = null;
      }

      const list = facts
        .map((f) => `- [${f.category}] ${f.fact} (${f.confidence})`)
        .join("\n")
        .slice(0, 3500);
      const out = await loopModelCall(
        personaModel("bartimaeus"),
        "You consolidate a memory store. (1) Merge duplicates/near-duplicates, drop trivia, keep durable high-signal facts as a clean bulleted list. (2) Then on a new line output '---CONTRADICTIONS---' followed by any pairs of facts that contradict each other (one per line), or 'none'. No other prose.",
        `FACTS (${facts.length}):\n${list}`,
        { numPredict: 700, temperature: 0.2 }
      );
      const [consPart, contraPart = ""] = out.split(/---\s*CONTRADICTIONS\s*---/i);
      const lines = consPart.split("\n").filter((l) => l.trim().startsWith("-"));
      const contradictions = contraPart
        .split("\n")
        .map((l) => l.replace(/^[-*]\s*/, "").trim())
        .filter((l) => l && !/^none$/i.test(l) && l.length > 3);
      // Quality score: fraction retained, penalized by contradictions found.
      const retained = facts.length > 0 ? Math.min(1, lines.length / facts.length) : 0;
      const quality = Math.max(0, Math.min(1, retained - contradictions.length * 0.1));

      return {
        loopId: "memory_consolidation",
        loopNumber: 11,
        ok: true,
        summary: `consolidated ${facts.length}→${lines.length}, ${contradictions.length} contradiction(s), quality ${quality.toFixed(2)}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [
          {
            kind: "memory",
            description: `Replace ${facts.length} facts with ${lines.length} consolidated facts (operator applies).`,
            payload: consPart.trim(),
          },
        ],
        data: {
          before: facts.length,
          kept: lines.length,
          consolidated: consPart.trim(),
          output: consPart.trim(),
          contradictions,
          quality,
          archivePath,
        },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("memory_consolidation", 11, (e as Error).message, start);
    }
  },
};

// --- Loop9: Ouroboros RAG ---------------------------------------------------
// Self-improving retrieval. Probe the fact store with a query, measure keyword
// coverage, ask the model to reformulate for better recall, re-probe, compare.
// Informational — reports whether the reformulation recalls more.
export const ouroborosRag: LoopDefinition = {
  id: "ouroboros_rag",
  loopNumber: 9,
  name: "Ouroboros RAG",
  description: "Self-improving retrieval: reformulate a query to recall more.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const facts = await readFacts();
      const corpus = facts.map((f) => f.fact);
      let query = inputStr(ctx, "query");
      if (!query) {
        query = corpus.length > 0 ? terms(corpus[0]).slice(0, 3).join(" ") : "operator";
      }
      const recall = (q: string): number => {
        const qt = terms(q);
        if (qt.length === 0) return 0;
        return corpus.filter((doc) => {
          const dt = terms(doc);
          return qt.some((t) => dt.includes(t));
        }).length;
      };
      const hitsBefore = recall(query);
      const reformulated = (
        await loopModelCall(
          personaModel("sage"),
          "You improve a search query for keyword retrieval. Given a query, output ONE reformulated query (more synonyms / broader terms) on a single line. No preamble, no quotes.",
          `QUERY: ${query}`,
          { numPredict: 60, temperature: 0.5 }
        ).catch(() => query)
      )
        .split("\n")[0]
        .trim();
      const hitsAfter = recall(reformulated || query);

      // Live retrieval-config tuning. Maintain a recommended similarity
      // threshold that a future vault read can honor: poor recall → loosen,
      // saturated recall → tighten. Report every 100 queries.
      const cfgPath = path.join(argosRoot(), "state", "loops", "rag-config.json");
      let cfg: {
        threshold: number;
        queryCount: number;
        lastReportAt: string | null;
        adjustments: Array<{ at: string; from: number; to: number; reason: string }>;
      } = { threshold: 0.3, queryCount: 0, lastReportAt: null, adjustments: [] };
      try {
        cfg = { ...cfg, ...JSON.parse(await fsp.readFile(cfgPath, "utf8")) };
      } catch {
        /* first run → defaults */
      }
      const from = cfg.threshold;
      const hitRate = corpus.length > 0 ? hitsAfter / corpus.length : 0;
      if (hitsAfter === 0 && corpus.length > 0) {
        cfg.threshold = Math.max(0.05, +(cfg.threshold - 0.02).toFixed(3));
      } else if (hitRate > 0.5) {
        cfg.threshold = Math.min(0.9, +(cfg.threshold + 0.02).toFixed(3));
      }
      if (cfg.threshold !== from) {
        cfg.adjustments.push({ at: new Date().toISOString(), from, to: cfg.threshold, reason: `hitRate ${hitRate.toFixed(2)}` });
        cfg.adjustments = cfg.adjustments.slice(-50);
      }
      cfg.queryCount += 1;
      const due = cfg.queryCount % 100 === 0;
      let report: string | null = null;
      if (due) {
        report = `Ouroboros RAG report @ ${cfg.queryCount} queries: threshold ${cfg.threshold}, ${cfg.adjustments.length} recent adjustments.`;
        cfg.lastReportAt = new Date().toISOString();
      }
      try {
        await fsp.mkdir(path.dirname(cfgPath), { recursive: true });
        const tmp = `${cfgPath}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
        await fsp.rename(tmp, cfgPath);
      } catch {
        /* config persist best-effort */
      }

      return {
        loopId: "ouroboros_rag",
        loopNumber: 9,
        ok: true,
        summary: `recall ${hitsBefore} → ${hitsAfter}/${corpus.length}; threshold ${from}→${cfg.threshold}${due ? " (100-query report)" : ""}`,
        claimedImprovement: false, // reported as data; gate does not need to trust it
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: {
          query,
          reformulated,
          output: reformulated,
          hitsBefore,
          hitsAfter,
          corpusSize: corpus.length,
          improvedRecall: hitsAfter > hitsBefore,
          threshold: cfg.threshold,
          queryCount: cfg.queryCount,
          report,
        },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("ouroboros_rag", 9, (e as Error).message, start);
    }
  },
};

// --- Loop12: Skill Acquisition ----------------------------------------------
// Inspect recent accepted loop runs and name a reusable "skill" worth keeping.
// Low-risk skill proposal (operator decides whether to add it to the library).
export const skillAcquisition: LoopDefinition = {
  id: "skill_acquisition",
  loopNumber: 12,
  name: "Skill Acquisition",
  description: "Distill a reusable skill from recent successful runs.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const recent = (await readAllTraces(30)).filter(
        (t) => t.outcome === "accepted"
      );
      const digest =
        recent.length > 0
          ? recent.map((t) => `${t.loopId}: ${t.result.summary}`).join("\n").slice(0, 2000)
          : inputStr(ctx, "context", "General operator-assistant work.");
      const skill = await loopModelCall(
        personaModel("bobby"),
        "You distill a reusable SKILL from recent successful work. Output JSON: {\"name\":\"short-skill-name\",\"when\":\"when to use it\",\"steps\":[\"step1\",\"step2\"]}. JSON only.",
        `RECENT SUCCESSFUL RUNS:\n${digest}`,
        { numPredict: 300, temperature: 0.4 }
      );
      return {
        loopId: "skill_acquisition",
        loopNumber: 12,
        ok: true,
        summary: `proposed a skill from ${recent.length} accepted run(s)`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [
          {
            kind: "skill",
            description: "Add a distilled reusable skill to the library (operator applies).",
            payload: skill.trim(),
          },
        ],
        data: { skill: skill.trim(), basis: recent.length },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("skill_acquisition", 12, (e as Error).message, start);
    }
  },
};

// --- Loop16: Active Learning ------------------------------------------------
// Run the GROUND-TRUTH benchmark, find the weakest category (the most
// informative gap to close), and report it. Diagnostic — no proposal, no
// improvement claim (it measures, it does not change).
export const activeLearning: LoopDefinition = {
  id: "active_learning",
  loopNumber: 16,
  name: "Active Learning",
  description: "Find the most informative gap via the ground-truth benchmark.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const bench = await runBenchmark({ model: inputStr(ctx, "model") || undefined });
      const byCat: Record<string, { pass: number; total: number }> = {};
      for (const t of bench.perTask) {
        byCat[t.category] = byCat[t.category] ?? { pass: 0, total: 0 };
        byCat[t.category].total += 1;
        if (t.passed) byCat[t.category].pass += 1;
      }
      let weakest = "none";
      let weakestRate = 2;
      for (const [cat, c] of Object.entries(byCat)) {
        const rate = c.total > 0 ? c.pass / c.total : 1;
        if (rate < weakestRate) {
          weakestRate = rate;
          weakest = cat;
        }
      }
      const failing = bench.perTask.filter((t) => !t.passed).map((t) => t.id);
      return {
        loopId: "active_learning",
        loopNumber: 16,
        ok: true,
        summary: `benchmark ${(bench.score * 100).toFixed(0)}%; weakest "${weakest}" (${(weakestRate * 100).toFixed(0)}%)`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: bench.score, // a measurement, not an improvement claim
        evidence: failing.map((id) => ({ kind: "benchmark" as const, ref: id, note: "failing task" })),
        proposals: [],
        data: { score: bench.score, weakest, weakestRate, failing, byCategory: byCat },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("active_learning", 16, (e as Error).message, start);
    }
  },
};
