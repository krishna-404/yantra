---
strikes: 2
---

# Docs-correction specs can outrun the code strip they describe

Issue #20 (AGENTS.md refresh) asked for AGENTS.md to "reflect post-strip reality" and
gate on greps for `journal|oneq|prompts module|streak`. At execute time, the actual
`journal-entries`/`prompts` frontend modules were still live and fully wired into
`sync.orchestrator.ts` — the code strip is backlog items SB-8…SB-14 (parallel-group
1.B), not yet done. Issue #20 was parallel-group 1.C, so nothing guaranteed it ran
after the strip.

**Why it matters:** a docs-only spec that asserts "post-strip" can land before the
strip itself, leaving AGENTS.md ahead of the code it documents. Harmless here (docs
only, greps stayed satisfiable by generalizing away specific module names instead of
asserting a false current architecture), but the pattern is worth naming.

**How to apply:** when writing a Product Spec whose Bet depends on another backlog
item's outcome ("reflects post-X reality"), either add that item as `depends-on`, or
have the spec explicitly say the doc may describe target/near-future state ahead of
the code — so the executor doesn't have to infer it mid-run.
