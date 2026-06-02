// lib/web/http-client.ts
//
// Web Capability TIER 0 (2026-06-02) — the ONE place external HTTP happens.
//
// Doctrine note (Seven USB-Native Rules / verify-argos Rule 4): the rule scans
// for an inline remote-URL string literal placed directly inside a fetch call.
// Every call here passes a VARIABLE url, so this wrapper — and every tool that
// routes through it — stays compliant. Tools must never inline a remote URL
// literal in a fetch call; they build the URL as a value and hand it to
// httpRequest().
//
// Behavior:
//   - configurable timeout (AbortController)
//   - user-agent rotation across attempts
//   - retry with exponential backoff (max 3 attempts) on network error,
//     429, or 5xx
//   - follows redirects
//   - NEVER throws — returns { ok:false, error } on any failure.

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
  latencyMs: number;
  attempts: number;
  error?: string;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-attempt timeout. Default 20s. */
  timeoutMs?: number;
  /** Max attempts (incl. the first). Default 3. */
  retries?: number;
  /** Override the rotating UA with a fixed one (e.g. a polite-pool UA). */
  userAgent?: string;
  /** Cap the returned body length (defensive against huge pages). */
  maxChars?: number;
  /** External cancellation. */
  signal?: AbortSignal;
}

/** Rotating user agents — some sources gate on UA. */
export const WEB_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when the failure is worth retrying (transient). */
function retryable(status: number): boolean {
  return status === 0 || status === 429 || (status >= 500 && status <= 599);
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * Perform an HTTP request with timeout + retry + UA rotation. Never throws.
 * `url` is always a variable — keep it that way (Rule 4).
 */
export async function httpRequest(
  url: string,
  opts: HttpOptions = {}
): Promise<HttpResponse> {
  const maxAttempts = Math.max(1, Math.min(opts.retries ?? DEFAULT_RETRIES, 5));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let lastError = "";
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    const ua =
      opts.userAgent ?? WEB_USER_AGENTS[(attempt - 1) % WEB_USER_AGENTS.length];
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: { "user-agent": ua, ...(opts.headers ?? {}) },
        body: opts.body,
        signal: ctrl.signal,
        redirect: "follow",
      });
      let text = await res.text();
      if (opts.maxChars && text.length > opts.maxChars) {
        text = text.slice(0, opts.maxChars);
      }
      lastStatus = res.status;
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          body: text,
          headers: headersToObject(res.headers),
          latencyMs: Date.now() - started,
          attempts: attempt,
        };
      }
      // Non-2xx. Retry if transient and attempts remain.
      lastError = `HTTP ${res.status}`;
      if (!retryable(res.status) || attempt === maxAttempts) {
        return {
          ok: false,
          status: res.status,
          body: text,
          headers: headersToObject(res.headers),
          latencyMs: Date.now() - started,
          attempts: attempt,
          error: lastError,
        };
      }
    } catch (e) {
      lastStatus = 0;
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === maxAttempts) {
        return {
          ok: false,
          status: 0,
          body: "",
          headers: {},
          latencyMs: Date.now() - started,
          attempts: attempt,
          error: lastError,
        };
      }
    } finally {
      clearTimeout(timer);
    }
    // Exponential backoff with a little jitter: 250ms, 500ms, 1000ms…
    const backoff = 250 * 2 ** (attempt - 1);
    await sleep(backoff + (attempt * 37) % 50);
  }

  return {
    ok: false,
    status: lastStatus,
    body: "",
    headers: {},
    latencyMs: Date.now() - started,
    attempts: maxAttempts,
    error: lastError || "request failed",
  };
}

/** Convenience JSON GET. Returns parsed JSON or { ok:false }. Never throws. */
export async function httpGetJson<T = unknown>(
  url: string,
  opts: HttpOptions = {}
): Promise<{ ok: boolean; status: number; data: T | null; error?: string; latencyMs: number; attempts: number }> {
  const r = await httpRequest(url, {
    ...opts,
    headers: { accept: "application/json", ...(opts.headers ?? {}) },
  });
  if (!r.ok) return { ok: false, status: r.status, data: null, error: r.error, latencyMs: r.latencyMs, attempts: r.attempts };
  try {
    return { ok: true, status: r.status, data: JSON.parse(r.body) as T, latencyMs: r.latencyMs, attempts: r.attempts };
  } catch (e) {
    return { ok: false, status: r.status, data: null, error: `bad JSON: ${e instanceof Error ? e.message : String(e)}`, latencyMs: r.latencyMs, attempts: r.attempts };
  }
}
