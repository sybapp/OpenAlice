---
name: openalice-fork-workflow
description: Project-local workflow for the OpenAlice fork at sybapp/OpenAlice. Use when managing this repository's upstream sync, master/dev/feature branch model, GitHub Issues, GitHub Pull Requests, gh CLI operations, or rebase/merge flows that must keep personal changes out of upstream/master.
---

# OpenAlice Fork Workflow

## Purpose

Use this skill only for the OpenAlice fork workflow in this repository.

Keep branch responsibilities strict:

- `master`: clean mirror of `upstream/master`; never develop here.
- `dev`: long-lived personal integration branch; contains accepted custom work.
- `feature/*`: one task or feature branch; merge into `dev`, not `master`.
- `upstream/master`: official TraderAlice/OpenAlice branch.
- `origin/*`: sybapp/OpenAlice fork branches.

## Before Changing Branches

Run:

```bash
git status --short --branch
git remote -v
```

If the worktree is dirty, preserve user changes. Do not reset, checkout, or rebase through local changes unless the user explicitly asks or the changes are committed/stashed with clear intent.

Confirm remotes:

```bash
origin    git@github.com:sybapp/OpenAlice.git
upstream  https://github.com/TraderAlice/OpenAlice
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/TraderAlice/OpenAlice
```

## Sync Upstream

Synchronize the clean fork `master` with upstream:

```bash
git fetch upstream --prune
git checkout master
git reset --hard upstream/master
git push origin master --force-with-lease
```

Then update the personal integration branch:

```bash
git checkout dev
git rebase master
git push origin dev --force-with-lease
```

If `dev` has no personal commits yet and should be clean:

```bash
git checkout dev
git reset --hard master
git push origin dev --force-with-lease
```

## Start Work From an Issue

Create an issue for a task:

```bash
gh issue create \
  --repo sybapp/OpenAlice \
  --title "Short task title" \
  --body "Context, scope, and validation plan."
```

List open issues:

```bash
gh issue list --repo sybapp/OpenAlice
```

Create a feature branch from `dev`:

```bash
git checkout dev
git pull --ff-only origin dev
git checkout -b feature/123-short-name
git push -u origin feature/123-short-name
```

Use issue-numbered branches when possible:

```text
feature/123-marketdata-provider-registry
fix/124-yfinance-refresh
refactor/125-marketdata-service-cleanup
```

## Continue Feature Work

Commit normally on the feature branch:

```bash
git status --short
git add <files>
git commit -m "feat(scope): concise change"
git push
```

If upstream changed while the feature is in progress:

```bash
git fetch upstream --prune
git checkout master
git reset --hard upstream/master
git push origin master --force-with-lease

git checkout dev
git rebase master
git push origin dev --force-with-lease

git checkout feature/123-short-name
git rebase dev
git push origin feature/123-short-name --force-with-lease
```

Resolve conflicts with:

```bash
git add <resolved-files>
git rebase --continue
```

Abort only when the rebase direction is wrong or the user asks:

```bash
git rebase --abort
```

## Open a PR Into Dev

Open PRs inside `sybapp/OpenAlice`, with `dev` as the base:

```bash
gh pr create \
  --repo sybapp/OpenAlice \
  --base dev \
  --head feature/123-short-name \
  --title "Short PR title" \
  --body "Closes #123

Summary:
- Change 1
- Change 2

Validation:
- Test or command run"
```

Never open routine personal-work PRs against `TraderAlice/OpenAlice` or against `master`.

Check PR status:

```bash
gh pr status --repo sybapp/OpenAlice
gh pr view --repo sybapp/OpenAlice --web
```

Merge after review/validation:

```bash
gh pr merge <pr-number> \
  --repo sybapp/OpenAlice \
  --merge \
  --delete-branch
```

Use `--squash` only when the user wants one final commit. Prefer normal merge when preserving feature history matters.

After merge:

```bash
git checkout dev
git pull --ff-only origin dev
git branch --delete feature/123-short-name
```

## Rebase Rules

Remember the direction:

```bash
git checkout branch-to-update
git rebase base-branch
```

Correct examples:

```bash
git checkout dev
git rebase master

git checkout feature/123-short-name
git rebase dev
```

Incorrect for this workflow:

```bash
git checkout master
git rebase dev
git checkout master
git merge feature/123-short-name
```

These put personal changes onto `master`, which violates the branch model.

## GitHub Defaults

Prefer these repository settings:

- Default branch: `dev`
- `master`: used only for upstream sync
- PR base for personal work: `dev`
- Issues: track tasks, bugs, refactors, and upstream sync work

Use `gh` whenever practical so issue and PR operations are reproducible from the terminal.
