---
name: playwright-globalsetup-ci-browser-parity
description: Playwright globalSetup must only launch browsers CI actually installs — CI-gated projects don't gate the globalSetup that seeds their auth state
metadata:
  type: project
strikes: 1
---

Playwright's `projects` array can be gated per-environment (e.g. mobile projects
`...(isCI ? [] : [...])` in `playwright.config.ts`), but **`globalSetup` runs
independently of that gating**. If globalSetup eagerly builds auth/storage state
for every project — including ones disabled in CI — it will `browserType.launch()`
a browser that the CI job never installed.

Concretely: the `e2e` job installs Chromium only (`playwright install chromium`)
because the CI projects are Chromium-based. But `e2e/globalSetup.ts` unconditionally
called `createAuthState(devices["iPhone 12"], …)`, whose `defaultBrowserType` is
`webkit`, so it launched WebKit and failed fast with
`Executable doesn't exist at .../webkit-2248/pw_run.sh` — **before any test ran**,
turning the job red. Playwright starts the `webServer`s first, so a globalSetup
browser-launch failure looks like "servers fine, suite dies immediately".

**How to apply:** keep globalSetup's browser set in parity with the enabled
`projects` for the environment. Gate the same way the config does — e.g.
`if (process.env.CI !== 'true') { push mobile/WebKit auth states }` — or install
every browser globalSetup touches. When adding an E2E job, cross-check that the
browsers `playwright install` provisions cover *both* the projects **and** whatever
globalSetup launches. Related: [[turbo-strict-env-needs-dotenv-file]].
