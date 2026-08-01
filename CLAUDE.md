@AGENTS.md

<!--
  AGENTS.md is the canonical repository instruction file. Claude Code supports
  importing it directly; keep Claude-specific additions exceptional and short.
-->

## Agent skills

### Issue tracker

Issues and PRDs for `sybapp/OpenAlice` live in GitHub Issues; use `gh` scoped
only to that repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context layout with root `CONTEXT.md` and `docs/adr/`.
See `docs/agents/domain.md`.
