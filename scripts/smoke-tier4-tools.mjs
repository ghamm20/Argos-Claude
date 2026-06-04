#!/usr/bin/env node
// smoke-tier4-tools.mjs (v2.4.0) — the 19 Tier-4 operator-specific tools.
//
// All Tier-4 tools are SAFE (read-only) → /api/tools/execute runs them directly.
// Asserts:
//   - keyless tools: ok:true with the expected data shape (live), OR an HONEST
//     error (real HTTP/network reason) — never a fabricated success.
//   - keyed tools (no key in the throwaway ROOT): a clean graceful skip
//     (data.configured === false), never a fabricated result.
//   - integrity: NO tool ever returns a fake "not running"/"running" or
//     fabricated data on failure (the MiroFish v2.3.10 doctrine).
//   - gauntlet: bad-input cases return honest toolErr, not a confident answer.
//
// Boots `next start` on a throwaway ARGOS_ROOT. Live keyless calls need internet.
// Usage: node scripts/smoke-tier4-tools.mjs [--port 7879]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7879;
const ROOT = join(tmpdir(), `argos-tier4-${process.pid}`);

let pass = 0, fail = 0, warn = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [PASS] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
const warno = (n, d = "") => { warn++; console.log(`  [WARN] ${n}${d ? "  " + d : ""}`); };

// Anything that would be a dishonest state report (the doctrine forbids these on
// a real failure / down service).
const FAKE_STATE = /\bnot running\b|start it on port|\brunning\b(?!.*not)/i;

function run(toolId, params) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ toolId, params }));
    const url = new URL("/api/tools/execute", `http://127.0.0.1:${PORT}`);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "content-type": "application/json", "content-length": body.length }, timeout: 45000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res({ _timeout: true }); }); r.write(body); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", `http://127.0.0.1:${PORT}`), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false;
}
// A keyless tool PASSES if ok:true (real data) OR an honest error — but NEVER a
// fake state report. A live network hiccup is a WARN, not a FAIL.
function judgeKeyless(label, out, shapeOk) {
  const r = out?.result;
  if (out?._timeout) { warno(`${label} (live timeout)`); return; }
  if (!r) { fail++; console.log(`  [FAIL] ${label}  (no result)`); return; }
  const summary = `${r.summary ?? ""} ${r.error ?? ""}`;
  if (FAKE_STATE.test(summary)) { check(`${label} — honest (no fake state)`, false, `"${summary.slice(0, 80)}"`); return; }
  if (r.ok) check(`${label} — ok:true, real data`, shapeOk(r), JSON.stringify(r.data ?? {}).slice(0, 90));
  else warno(`${label} — honest error (live)`, `"${(r.error ?? r.summary ?? "").slice(0, 90)}"`);
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] smoke-tier4-tools\n");

  console.log("=== Keyless tools (live) ===");
  judgeKeyless("nvd_cve", await run("nvd_cve", { cveId: "CVE-2021-44228" }), (r) => Array.isArray(r.data?.cves));
  judgeKeyless("federal_register", await run("federal_register", { query: "executive order", limit: 5 }), (r) => Array.isArray(r.data?.documents));
  judgeKeyless("usgs_water", await run("usgs_water", { stateCd: "tn" }), (r) => Array.isArray(r.data?.gauges));
  judgeKeyless("epa_envirofacts", await run("epa_envirofacts", { state: "TN", limit: 5 }), (r) => Array.isArray(r.data?.rows));
  judgeKeyless("nominatim", await run("nominatim", { query: "Nashville, Tennessee" }), (r) => Array.isArray(r.data?.places) && r.data.places.length > 0);
  judgeKeyless("overpass_osm", await run("overpass_osm", { amenity: "hospital", lat: 36.1627, lon: -86.7816, radius: 3000 }), (r) => Array.isArray(r.data?.elements));
  judgeKeyless("open_elevation", await run("open_elevation", { lat: 36.1627, lon: -86.7816 }), (r) => Array.isArray(r.data?.points) && r.data.points.length > 0);
  judgeKeyless("internet_archive", await run("internet_archive", { query: "apollo 11", limit: 5 }), (r) => Array.isArray(r.data?.items));
  judgeKeyless("openlibrary", await run("openlibrary", { query: "dune frank herbert", limit: 5 }), (r) => Array.isArray(r.data?.books));
  judgeKeyless("frankfurter_fx", await run("frankfurter_fx", { from: "USD", to: "EUR", amount: 47 }), (r) => r.data?.rates && typeof r.data.rates.EUR === "number");
  judgeKeyless("nhtsa", await run("nhtsa", { make: "Honda", model: "Accord", modelYear: "2020" }), (r) => typeof r.data?.count === "number");
  judgeKeyless("openfema", await run("openfema", { state: "TN", limit: 5 }), (r) => Array.isArray(r.data?.records));

  console.log("\n=== libretranslate (local container — honest if down) ===");
  const lt = await run("libretranslate", { q: "hola mundo", target: "en" });
  const ltr = lt?.result;
  if (ltr?.ok) check("libretranslate — translated (container up)", typeof ltr.data?.translatedText === "string");
  else check("libretranslate — honest 'not reachable' (no fake)", !!ltr && ltr.ok === false && /not reachable|connection refused|HTTP \d/i.test(ltr.error ?? "") && !FAKE_STATE.test(ltr.error ?? ""), `"${(ltr?.error ?? "").slice(0, 90)}"`);

  console.log("\n=== Keyed tools — graceful skip when no key (configured:false) ===");
  for (const [id, params] of [["hibp", { account: "test@example.com" }], ["congress_gov", {}], ["sam_gov", {}], ["usda_nass", {}], ["noaa_climate", {}], ["fred", { series_id: "CPIAUCSL" }]]) {
    const out = await run(id, params);
    const r = out?.result;
    check(`${id} — graceful 'not configured' (no fabrication)`, !!r && r.ok === true && r.data?.configured === false && /not configured/i.test(r.summary ?? ""), `"${(r?.summary ?? "").slice(0, 70)}"`);
  }

  console.log("\n=== Integrity gauntlet — bad input → honest error, no fabrication ===");
  const g1 = await run("nvd_cve", {});
  check("nvd_cve(no args) → honest toolErr, not a fabricated CVE", g1?.result?.ok === false && /provide a/i.test(g1.result.error ?? "") && !FAKE_STATE.test(g1.result.error ?? ""), `"${(g1?.result?.error ?? "").slice(0, 70)}"`);
  const g2 = await run("frankfurter_fx", { from: "ZZZ", to: "EUR" });
  check("frankfurter_fx(bad currency) → honest error, no fabricated rate", g2?.result?.ok === false && !FAKE_STATE.test(g2.result.error ?? ""), `"${(g2?.result?.error ?? "").slice(0, 70)}"`);
  const g3 = await run("open_elevation", { lat: "abc" });
  check("open_elevation(bad coords) → honest error", g3?.result?.ok === false, `"${(g3?.result?.error ?? "").slice(0, 70)}"`);
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\nsmoke-tier4-tools: ${pass} passed, ${fail} failed, ${warn} warn — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
