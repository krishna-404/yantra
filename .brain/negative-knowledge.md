# Negative knowledge — tried and rejected

Append-only record of approaches we considered and deliberately rejected, so the loop
does not rediscover and re-propose them. Each entry states **what was tried** and **why
it was rejected** (the reason is the durable part — it outlives the specific proposal).

**Entry format:**

```
## NK-<n> — <short title>
_status: rejected_

**Tried:** <the approach considered>
**Why rejected:** <the reason it fails / the better path we took instead>
```

The first six entries are seeded from the pre-repo master plan §17 (that plan is not
committed to this repo; inlined here verbatim).

---

## NK-1 — Building the agent engine ourselves
_status: rejected_

**Tried:** Building the agent engine ourselves on connected-repo.
**Why rejected:** Reinvents the hardest, most-solved layer; adopt-and-compose instead.

## NK-2 — Recycling accounts/IPs/emails to reset free-tier limits
_status: rejected_

**Tried:** Account/IP/email recycling to reset free-tier limits.
**Why rejected:** Limits follow the account/key, violates ToS, risks bans sweeping paid
accounts.

## NK-3 — Kiro / IDE tools in the loop
_status: rejected_

**Tried:** Kiro / IDE tools in the loop.
**Why rejected:** Interactive IDEs, not headless runners.

## NK-4 — A general-purpose persistent daemon per team
_status: rejected_

**Tried:** A general-purpose persistent daemon per team (Hermes/OpenClaw-style).
**Why rejected:** Stateful drift and lock-in; layered memory + stateless subtask engine
replaces it.

## NK-5 — Agents writing directly into the brain / a chatroom of persistent peers
_status: rejected_

**Tried:** Agents writing directly into the brain / a chatroom of persistent peer-agents.
**Why rejected:** Clutters the curated brain; replaced by ephemeral chatter + gated
synthesis-via-PR + stateless sub-agents.

## NK-6 — Unbounded agent free-play
_status: rejected_

**Tried:** Unbounded agent free-play.
**Why rejected:** Exploration requires rails: sandbox only, never prod/client-data/spend,
output lands on a review surface, never auto-merged.
