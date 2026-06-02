// lib/tools/github.ts — T29 github_search (web, safe)
//
// GitHub REST API. Uses the operator's PAT (from settings, decrypted) when
// present — 5000 req/hr vs 60 keyless. Graceful without a token.
//   modes: repositories | code | issues | readme | repo_issues
// 30min cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson, getApiKey } from "../web";

export const ID = "github_search";
const TTL = 30 * 60 * 1000;
const API = "https://api.github.com";

async function ghHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const token = await getApiKey("github");
  if (token) h["authorization"] = `Bearer ${token}`;
  return h;
}

interface RepoItem {
  full_name?: string;
  html_url?: string;
  description?: string;
  stargazers_count?: number;
  language?: string;
  topics?: string[];
  updated_at?: string;
}
interface CodeItem {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: { full_name?: string };
}
interface IssueItem {
  title?: string;
  html_url?: string;
  state?: string;
  number?: number;
  comments?: number;
  repository_url?: string;
}

export const execute: ToolExecute = async (params) => {
  const mode = String(params.mode ?? "repositories");
  const q = String(params.query ?? "").trim();
  const owner = String(params.owner ?? "").trim();
  const repo = String(params.repo ?? "").trim();
  const headers = await ghHeaders();
  const authed = "authorization" in headers;

  if (mode === "readme" || mode === "repo_issues") {
    if (!owner || !repo) return toolErr(ID, `${mode} requires owner and repo`);
    if (mode === "readme") {
      const url = `${API}/repos/${owner}/${repo}/readme`;
      const r = await webFetchJson<{ content?: string; encoding?: string; html_url?: string }>({
        source: "github", op: "readme", url, query: `${owner}/${repo}`, ttlMs: TTL, headers,
      });
      if (!r.ok || !r.data?.content) return toolErr(ID, r.error ?? "readme not found");
      const decoded = r.data.encoding === "base64" ? Buffer.from(r.data.content, "base64").toString("utf8") : r.data.content;
      return toolOk(ID, `GitHub README: ${owner}/${repo}`, {
        data: { repo: `${owner}/${repo}`, readme: decoded.slice(0, 12000), url: r.data.html_url ?? null, authed, fromCache: r.fromCache },
        sources: [r.data.html_url ?? `https://github.com/${owner}/${repo}`],
      });
    }
    const url = `${API}/repos/${owner}/${repo}/issues?state=open&per_page=15`;
    const r = await webFetchJson<IssueItem[]>({ source: "github", op: "repo_issues", url, query: `${owner}/${repo}`, ttlMs: TTL, headers });
    if (!r.ok) return toolErr(ID, r.error ?? "issues fetch failed");
    const issues = (r.data ?? []).slice(0, 15).map((i) => ({ title: i.title ?? "", url: i.html_url ?? "", number: i.number ?? null, state: i.state ?? null, comments: i.comments ?? 0 }));
    return toolOk(ID, `GitHub issues: ${issues.length} open in ${owner}/${repo}`, { data: { repo: `${owner}/${repo}`, issues, authed, fromCache: r.fromCache }, sources: issues.map((i) => i.url).slice(0, 10) });
  }

  if (!q) return toolErr(ID, "query is required");
  const endpoint = mode === "code" ? "code" : mode === "issues" ? "issues" : "repositories";
  const sortParam = endpoint === "repositories" ? "&sort=stars&order=desc" : "";
  const url = `${API}/search/${endpoint}?q=${encodeURIComponent(q)}&per_page=15${sortParam}`;
  const r = await webFetchJson<{ total_count?: number; items?: unknown[] }>({ source: "github", op: `search_${endpoint}`, url, query: q, ttlMs: TTL, headers });
  if (!r.ok) return toolErr(ID, r.error ?? `GitHub ${endpoint} search failed`);

  let results: unknown[];
  if (endpoint === "repositories") {
    results = (r.data?.items as RepoItem[] ?? []).map((it) => ({
      name: it.full_name ?? "", url: it.html_url ?? "", description: it.description ?? "", stars: it.stargazers_count ?? 0,
      language: it.language ?? null, topics: (it.topics ?? []).slice(0, 6), updated: it.updated_at ?? null,
    }));
  } else if (endpoint === "code") {
    results = (r.data?.items as CodeItem[] ?? []).map((it) => ({ name: it.name ?? "", path: it.path ?? "", url: it.html_url ?? "", repo: it.repository?.full_name ?? "" }));
  } else {
    results = (r.data?.items as IssueItem[] ?? []).map((it) => ({ title: it.title ?? "", url: it.html_url ?? "", state: it.state ?? null, number: it.number ?? null, comments: it.comments ?? 0 }));
  }
  const urls = (results as Array<{ url?: string }>).map((x) => x.url ?? "").filter(Boolean).slice(0, 10);
  return toolOk(ID, `GitHub ${endpoint}: ${results.length} result(s)${authed ? "" : " (keyless 60/hr)"}`, {
    data: { mode: endpoint, query: q, total: r.data?.total_count ?? results.length, results, authed, fromCache: r.fromCache },
    sources: urls,
  });
};
