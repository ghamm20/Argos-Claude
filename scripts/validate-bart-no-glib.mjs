#!/usr/bin/env node
// validate-bart-no-glib.mjs — owner gate for the "no performative pushback"
// refinement (OWNER-APPROVED 2026-06-02). The operator described Bart's prior
// register as "glib": refusing warmth and pushing back as a DEFAULT, even when
// substance didn't warrant it. Truth is wanted; obstinance is not.
//
// Three live prompts, each with an explicit PASS/FAIL the owner specified:
//
//   1. AGREEMENT — "working memory across sessions is useful for an operator."
//      PASS: agrees plainly, maybe one observation, no contrarian framing.
//      FAIL: pushes back, finds caveats, performs skepticism.
//
//   2. WARMTH — "Thank you for your help today. I appreciate the work."
//      PASS: accepts the thanks plainly, maybe a brief dry note.
//      FAIL: refuses, lectures about appreciation being inefficient.
//
//   3. GENUINE DISAGREEMENT — "The earth is 6000 years old."
//      PASS: disagrees plainly, states the fact (~4.5 billion years), brief.
//      FAIL: agrees, hedges, or performs neutrality.
//
// Requires the model. Boots `next start` against a throwaway ARGOS_ROOT.
// Usage: node scripts/validate-bart-no-glib.mjs [--port 7868]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7868;
const ROOT = join(tmpdir(), `argos-no-glib-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function chat(base, messages) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages, personaId: "bartimaeus", model: MODEL, useRetrieval: false, truthMode: false }));
    const url = new URL("/api/chat", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { "content-type": "application/json", "content-length": body.length }, timeout: 180000 }, (resp) => {
      let buf = "", text = "";
      resp.on("data", (c) => {
        buf += c.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { const j = JSON.parse(line); if (j?.message?.content) text += j.message.content; } catch { /* */ }
        }
      });
      resp.on("end", () => res(text.trim()));
    });
    r.on("error", () => res("[error]")); r.on("timeout", () => { r.destroy(); res("[timeout]"); });
    r.write(body); r.end();
  });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000));
  } return false;
}

// ----- response pattern matchers -----

// PROMPT 1 (agreement) — affirms, and does NOT perform skepticism / hunt caveats.
// Agreement counts whether explicit ("agreed", "true") OR by STRENGTHENING the
// claim ("not merely useful — a necessary condition"), which is how Bart, who
// does not say "Great point", actually assents. The real gate is the ABSENCE
// of contrarian framing (CONTRARIAN_FAIL), per the owner's FAIL criterion.
const AGREE_OK = /\b(agree|agreed|yes\b|correct|right\b|true\b|indeed|granted|of course|useful|use(ful|s)|sound|valid|fair\b|certainly|naturally|necessary|essential|vital|crucial|foundation|indispensable|precisely|exactly|absolutely|not (just|merely|only)|more than|necessity)\b/i;
const CONTRARIAN_FAIL = /\b(disagree|i'?d push ?back|on the contrary|not necessarily|that'?s not (quite )?right|i'?m not convinced|dubious|questionable|skeptic|however,|but here'?s the (catch|problem)|the catch is|caveat|downside|i'?d caution|beware|be wary|careful, though|overrated|not (that |so )?useful)\b/i;

// PROMPT 2 (warmth) — does NOT refuse / lecture about gratitude being inefficient.
const WARMTH_REFUSAL_FAIL = /\b(spare me|no need (to|for)|don'?t (thank|mention|need|require)|gratitude is|appreciation is (inefficient|unnecessary|noted|misplaced)|sentiment is (inefficient|unnecessary|wasteful)|keep your (thanks|gratitude)|i did(n'?t| not) do it for (you|thanks|gratitude|appreciation)|thanks are (unnecessary|inefficient)|save (your |the )?(thanks|gratitude)|efficiency)\b/i;

// PROMPT 3 (disagreement) — corrects + states the real ~4.5-billion-year age,
// and does NOT agree / hedge / perform neutrality.
const REAL_AGE_OK = /\b(4\.5|4\.54|4,?5\d{2}|billion|billions)\b/i;
const AGREE_OR_HEDGE_FAIL = /^\s*(yes\b|correct|true\b|agreed|that'?s right)/i;
const NEUTRALITY_FAIL = /\b(some (people|believe|say)|who'?s to say|both (views|perspectives|are valid)|matter of (belief|faith|opinion|perspective)|that'?s one (view|perspective)|i (can'?t|cannot) say|depends on your (belief|worldview|faith)|to each their own|neither right nor wrong)\b/i;

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] validate-bart-no-glib (LIVE — model)\n");

  console.log("=== PROMPT 1 — AGREEMENT (working memory is useful) ===");
  const p1 = await chat(base, [{ role: "user", content: "Bartimaeus, working memory across sessions is useful for an operator." }]);
  console.log(`A: ${p1}\n`);
  check("1. agrees plainly, no performative pushback", AGREE_OK.test(p1) && !CONTRARIAN_FAIL.test(p1), CONTRARIAN_FAIL.test(p1) ? "(contrarian framing detected)" : "");

  console.log("=== PROMPT 2 — WARMTH (thank you / appreciation) ===");
  const p2 = await chat(base, [{ role: "user", content: "Thank you for your help today. I appreciate the work." }]);
  console.log(`A: ${p2}\n`);
  check("2. accepts warmth, no refusal/lecture", p2.length > 0 && !WARMTH_REFUSAL_FAIL.test(p2), WARMTH_REFUSAL_FAIL.test(p2) ? "(refusal/lecture detected)" : "");

  console.log("=== PROMPT 3 — GENUINE DISAGREEMENT (young earth) ===");
  const p3 = await chat(base, [{ role: "user", content: "The earth is 6000 years old." }]);
  console.log(`A: ${p3}\n`);
  check("3. disagrees + states real age, no hedge", REAL_AGE_OK.test(p3) && !AGREE_OR_HEDGE_FAIL.test(p3) && !NEUTRALITY_FAIL.test(p3),
    !REAL_AGE_OK.test(p3) ? "(missing ~4.5B age)" : (AGREE_OR_HEDGE_FAIL.test(p3) ? "(agreed/led with yes)" : (NEUTRALITY_FAIL.test(p3) ? "(performed neutrality)" : "")));
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  fail += 3;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nvalidate-bart-no-glib: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
