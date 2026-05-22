#!/usr/bin/env node
// smoke-sessions.mjs
//
// Live smoke for /api/chat/sessions{,/[id]} routes. Creates a session,
// reads it back, lists, updates, deletes. Asserts each step.

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  const tag = cond ? "✓" : "✗";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (cond) passed++;
  else failed++;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, json };
}

console.log(`smoke-sessions — chat history persistence`);
console.log("=".repeat(64));

// Capture pre-existing session count so we can detect just our churn.
const pre = await api("GET", "/api/chat/sessions");
check("list returns 200 initially", pre.status === 200);
const preCount = pre.json?.count ?? 0;
console.log(`  pre-existing sessions: ${preCount}`);

// Create
const createRes = await api("POST", "/api/chat/sessions", {
  personaId: "bartimaeus",
  model: "llama3.1:8b-instruct-q4_K_M",
  messages: [
    {
      id: "m1",
      role: "user",
      content: "What is rule 1?",
      timestamp: 1779000000000,
    },
    {
      id: "m2",
      role: "assistant",
      content: "Rule 1 is zero host persistence.",
      timestamp: 1779000001000,
      personaId: "bartimaeus",
    },
  ],
});
check("create returns 200", createRes.status === 200);
check("create returns id", typeof createRes.json?.id === "string" && createRes.json.id.length > 0);
check("create derives title from user message", createRes.json?.title === "What is rule 1?");
check("create messageCount=2", createRes.json?.messageCount === 2);
const newId = createRes.json?.id;

// List should now have +1
const list2 = await api("GET", "/api/chat/sessions");
check("list count incremented", list2.json?.count === preCount + 1);
check(
  "list contains the new session",
  list2.json?.sessions?.some((s) => s.id === newId)
);

// Read back full session
const readRes = await api("GET", `/api/chat/sessions/${newId}`);
check("read returns 200", readRes.status === 200);
check("read messages preserved", readRes.json?.messages?.length === 2);
check("read content preserved", readRes.json?.messages?.[1]?.content === "Rule 1 is zero host persistence.");
check("read personaId preserved", readRes.json?.personaId === "bartimaeus");
check("read createdAt is number", typeof readRes.json?.createdAt === "number");

// Update (add a turn)
const updateRes = await api("POST", "/api/chat/sessions", {
  id: newId,
  personaId: "bartimaeus",
  model: "llama3.1:8b-instruct-q4_K_M",
  createdAt: readRes.json.createdAt,
  messages: [
    ...readRes.json.messages,
    {
      id: "m3",
      role: "user",
      content: "Tell me more.",
      timestamp: 1779000002000,
    },
    {
      id: "m4",
      role: "assistant",
      content: "Per Rule 1, the app must never write outside ARGOS_ROOT.",
      timestamp: 1779000003000,
      personaId: "bartimaeus",
    },
  ],
});
check("update returns 200", updateRes.status === 200);
check("update messageCount=4", updateRes.json?.messageCount === 4);
check("update preserved id", updateRes.json?.id === newId);

// Read after update — createdAt unchanged, updatedAt advanced
const readAfter = await api("GET", `/api/chat/sessions/${newId}`);
check("read after update messages=4", readAfter.json?.messages?.length === 4);
check(
  "createdAt unchanged across update",
  readAfter.json?.createdAt === readRes.json?.createdAt
);
check(
  "updatedAt advanced",
  readAfter.json?.updatedAt >= readRes.json?.updatedAt
);

// Validation: missing field
const badCreate = await api("POST", "/api/chat/sessions", { personaId: "bartimaeus" });
check("missing model rejected", badCreate.status === 400);

// Validation: invalid session id (contains unsafe chars). Next.js
// normalizes path-traversal `..` before our handler sees it, so use a
// char-class violation that survives routing — e.g. embedded dots/spaces.
const badRead = await api("GET", `/api/chat/sessions/abc.def`);
check("unsafe-char id rejected (400)", badRead.status === 400);

// 404 on unknown id
const missingRead = await api("GET", `/api/chat/sessions/0000000000000000`);
check("unknown id returns 404", missingRead.status === 404);

// ===== Search (Z13) ===========================================
console.log("\n[search]");
// Title-match search
const titleSearch = await api("GET", `/api/chat/sessions?q=${encodeURIComponent("rule 1")}`);
check("search returns 200", titleSearch.status === 200);
check("search returns hits array", Array.isArray(titleSearch.json?.hits));
const titleHit = titleSearch.json?.hits?.find((h) => h.id === newId);
check("search finds session via title", !!titleHit);
check("title match flagged matchedIn='title'", titleHit?.matchedIn === "title");
check("search snippet present", typeof titleHit?.snippet === "string" && titleHit.snippet.length > 0);

// Message-match (content present but title doesn't include the query)
const msgSearch = await api("GET", `/api/chat/sessions?q=${encodeURIComponent("never write outside")}`);
const msgHit = msgSearch.json?.hits?.find((h) => h.id === newId);
check("search finds session via message content", !!msgHit);
check("message match flagged matchedIn='message'", msgHit?.matchedIn === "message");
check("message match includes matchedMessageIndex", typeof msgHit?.matchedMessageIndex === "number");

// No match
const noMatch = await api("GET", `/api/chat/sessions?q=${encodeURIComponent("xyzzy_no_match_token")}`);
check("no-match search returns hits=[]", Array.isArray(noMatch.json?.hits) && noMatch.json.hits.length === 0);

// Empty query is allowed but returns no hits (consistent with no-match)
const emptyQ = await api("GET", `/api/chat/sessions?q=`);
check("empty q returns hits=[]", Array.isArray(emptyQ.json?.hits) && emptyQ.json.hits.length === 0);

// Oversized query (>256 chars) → 400
const longQ = await api("GET", `/api/chat/sessions?q=${"x".repeat(300)}`);
check("oversized q rejected (400)", longQ.status === 400);

// Delete
const deleteRes = await api("DELETE", `/api/chat/sessions/${newId}`);
check("delete returns 200", deleteRes.status === 200);
check("delete reports removed=true", deleteRes.json?.removed === true);

// Re-read should 404
const after = await api("GET", `/api/chat/sessions/${newId}`);
check("read after delete returns 404", after.status === 404);

// Idempotent delete
const deleteAgain = await api("DELETE", `/api/chat/sessions/${newId}`);
check("delete idempotent (removed=false)", deleteAgain.json?.removed === false);

// Final count back to pre
const finalList = await api("GET", "/api/chat/sessions");
check("session count restored", finalList.json?.count === preCount);

console.log("\n" + "=".repeat(64));
console.log(`smoke-sessions: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
