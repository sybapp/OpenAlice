# Issue tracker: GitHub

Issues and PRDs for this repo live in GitHub Issues. All issue operations must
target `sybapp/OpenAlice` via the `gh` CLI; do not operate on `upstream` or
another repository.

## Conventions

- **Create an issue**: `gh issue create --repo sybapp/OpenAlice --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo sybapp/OpenAlice --comments`, including labels when needed.
- **List issues**: `gh issue list --repo sybapp/OpenAlice --state open` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --repo sybapp/OpenAlice --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --repo sybapp/OpenAlice --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --repo sybapp/OpenAlice --comment "..."`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says “publish to the issue tracker”

Create a GitHub issue in `sybapp/OpenAlice`.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --repo sybapp/OpenAlice --comments`.
