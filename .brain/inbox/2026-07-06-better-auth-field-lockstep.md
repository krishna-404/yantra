---
strikes: 1
---

# better-auth additionalFields must change in lockstep (server ↔ client)

When adding or removing a better-auth user/session `additionalFields` entry, the
server config (`apps/backend/src/modules/auth/auth.config.ts`) and the frontend
client's `inferAdditionalFields` (`apps/frontend/src/utils/auth.client.ts`) MUST
be edited together. They define the same field twice; editing one without the
other silently desyncs the inferred session type from what the server actually
returns — the revert condition for auth strips/adds.

Corollary for strips: a field removed from `additionalFields` usually also lives
in the ORM model (`users.table.ts`), the session transform
(`utils/session.utils.ts`), the zod user schema, any router procedures that
select/update it, and the test-user fixture. Grep the field name across
`apps packages` first and remove the whole footprint in one pass; a leftover
consumer breaks the build, a leftover ORM column is harmless (dropped later by
`yarn db g`).

Watch-out: generated artifacts (`apps/backend/openapi_pretty.json`) are often
stale and NOT regenerated per-PR — regenerating them mid-strip can sweep in
huge unrelated churn. Check whether prior PRs kept them current before touching.
