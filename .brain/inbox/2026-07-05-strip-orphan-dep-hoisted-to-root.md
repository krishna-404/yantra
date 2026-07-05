# A strip's orphaned dependency can live in the ROOT manifest, not the workspace one

**Context:** #11 (strip frontend journal UI). The spec said to remove "the `ulid`
entry in `apps/frontend/package.json`", but that workspace never declared `ulid` — it
imported the root-hoisted copy. After deleting the last frontend importer
(`SmartMediaUploader`), knip's error-level `dependencies` rule flagged `ulid` at the
**root** `package.json`, because the backend keeps its own `ulid` and nothing else at
root level used it.

**Lesson:** When a module strip orphans a dependency, don't trust the spec's stated
manifest location — grep every `package.json` for the dep and remove it where it is
actually declared. In a Yarn/Turbo monorepo a workspace can consume a hoisted root dep
without declaring it, so the orphan surfaces in whichever manifest owns the now-unused
range. Refresh `yarn.lock` (`yarn install`) so the combined `dep@^a, dep@^b` lock line
collapses to the surviving range.

**Corollary:** knip severities are the real acceptance bar for a strip — `files`,
`dependencies`, `devDependencies`, `unlisted` are `error` (gate CI); `exports`/`types`/
`duplicates` are `warn`. Deleting a UI layer can newly-orphan `warn`-level exports under
retained infra (e.g. `createOnlineFirst` once its only caller is gone); those are the
sibling ticket's cleanup and do NOT need fixing to get the strip green.
