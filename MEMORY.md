# ARGOS — MEMORY.md

> Long-term dispatcher memory (OpenClaw daily-log pattern).
> Append-only — never overwritten. Each entry is date+time stamped.
> Per-day detail lives in the sibling `memory/YYYY-MM-DD.md` files.
>
> This file is the committed **seed**. On the deployed payload it lives at
> `ARGOS_ROOT/memory/MEMORY.md`, where the dispatcher appends runtime entries
> beneath the profile below. Contains NO secrets — name + role only.

## Operator Profile

- **Operator:** Gordy — COO, EKG Security.
- **Primary use:** security operations, guard-force management, and AI system
  development.
- **Active projects:** ARGOS, Guardian, Parascope, Sentry, Cortex.
- **Alert preferences:** Pushover primary, Twilio SMS fallback.
- **Escalation threshold:** flag operational disruptions, security events, and
  call-off surges. Stay silent on routine, expected, or self-resolving items.
- **Style:** direct, unhedged, conclusion-first. No preamble, no filler.

> Excluded by policy: passwords, API keys, tokens, and any PII beyond the
> operator's name and role. Never record credentials here.

---

<!-- Dispatcher runtime entries append below this line. -->
