#!/usr/bin/env node
// smoke-chat-render.mjs — chat UI cleanup gate (2026-06-02).
//
// Verifies the three operator-reported fixes through real endpoints:
//   TASK 1 — <tool>{json}</tool> control tags stripped from visible output
//            (complete, unclosed/streaming, and orphan fragments).
//   TASK 2 — internal reasoning split into a panel: <think> blocks AND
//            labeled prose ("Self-Correction:", "Internal Monologue:").
//   TASK 3 — /api/runtime reports the build-baked version (== package.json),
//            proving the HUD BUILD label is no longer stale.
//
// Usage: node scripts/smoke-chat-render.mjs [--port 7847]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7847;
const PKG = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function req(base, path, opts = {}) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const r = http.request(
      { method: opts.method || "GET", hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: body ? { "content-type": "application/json", "content-length": body.length } : {}, timeout: 15000 },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
          res({ status: resp.statusCode, json });
        });
      }
    );
    r.on("error", () => res({ status: 0 }));
    r.on("timeout", () => r.destroy());
    if (body) r.write(body);
    r.end();
  });
}

// POST text → { stripped, answer, reasoning }
const render = (base, text) => req(base, "/api/chat-render", { method: "POST", body: { text } });

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req(base, "/api/runtime");
    if (r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(fn) {
  console.log(`\n[boot] chat-render — next start :${PORT}`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready");
    await fn(base);
  } finally {
    try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  }
}

try {
  await withServer(async (base) => {
    console.log("\n=== TASK 1: strip <tool> tags ===");
    const c1 = (await render(base, 'Here is the weather. <tool>{"id":"web_search","params":{"query":"x"}}</tool> Done.')).json;
    check("complete tag removed", !/<tool>/i.test(c1?.answer ?? "") && !/web_search/.test(c1?.answer ?? ""), c1?.answer);
    check("prose around tag preserved", /Here is the weather\./.test(c1?.answer ?? "") && /Done\./.test(c1?.answer ?? ""));

    // The operator's actual leak: an unclosed tag (the '>{"id":...' fragment).
    const c2 = (await render(base, 'Answer text <tool>{"id":"web_search","params":{')).json;
    check("unclosed tag stripped to end", c2?.answer === "Answer text", JSON.stringify(c2?.answer));

    const c3 = (await render(base, "Result here</tool>")).json;
    check("orphan close tag removed", c3?.answer === "Result here", JSON.stringify(c3?.answer));

    console.log("\n=== BUG 2 (v2.3.3): wrapper-less tool-call JSON leak ===");
    // The exact v2.3.2 pilot leak — a '>' prefix, NO <tool> wrapper, full blob.
    const b1 = (await render(base, 'Let me look that up. >{"id":"chain_search_to_read","params":{"query":"CEO of Levi Strauss"}} ')).json;
    check("'>{json}' leak stripped", !/chain_search_to_read/.test(b1?.answer ?? "") && !/"id"/.test(b1?.answer ?? ""), JSON.stringify(b1?.answer));
    check("prose before leak preserved", /Let me look that up\./.test(b1?.answer ?? ""), JSON.stringify(b1?.answer));

    // Bare blob, no prefix at all.
    const b2 = (await render(base, '{"id":"web_search","params":{"query":"x"}}')).json;
    check("bare tool-call JSON stripped", (b2?.answer ?? "") === "", JSON.stringify(b2?.answer));

    // Blob with a trailing </tool> but no opening tag.
    const b3 = (await render(base, 'Done {"id":"open_meteo_weather","params":{"location":"Orlando"}}</tool>')).json;
    check("blob + orphan close stripped", b3?.answer === "Done", JSON.stringify(b3?.answer));

    // A normal JSON object the operator might legitimately discuss must survive
    // (no "id"+"params" tool-call shape → not a control blob).
    const b4 = (await render(base, 'The config is {"name":"argos","port":7842}.')).json;
    check("legit JSON object untouched", /\{"name":"argos","port":7842\}/.test(b4?.answer ?? ""), JSON.stringify(b4?.answer));

    console.log("\n=== TASK 2: reasoning panel ===");
    const r1 = (await render(base, "<think>I should check the weather first.</think>The temp is 75F.")).json;
    check("<think> answer is clean", r1?.answer === "The temp is 75F.", JSON.stringify(r1?.answer));
    check("<think> reasoning extracted", /check the weather first/.test(r1?.reasoning ?? ""), r1?.reasoning);

    const r2 = (await render(base, "Self-Correction/Internal Monologue: The user asked for weather. I have access to historical data.\n\nThe forecast is sunny.")).json;
    check("labeled monologue removed from answer", r2?.answer === "The forecast is sunny.", JSON.stringify(r2?.answer));
    check("labeled monologue in reasoning", /historical data/.test(r2?.reasoning ?? ""), r2?.reasoning);

    const r3 = (await render(base, "Internal Monologue: thinking about it.\n\nThe answer is 42.")).json;
    check("Internal Monologue label caught", r3?.answer === "The answer is 42." && /thinking about it/.test(r3?.reasoning ?? ""));

    const r4 = (await render(base, "Winter Springs is 82F right now.")).json;
    check("clean answer untouched", r4?.answer === "Winter Springs is 82F right now." && r4?.reasoning === null);

    // "Analysis:" is Sage's legitimate answer section — must NOT be eaten.
    const r5 = (await render(base, "Analysis: the data shows a clear upward trend.")).json;
    check("Analysis header NOT treated as reasoning", /upward trend/.test(r5?.answer ?? "") && r5?.reasoning === null, r5?.answer);

    // Whole-message reasoning → promoted inline, never blank, no raw tags.
    const r6 = (await render(base, "<think>only thinking</think>")).json;
    check("all-reasoning promoted inline (no blank, no tags)", r6?.answer === "only thinking" && r6?.reasoning === null, JSON.stringify(r6?.answer));

    // Combined: tool tag + think + answer.
    const r7 = (await render(base, '<think>plan it</think><tool>{"id":"web_search","params":{}}</tool>Final answer.')).json;
    check("combined tool+think → clean answer", r7?.answer === "Final answer." && /plan it/.test(r7?.reasoning ?? ""), JSON.stringify(r7?.answer));

    console.log("\n=== TASK 3: build-baked version ===");
    const rt = (await req(base, "/api/runtime")).json;
    check("runtime version == package.json", rt?.version === PKG.version, `runtime=${rt?.version} pkg=${PKG.version}`);
    check("version is valid semver", /^\d+\.\d+\.\d+$/.test(rt?.version ?? ""), rt?.version);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
}

console.log(`\nsmoke-chat-render: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
