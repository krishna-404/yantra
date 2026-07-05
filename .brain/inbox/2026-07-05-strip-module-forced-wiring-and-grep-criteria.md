# Lesson: strip-module deletions force edits outside `files_expected`, and "grep → 0" criteria collide with protected paths

**Context:** Stripping the backend `journal-entries` module (#8). `files_expected` listed
only `modules/journal-entries/**`, `routers/**`, `procedures/**`.

**What bit / what to remember:**

1. **A module deletion is never self-contained.** Central registries import the deleted
   files and break `check-types` the moment the directory is gone. Here that was the ORM
   table registry (`db/db.ts`) and the pg-tbus event-handler registry
   (`events/events.utils.ts`) — neither in `files_expected`. Before deleting, grep the
   whole app for the module's import path AND its exported symbols (table name, handler
   names), not just the module dir. Edit those forced sites minimally (only the
   module-specific lines) and justify them in the PR body — that is in-bounds, a green
   build is the hard rule.

2. **"grep <word> returns 0 / only X" success criteria are often unsatisfiable as
   written** when the word also appears in protected paths (D16 sync infra, migrations)
   or in adjacent features owned by sibling issues (here a `journalReminderTimes` user
   column spanning users/auth/cron). Satisfy the *scoped intent* (0 hits in the
   module/router/procedure surface), leave protected/out-of-scope hits alone, and
   document the residual list explicitly rather than chasing the literal number into a
   forbidden diff.

3. **Distinguish domain code from infra by what it references, not where it lives.** The
   journal notification handlers lived under `modules/journal-entries/` but were wired
   through the shared event bus; the sync service only *mentioned* journal in a doc
   comment and had zero code coupling. Read the actual references before assuming a
   deletion will (or won't) ripple into protected infra.
