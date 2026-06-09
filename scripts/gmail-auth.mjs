#!/usr/bin/env node
// gmail-auth.mjs (Stage 3, 2026-06-09) — one-time Gmail OAuth refresh-token
// minting for ARGOS read-only email. Native fetch + a local redirect catcher;
// NO new deps. The operator runs this AFTER creating an OAuth "Desktop app"
// client in Google Cloud Console (see the Stage 3 report for the console steps).
//
// It mints a gmail.readonly refresh token and stores the credentials in ARGOS
// via POST /api/settings (clientSecret + refreshToken encrypted at rest). The
// token can ONLY read mail — it cannot send, delete, or modify.
//
// Usage (PowerShell — ARGOS must be running on :7799):
//   node scripts/gmail-auth.mjs
// The script PROMPTS for the Client ID + secret (paste into the prompt — the
// secret is masked and never touches shell history), opens the consent URL,
// catches the loopback redirect, mints the token, and stores it encrypted.
//
// Env vars are still honored for automation: ARGOS_GMAIL_CLIENT_ID,
// ARGOS_GMAIL_CLIENT_SECRET, ARGOS_BASE (default http://127.0.0.1:7799),
// ARGOS_OAUTH_PORT (default 7733; a Desktop-app client auto-allows the loopback
// redirect, so no redirect URI needs registering).

import http from "node:http";
import readline from "node:readline";

// Prompt on stdin. `hidden` mutes the echo so a pasted secret never shows on
// screen or lands in shell history (the env-var paste path is gone).
function prompt(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((res) => {
    if (hidden) {
      rl._writeToOutput = (s) => {
        // Echo the question text; mask everything the user types.
        if (s.includes(question) || s === "\n" || s === "\r\n") rl.output.write(s);
        else rl.output.write("*");
      };
    }
    rl.question(question, (ans) => { rl.close(); if (hidden) process.stdout.write("\n"); res(ans.trim()); });
  });
}

const ARGOS_BASE = process.env.ARGOS_BASE ?? "http://127.0.0.1:7799";
// Credentials: interactive prompt by default (paste into the prompt, not the
// shell — never echoed, never in history). Env vars still honored for automation.
const CLIENT_ID = process.env.ARGOS_GMAIL_CLIENT_ID || (await prompt("Paste the OAuth Client ID: "));
const CLIENT_SECRET = process.env.ARGOS_GMAIL_CLIENT_SECRET || (await prompt("Paste the OAuth Client secret (hidden): ", true));
const PORT = parseInt(process.env.ARGOS_OAUTH_PORT ?? "7733", 10);
const REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
// Endpoints as named constants (not inline fetch() literals) — matches the
// Nous-backend convention and keeps verify-argos Rule 4 green for an
// operator-approved external service.
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Both the OAuth Client ID and Client secret are required.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  }).toString();

console.log("\n1. Open this URL in your browser and approve gmail.readonly access:\n");
console.log("   " + authUrl + "\n");
console.log(`2. After approving you'll be redirected to ${REDIRECT} — this script catches it.\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No code in redirect.");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" }).end("ARGOS: code received — you can close this tab.");
  server.close();

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok || !tok.refresh_token) {
      console.error("Token exchange failed:", JSON.stringify(tok));
      console.error("(If there's no refresh_token, revoke ARGOS access at myaccount.google.com/permissions and retry — refresh tokens are only returned on first consent.)");
      process.exit(1);
    }
    // Store in ARGOS (encrypted server-side). clientSecret + refreshToken are
    // encrypted at rest; never printed here.
    const save = await fetch(`${ARGOS_BASE}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gmail: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: tok.refresh_token },
      }),
    });
    if (!save.ok) {
      console.error(`Saved token but POST /api/settings failed (${save.status}). Is ARGOS running at ${ARGOS_BASE}?`);
      process.exit(1);
    }
    console.log("\n✓ Gmail read-only credentials stored in ARGOS (encrypted at rest).");
    console.log("  Scope: gmail.readonly — cannot send, delete, or modify mail.\n");
    process.exit(0);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
});
server.listen(PORT, "127.0.0.1");
