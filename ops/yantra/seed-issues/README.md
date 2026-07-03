# Seed backlog (Y0.7) — ready-to-file issue bodies

One file per issue from `docs/yantra/06-seed-backlog.md`. Format: first line
`TITLE: …`, everything after the `---` separator is the issue body, written in the
same `### field` layout the Product Spec issue form produces (so the harness's
`issue_field` parser treats filed-by-hand and filed-by-form issues identically).

**Numbering contract:** `depends-on` references assume these are filed IN ORDER into
an issue tracker with no prior issues or PRs, so SB-n lands as issue #n. If the
sequence drifts (an issue or PR grabs a number first), fix the `depends-on` refs at
filing time — they are DAG edges the harness enforces at claim.

Filing: `gh issue create --title "$(head -1 f | sed 's/^TITLE: //')" --body-file <(sed '1,/^---$/d' f)`
(or the GitHub API equivalent). After filing: labels per `06-seed-backlog.md`
(everything starts unlabeled in Backlog; only SB-1 gets `spec:ready`, and only at
the Y0.8 smoke-test moment).
