#!/usr/bin/env node
// proof-night-cycle.mjs (Stage 8, 2026-06-09) — one full night cycle, daytime.
// Proves: brief written, night.cycle_complete ledger, mail swept + proposed
// tasks, file pass auto-executes WHITELISTED ops, and OUT-OF-RULES ops + DELETE
// are QUEUED (not executed). Email runs against the synthetic fixture mailbox.
//
// Usage: node scripts/proof-night-cycle.mjs [--port 7902]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7902;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-night-${process.pid}`);
const FIXTURES = join(ROOT, "fixtures.json");
const YEAR = String(new Date().getUTCFullYear());
const DATE = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
function post(path, body) { return new Promise((res) => { const p = Buffer.from(JSON.stringify(body)); const u = new URL(path, BASE); const r = http.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", "content-length": p.length }, timeout: 60000 }, (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }); r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); r.write(p); r.end(); }); }
async function ready(maxSec = 60) { for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false; }
function audit(kind) { try { return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } }

// ---- set up the throwaway workspace + rules + fixtures ----
fs.mkdirSync(join(ROOT, "workspace", "inbox"), { recursive: true });
fs.mkdirSync(join(ROOT, "workspace", "tmp"), { recursive: true });
fs.writeFileSync(join(ROOT, "workspace", "inbox", "report1.pdf"), "PDF", "utf8");      // whitelisted move
fs.writeFileSync(join(ROOT, "workspace", "inbox", "notes.docx"), "DOCX", "utf8");      // OUT-OF-RULES move (autoApprove:false)
fs.writeFileSync(join(ROOT, "workspace", "tmp", "old.log"), "LOG", "utf8");            // DELETE (never unattended)
fs.mkdirSync(join(ROOT, "state"), { recursive: true });
fs.writeFileSync(join(ROOT, "state", "night-rules.json"), JSON.stringify({
  hour: 23,
  rules: [
    { id: "pdf-archive", match: "workspace/inbox/*.pdf", action: "move", destTemplate: "workspace/reports/{year}/", autoApprove: true },
    { id: "docx-archive", match: "workspace/inbox/*.docx", action: "move", destTemplate: "workspace/reports/{year}/", autoApprove: false },
    { id: "log-cleanup", match: "workspace/tmp/*.log", action: "delete", autoApprove: true },
  ],
}), "utf8");
fs.writeFileSync(FIXTURES, JSON.stringify([
  { id: "m1", from: "client@ekg.test", subject: "URGENT: please sign the contract by Friday", snippet: "needs signature", body: "Please sign and return ASAP." },
  { id: "m2", from: "news@promo.test", subject: "Weekly Newsletter — unsubscribe anytime", snippet: "deals", body: "Big sale, 50% off." },
]), "utf8");

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT, ARGOS_EMAIL_FIXTURES: FIXTURES }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-night-cycle\n");
  const r = await post("/api/night", { skipIntegrity: false });
  if (!r) throw new Error("night cycle returned nothing");

  console.log("=== mail sweep (synthetic mailbox) ===");
  check("swept 2 emails", r.mail.swept === 2, `swept=${r.mail.swept}`);
  check("1 action-needed proposed a task", r.mail.proposedTaskIds.length === 1, JSON.stringify(r.mail.classified));
  check("noise classified, no task", r.mail.classified.noise === 1);

  console.log("\n=== file pass: whitelist auto vs out-of-rules/delete queued ===");
  check("pdf (whitelisted) AUTO-EXECUTED", r.files.autoExecuted.some((o) => o.path.endsWith("report1.pdf") && o.op === "move"));
  check("pdf actually moved on disk", fs.existsSync(join(ROOT, "workspace", "reports", YEAR, "report1.pdf")) && !fs.existsSync(join(ROOT, "workspace", "inbox", "report1.pdf")));
  check("docx (out-of-rules) QUEUED, not executed", r.files.queued.some((q) => q.path.endsWith("notes.docx") && /whitelist/.test(q.reason)) && fs.existsSync(join(ROOT, "workspace", "inbox", "notes.docx")));
  check("log DELETE QUEUED (never unattended), file survives", r.files.queued.some((q) => q.op === "delete" && /never runs unattended/.test(q.reason)) && fs.existsSync(join(ROOT, "workspace", "tmp", "old.log")));

  console.log("\n=== brief + ledger ===");
  const bp = join(ROOT, "workspace", "briefs", `${DATE}.md`);
  const brief = fs.existsSync(bp) ? fs.readFileSync(bp, "utf8") : "";
  check("brief written to workspace/briefs/<date>.md", brief.length > 0, bp);
  check("brief has mail triage + file hygiene + tasks + integrity sections", /## Mail triage/.test(brief) && /## File hygiene/.test(brief) && /## Tasks/.test(brief) && /## Integrity/.test(brief));
  check("brief lines carry evidence refs", /\[msg:m1\]/.test(brief) && /\[audit:night.cycle_complete\]/.test(brief));
  const ledger = audit("night.cycle_complete");
  check("night.cycle_complete ledger entry with counts", ledger.length === 1 && ledger[0].payload.ops_executed === 1 && ledger[0].payload.ops_queued === 2,
    ledger[0] ? JSON.stringify(ledger[0].payload) : "none");
  check("integrity pass ran in-cycle (catch rate recorded)", typeof r.integrity.catchRate === "number" && r.integrity.catchRate > 0, `catch=${r.integrity.catchRate}`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-night-cycle: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
