// lib/email/provider.ts
//
// Stage 3 (2026-06-09) — email READ access. Two providers behind one interface:
//   - GmailProvider   — Gmail REST API over native fetch, OAuth refresh token,
//                       gmail.readonly scope (read-only ENFORCED at the
//                       credential level — the token cannot send/delete/modify).
//   - SyntheticProvider — fixture mailbox for tests (no network). Selected when
//                       ARGOS_EMAIL_FIXTURES points to a fixtures JSON file, so
//                       the real tool + guards + route can be exercised before a
//                       live mailbox is wired. Never used in production.
//
// NO new deps — Gmail is plain REST + OAuth token endpoint via fetch.

import { promises as fsp } from "node:fs";
import { readSettings } from "../settings";
import { decryptSecret } from "../web/secrets";
import type { EmailMessageView } from "./guards";

export interface EmailListOptions {
  query?: string; // Gmail search syntax, e.g. "after:2026/06/01 in:inbox"
  max?: number;
}

export interface EmailProvider {
  /** List message metadata + snippet (no full body). */
  list(opts: EmailListOptions): Promise<EmailMessageView[]>;
  /** Read one full message (with body). */
  read(id: string): Promise<EmailMessageView | null>;
  /** Search (Gmail query) → metadata + snippet. */
  search(query: string, max?: number): Promise<EmailMessageView[]>;
}

// ---------------------------------------------------------------------------
// Synthetic (fixtures) provider
// ---------------------------------------------------------------------------

export class SyntheticProvider implements EmailProvider {
  constructor(private msgs: EmailMessageView[]) {}
  async list(opts: EmailListOptions): Promise<EmailMessageView[]> {
    const max = opts.max ?? 25;
    // Crude "after:" honoring for tests: ignored — fixtures are pre-scoped.
    return this.msgs.slice(0, max).map((m) => ({ ...m, body: undefined }));
  }
  async read(id: string): Promise<EmailMessageView | null> {
    return this.msgs.find((m) => m.id === id) ?? null;
  }
  async search(query: string, max = 25): Promise<EmailMessageView[]> {
    const q = query.toLowerCase();
    return this.msgs
      .filter((m) => `${m.from} ${m.subject} ${m.snippet ?? ""}`.toLowerCase().includes(q))
      .slice(0, max)
      .map((m) => ({ ...m, body: undefined }));
  }
}

// ---------------------------------------------------------------------------
// Gmail REST provider (native fetch, gmail.readonly)
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

class GmailProvider implements EmailProvider {
  private accessToken: string | null = null;
  private expiresAt = 0;
  constructor(private creds: GmailCreds) {}

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.creds.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`gmail token refresh failed: ${res.status}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("gmail token refresh: no access_token");
    this.accessToken = j.access_token;
    this.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async api(path: string): Promise<Record<string, unknown>> {
    const tok = await this.token();
    const res = await fetch(`${GMAIL_BASE}${path}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`gmail api ${path} → ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private static header(headers: Array<{ name: string; value: string }>, name: string): string {
    return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  }

  private static decodeBody(payload: Record<string, unknown> | undefined): string {
    if (!payload) return "";
    const body = payload.body as { data?: string } | undefined;
    if (body?.data) {
      try { return Buffer.from(body.data, "base64url").toString("utf8"); } catch { return ""; }
    }
    const parts = (payload.parts as Array<Record<string, unknown>> | undefined) ?? [];
    // Prefer text/plain.
    const plain = parts.find((p) => p.mimeType === "text/plain");
    if (plain) return GmailProvider.decodeBody(plain);
    for (const p of parts) {
      const t = GmailProvider.decodeBody(p);
      if (t) return t;
    }
    return "";
  }

  private toView(msg: Record<string, unknown>, withBody: boolean): EmailMessageView {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const headers = (payload?.headers as Array<{ name: string; value: string }>) ?? [];
    return {
      id: String(msg.id ?? ""),
      from: GmailProvider.header(headers, "From"),
      subject: GmailProvider.header(headers, "Subject"),
      date: GmailProvider.header(headers, "Date") || undefined,
      snippet: typeof msg.snippet === "string" ? msg.snippet : undefined,
      body: withBody ? GmailProvider.decodeBody(payload) : undefined,
    };
  }

  async list(opts: EmailListOptions): Promise<EmailMessageView[]> {
    const q = encodeURIComponent(opts.query ?? "in:inbox");
    const max = opts.max ?? 25;
    const listed = await this.api(`/messages?q=${q}&maxResults=${max}`);
    const ids = ((listed.messages as Array<{ id: string }>) ?? []).map((m) => m.id);
    const out: EmailMessageView[] = [];
    for (const id of ids) {
      const meta = await this.api(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      out.push(this.toView(meta, false));
    }
    return out;
  }
  async read(id: string): Promise<EmailMessageView | null> {
    const msg = await this.api(`/messages/${id}?format=full`);
    return this.toView(msg, true);
  }
  async search(query: string, max = 25): Promise<EmailMessageView[]> {
    return this.list({ query, max });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type ProviderResult =
  | { ok: true; provider: EmailProvider; mode: "gmail" | "synthetic" }
  | { ok: false; error: string };

export async function getEmailProvider(): Promise<ProviderResult> {
  // Test hook: fixtures file → synthetic provider. Never set in production.
  const fixturesPath = process.env.ARGOS_EMAIL_FIXTURES;
  if (fixturesPath) {
    try {
      const raw = await fsp.readFile(fixturesPath, "utf8");
      const msgs = JSON.parse(raw) as EmailMessageView[];
      return { ok: true, provider: new SyntheticProvider(msgs), mode: "synthetic" };
    } catch (e) {
      return { ok: false, error: `email fixtures load failed: ${(e as Error).message}` };
    }
  }
  const s = await readSettings();
  const g = s.gmail;
  if (!g || !g.refreshToken || !g.clientId || !g.clientSecret) {
    return { ok: false, error: "email not configured (no Gmail OAuth credentials)" };
  }
  const clientSecret = await decryptSecret(g.clientSecret);
  const refreshToken = await decryptSecret(g.refreshToken);
  if (!clientSecret || !refreshToken) {
    return { ok: false, error: "email credentials could not be decrypted" };
  }
  return {
    ok: true,
    provider: new GmailProvider({ clientId: g.clientId, clientSecret, refreshToken }),
    mode: "gmail",
  };
}
