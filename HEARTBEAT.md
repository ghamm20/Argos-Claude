# ARGOS HEARTBEAT CHECKLIST

> Read on every heartbeat tick. The triage model (Bobby) reviews each
> item against the current context and decides whether anything needs
> the operator's attention RIGHT NOW. If nothing is actionable, it
> replies `HEARTBEAT_OK` and ARGOS stays silent. If something needs
> action, ARGOS fires a Pushover alert with the specifics.
>
> Keep items concrete and checkable. Vague items produce noisy alerts.
> Delete or comment out (with `#`) anything you don't want triaged.
> An EMPTY file skips the tick entirely (no alert).

## Operator: Gordy — EKG Security (COO)

### Infrastructure & uptime
- Is the ARGOS USB drive (D:) below 85% full? Flag if disk is tight.
- Is Ollama responding on 127.0.0.1:11434? (If this tick ran, it is.)
- Any service that should be running but isn't (Oculus, SuperAGI)?

### Security posture
- Any credential, API key, or PIN that is overdue for rotation
  (> 90 days since last change)?
- Any vault document marked sensitive that was added in the last
  24h and should be reviewed?
- Any failed operator-auth attempts worth noting?

### Active projects (ARGOS, Jenna, Parascope, Sentry, Cortex, Halal Jordan)
- Any deadline, deliverable, or commitment due within 48h that has
  not been marked done?
- Any blocker the operator flagged earlier that is still unresolved
  and is now time-sensitive?

### Research & intel
- Any scheduled research stream that has not fired in over 24h when
  it should have?
- Any watchlist keyword that surfaced in recent research and warrants
  a heads-up?

### Personal / cadence
- End of day (after ~18:00 local): is there an unreviewed item that
  should not roll to tomorrow?

---
**Triage rules for the model:**
- Be conservative. Only flag genuinely actionable, time-sensitive items.
- One alert per tick. Lead with the single most important thing.
- If you cannot verify an item from the available context, do NOT
  invent a problem — treat unknowns as `HEARTBEAT_OK` for that item.
- If nothing across the whole checklist is actionable, reply with
  exactly: `HEARTBEAT_OK`
