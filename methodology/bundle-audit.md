# Bundle Size Audit

Phase V of the autonomous block. Production build sizes from `npm run build`.

## Per-route sizes

| Route | Route JS | First Load JS | Status |
|---|---|---|---|
| `/` (chat home) | 40.7 kB | 157 kB | Static |
| `/_not-found` | 873 B | 88 kB | Static |
| `/api/chat` | 0 B | 0 B | Dynamic (server) |
| `/api/hardware` | 0 B | 0 B | Dynamic (server) |
| `/api/settings` | 0 B | 0 B | Dynamic (server) |
| `/api/vault/delete` | 0 B | 0 B | Dynamic (server) |
| `/api/vault/list` | 0 B | 0 B | Dynamic (server) |
| `/api/vault/search` | 0 B | 0 B | Dynamic (server) |
| `/api/vault/upload` | 0 B | 0 B | Dynamic (server) |
| `/memory` (stub) | 1.06 kB | 108 kB | Static |
| `/settings` | 5.4 kB | 122 kB | Static |
| `/tools` (stub) | 1.06 kB | 108 kB | Static |
| `/vision` (stub) | 1.06 kB | 108 kB | Static |
| `/voice` (stub) | 1.06 kB | 108 kB | Static |
| **Shared** | | **87.1 kB** | (React + Next runtime) |

## Verdict

**Healthy.** Largest route (`/`) ships 157 kB first-load JS, well below the 200 kB threshold where Lighthouse starts warning. The four stub routes at 1.06 kB each confirm the stub-honesty pattern doesn't pull in heavy dependencies.

The 87.1 kB shared chunk is essentially the React 18.3 + Next.js 14.2 runtime, which can't be reduced without dropping the framework. The two largest shared chunks:

- `chunks/fd9d1056-…js` — 53.6 kB — React runtime
- `chunks/117-…js` — 31.6 kB — Next.js client runtime + scheduler
- other — 1.9 kB

## What's NOT measured here

- **Server-side bundle size** (`.next/server/*`) — irrelevant for first-paint, but does affect cold-start time on `next start`. Currently ~150 MB on disk including all the source modules; this is what `migrate-to-usb.mjs` copies to USB.
- **Tree-shaking effectiveness** — would need source-map-explorer or @next/bundle-analyzer to tell which imports contribute most. Filed for v2 audit if bundle grows past 200 kB.
- **`framer-motion` import surface** — `framer-motion` is a sizeable dep (~50 kB raw). Our usage is `motion.svg` for the eye pulse on `/`. If pulse animation moves out of the chat route, framer-motion could be lazy-loaded.

## Optimization opportunities (NOT taken in v1)

These would shrink the bundle but trade off complexity. Filed for v2 if needed:

1. **Dynamic import the source-preview drawer** — only loads when a citation pill is clicked. Would shave ~10-15 kB off `/` first-load. Cost: extra round-trip on first preview click.
2. **Replace framer-motion with CSS keyframes** — the eye pulse is the only use. Pure CSS would drop framer-motion entirely. Cost: lose the structured animation API for future expansion (Vision/Voice/Memory pages will probably want motion when implemented).
3. **Split persona system prompts to a JSON asset** — currently inlined in `lib/personas.ts`. Each prompt is ~1-2 kB; three personas = ~4-5 kB. JSON would parse-on-demand. Marginal.
4. **Lazy-load the Vault upload widget** — only needed when the vault drawer opens. Could be code-split.

## Verify-host-clean implication

A 157 kB first-load is below the threshold where browsers prompt for cache extension. Combined with the Seven Rules ban on external CDN imports (Rule 4), every byte the browser caches comes from the loopback Next server — which means cache eviction is the only state the browser builds up, and it's cleared on browser quit / cache flush. No persistent state, no fingerprinting surface, no externals to track.

This is a small but real win for the USB-native posture: the app's entire surface fits in a single browser cache page.
