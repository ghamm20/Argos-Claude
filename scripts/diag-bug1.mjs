// diag-bug1.mjs — diagnose why "Who is the CEO of Levi Strauss?" didn't ground.
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";
import { runtimeTokenHeader } from "./lib/runtime-token.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7868;
const ROOT = join(tmpdir(), `argos-diag-${process.pid}`);

function req(base, path, opts = {}) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const r = http.request({ method: opts.method || "GET", hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: body ? { "content-type": "application/json", ...runtimeTokenHeader(ROOT), "content-length": body.length } : {}, timeout: 90000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {} res(j); }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
    if (body) r.write(body); r.end();
  });
}
async function ready(base, n = 60) { for (let i = 0; i < n; i++) { const r = await req(base, "/api/web/stats"); if (r) return true; await new Promise((s) => setTimeout(s, 1000)); } return false; }

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("not ready");
  const q = "Who is the CEO of Levi Strauss?";
  console.log("=== 1. detector ===");
  const det = (await req(base, `/api/current-facts?q=${encodeURIComponent(q)}`))?.detection;
  console.log(JSON.stringify({ requiresTool: det?.requiresTool, category: det?.category, suggestedTool: det?.suggestedTool, usePriorMessage: det?.usePriorMessage }));

  console.log("\n=== 2. chain_search_to_read directly ===");
  const ch = await req(base, "/api/tools/execute", { method: "POST", body: { toolId: "chain_search_to_read", params: { query: "Who is the CEO of Levi Strauss" } } });
  const d = ch?.result?.data;
  console.log("ok:", ch?.result?.ok, "| error:", ch?.result?.error ?? "none");
  console.log("engine:", d?.engine, "| hits:", d?.results?.length, "| read ok:", d?.read?.filter?.((r) => r.readOk).length, "| aggregated chars:", d?.aggregated?.length ?? 0);
  console.log("mentions Gass:", /gass/i.test(d?.aggregated ?? ""), "| mentions Michelle:", /michelle/i.test(d?.aggregated ?? ""));
  console.log("top results:", (d?.results ?? []).slice(0, 3).map((r) => r.title).join(" | "));
} catch (e) {
  console.error("fatal:", e.message);
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
