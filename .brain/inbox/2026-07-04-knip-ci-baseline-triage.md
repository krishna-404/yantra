---
title: Declaring browser-loaded entrypoints as knip `entry` clears false-positive unused-dep findings
strikes: 1
---

**Context:** Adding `knip` to CI (Y1.A). This stub originally bundled three lessons;
the severity-tiering strategy and the zod-schemas build precondition were
corroborated by later strip-module runs (issues #11, #12) and promoted to
`.brain/conventions.md`. This residual note has only the one occurrence so far.

**Lesson:** knip flagged dependencies used only by the service worker
(`workbox-precaching`, `workbox-routing`) as unused, because it didn't see
`src/sw/sw.ts` as a real entrypoint — it's browser-loaded, not imported from anywhere
knip's default entry heuristics scan. Declaring such files in knip's `entry` config
cleared the false positives. Before adding a knip ignore for an "unused dependency"
finding, check whether the true cause is a missing entrypoint declaration.
