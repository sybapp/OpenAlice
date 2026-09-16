---
name: self-scheduling
description: >
  Define durable work and scheduled/headless execution with
  `.alice/issues/<id>.md`: structured ownership and optional `when` frontmatter
  plus one canonical markdown What. Use for creating or editing an Issue,
  choosing its assignee, schedule, prompt, delivery behavior, health state,
  or machine-checkable `watch` monitoring (deterministic pre-dispatch gate).
  Use the `alice` skill instead when the goal is to ask another
  Session for an answer.
---

# Issues & self-scheduling — `.alice/issues/<id>.md`

OpenAlice treats an issue as a collaboration object, not just a timer. It is the
durable place to put trading follow-up, monitoring work, open questions,
handoffs, and scheduled checks. Status, priority, and assignee tell humans and
agents what deserves attention; `when` is the extra field that lets an issue
summon a headless agent run. `watch` is the condition field for monitoring
Issues: the scanner judges it deterministically before any dispatch, so point
conditions belong there — not buried in What for every run to re-judge.

This workspace owns its work as **one markdown file per issue** in `.alice/issues/`
at its own root. Each file is YAML frontmatter (the structured fields) plus a
markdown What (the human-visible work definition and exact scheduled prompt).

- An issue **without** `when` is a plain **tracked work item** — it appears on
  the Issue board for you and the user to see, but the scanner never fires it.
- An issue **with** `when` **self-schedules**: a launcher scanner reads the dir
  (it never interprets the work) and fires a **headless run** of this workspace
  when the issue is due — exactly like a recurring job.

The filename stem **is** the issue id (`morning-scan.md` → id `morning-scan`).

## Two ways to manage issues — the CLI (agent surface) or the file

You have two equivalent paths, and both write the **same**
`.alice/issues/<id>.md` files:

1. **`alice issue …` — the convenient agent surface, and what you
   should reach for first.** A small set of verbs does the read-modify-write for
   you: id slug derivation, frontmatter validation against the allowed
   status/priority enums, structured comment sidecars, and not clobbering an
   existing id. The same tools are also exposed over **MCP** — it is *one*
   registration behind both, so an MCP-speaking agent gets the identical surface
   with no separate path.
2. **Editing the file directly** with your normal file tools. Reach for this when
   you are writing rich markdown **What** or scheduling frontmatter
  (`when` / `assignee` / `agent` / `credential` / `credentialSource` / `model` / `effort` / `timeout` / `watch` / `watchPaused` / `commentPrompt`) — the CLI verbs cover the board fields, What, timeout, watch, watchPaused, comment prompt, and
   comments, but the document and schedule shape read most clearly as text. The
   file is always the single source of truth either way.

### CLI verbs

```bash
# list — scan the WHOLE board: every workspace's issues as compact title rows
alice issue list

# show — one issue in full, resolved by its (global) name: frontmatter + What + comments +
# run history + inbox reports. --id takes a name OR id and resolves across the
# board; a name two workspaces share returns the candidates to pick from.
alice issue show --id morning-scan

# create — a new issue. --title is required; --id is derived as a kebab slug
# from the title when omitted. Creating over an existing id is refused.
alice issue create --title "Split the data fetcher" \
  --priority medium \
  --what "src/fetch.ts mixes the HTTP call with the normalization step."

# update — patch board fields, canonical What, run timeout, or the watch plan;
# scheduling cadence (`when`) is left untouched. Setting status done|canceled is how
# you silence a self-scheduled issue (there is no separate enabled flag).
# For a monitoring Issue prefer --watchPaused to pause dispatch (plan kept).
alice issue update --id morning-scan --status done
alice issue update --id morning-scan --timeout 30m
alice issue update --id nvda-watch --watch '{"version":2,"source":{"barId":"tradingview|NVDA","interval":"1h"},"rule":{"type":"price_above","price":195}}' --expected-watch-version 1

# comment — append markdown to the structured `<id>.comments.json` sidecar. An
# attributable Session signs with @resumeId. If somebody else comments on an
# For a fixed @resumeId owner, OpenAlice asks that owner in the background.
# Human comments without one ask the creator or a reconstructed Workspace Agent.
# Agent-authored comments without a fixed owner remain timeline notes.
alice issue comment --id morning-scan --text "Brief pushed; SPY gapped +0.4%."
```

Run `alice issue <verb> --help` for a verb's flags. Object-valued flags
take JSON — e.g. to create a self-scheduled issue in one call, pass the schedule
as `--when`:

```bash
alice issue create --title "Pre-market brief" --priority high \
  --when '{"kind":"cron","cron":"30 8 * * 1-5","timezone":"America/New_York"}' \
  --assignee @me \
  --what "Pull pre-market movers and overnight news for my watchlist, write a short brief to research/premarket.md, then run: alice inbox push --body-file research/premarket.md." \
  --agent codex \
  --credential openai-primary \
  --model gpt-5.6 \
  --effort high
```

A monitoring Issue adds the deterministic gate (`--watch` takes JSON — run
`alice issue <verb> --help` for the live shape). Keep the cheap
trigger in `watch`, the rich read in `what`:

```bash
# Discover the barId first — never guess it
alice analysis search-bars --query NVDA

alice issue create --title "NVDA breakout watch" \
  --when '{"kind":"every","every":"15m"}' \
  --watch '{"version":1,"source":{"barId":"tradingview|NVDA","interval":"1h"},"freshness":{"maxStaleTradingDays":0,"maxStaleMinutes":150},"rule":{"all":[{"type":"price_above","price":190.5},{"type":"ema_alignment","direction":"bullish"}]}}' \
  --what "NVDA breakout watch. The scanner already judged the close/EMA gate — do NOT re-judge it. On dispatch: run the multi-timeframe + Fib/VWAP + CVD/divergence read, then re-arm, propose a trade, or close."
```

The verb set is `list` / `show` / `create` / `update` / `comment` (no `delete` —
remove an issue by deleting its file, see Notes). **Reads are global, writes are
local:** `list` and `show` read the whole board across **every** workspace —
scan titles with `list`, decide which matter, then `show --id <name>` to read those
in full (the natural way to work a board) — while `create` / `update` /
`comment` write **this** workspace's own `.alice/issues/` files (changing a
peer's board is the human-approved peer-edit path). The examples below show the
on-disk file shape the CLI and your direct edits both produce.

## Example — a scheduled issue (`.alice/issues/morning-scan.md`)

```markdown
---
title: Pre-market brief
status: todo
priority: high
assignee: "@resume-calm-amber-river-a1b2c3"
when: { kind: cron, cron: "30 8 * * 1-5", timezone: America/New_York }
---

Pull pre-market movers and overnight news for my watchlist. Every trading
morning at 08:30, assemble the pre-market picture before the open, write a short
brief to `research/premarket.md`, then push it to Inbox. Cover movers, gaps, and
overnight headlines that move the thesis.
```

## Example — an unscheduled work item (`.alice/issues/refactor-fetcher.md`)

```markdown
---
title: Split the data fetcher into source + transform
status: backlog
priority: medium
assignee: "@unassigned"
---

`src/fetch.ts` mixes the HTTP call with the normalization step, which makes the
retry logic hard to test. Pull the transform into its own pure function so it
can be unit-tested without the network. No rush — picking this up next time we
touch fetching.
```

The first self-schedules (it has `when`) and keeps one accountable product
Session; the second is a pure work item the scanner ignores. Drop the `when`
line and any issue becomes a
plain tracked item; add a `when` and it starts firing.

## Frontmatter fields

- **`title`** — short, human-readable title of the issue (e.g. `Pre-market
  brief`). **Required.** This is what the Issue board and Inbox show. (The
  stable machine key is the filename `id`, not the title — so you can reword a
  title freely.)
- **`status`** *(optional, default `todo`)* — one of `backlog`, `todo`,
  `in_progress`, `done`, `canceled`. For a **scheduled** issue this is also its
  on/off switch: it fires only while the status is non-terminal. Moving it to
  `done` or `canceled` **silences** the schedule without deleting the file.
  (There is no `enabled` field — terminal status is how you pause a timer.)
- **`priority`** *(optional, default `none`)* — `urgent`, `high`, `medium`,
  `low`, `none`. Display/sort only.
- **`assignee`** *(optional)* — the single owner and
  scheduled-dispatch policy:
  - `@new-each-run` recruits a new product Session for each scheduled fire;
  - `@new-then-resume` asks the Workspace to recruit once; the first successful dispatch
    rewrites the Issue to that concrete `@resumeId`, so every later fire returns
    to the same accountable coworker;
  - an exact `@resumeId` continues that accountable Session, even when its
    signed Workspace differs from the Issue's Workspace;
  - `@human` and `@unassigned` are valid only for unscheduled work.
  CLI `issue create` defaults to `@me` when called by an attributable Session
  (who creates it owns it); `@me` is resolved to a concrete `@resumeId` before
  writing. Otherwise omitted scheduled ownership defaults to `@new-then-resume`, while an
  unscheduled board item defaults to `@unassigned`. Use `@new-each-run` explicitly
  only when every fire should recruit a newcomer.
- **`when`** *(OPTIONAL — present iff the issue self-schedules)* — one of:
  - `{ kind: every, every: "30m" }` — repeat on an interval (`30m`, `2h`,
    `1h30m`). Runs on the next scan, then on the interval.
  - `{ kind: cron, cron: "0 9 * * 1-5", timezone: local }` — a 5-field cron
    expression (`min hour day-of-month month day-of-week`; supports `*`, ranges
    `9-17`, lists `1,15`, steps `*/15`). `timezone` is part of the intent:
    use `local` for the user's own wall clock (morning reminders), or an IANA
    zone such as `America/New_York` for a market clock (pre-open scans). The
    zone handles daylight-saving changes. Omitted timezone remains machine-local
    only for compatibility with old files; new Issues should write it explicitly.
    A missed admission (busy Session, full worker pool) **retries that slot by
    default**, same as `every`. Write `catchUp: false` only when a miss should
    discard all elapsed slots and wait for the next future calendar time.
  - `{ kind: at, at: "2026-03-01T13:30:00Z" }` — run ONCE at an ISO timestamp,
    then never again.
- **`agent`** *(optional)* — runtime override for `@new-then-resume` / `@new-each-run`
  scheduled work; defaults to this Workspace's runtime resolution. An exact
  Session assignee already has an immutable runtime, so Session-owned Issues
  cannot set this.
- **`credential`** *(optional)* — secret-free OpenAlice vault slug for the
  fresh Session. Never put a key or endpoint in the Issue file.
- **`credentialSource: native`** *(optional)* — explicitly use the Agent
  runtime's own login. It cannot be combined with `credential`. Omit both to
  inherit this Workspace's headless fixed/recent preference.
- **`model`** *(optional)* — native model id for one scheduled run. Omit it to
  inherit the selected credential, Workspace, or native runtime default.
- **`effort`** *(optional)* — one-run reasoning effort: `none`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, or `max`. Use a level supported by the
  selected runtime; omit it to inherit.
- **`timeout`** *(optional)* — scheduled-run watchdog: `15m`, `30m`, `45m`, or
  `60m`. Omit it for no limit (the agent may run until it exits). This is a run
  budget, not Session birth, so an exact `@resumeId` owner may still set it.
- **`commentPrompt`** *(optional)* — template for the Input Prompt sent when a
  comment needs a reply. Omit it to keep the default wrapper (Issue identity
  plus “reply directly; do not call `issue comment`”). Override replaces that
  whole structure. Tokens: `{comment}`, `{title}`, `{id}`, `{workspaceId}`,
  `{author}`, `{what}`. Must include `{comment}`. Chat-style Issues use
  `{comment}` alone.
- **`watch`** *(optional — monitoring Issues only)* — the machine-checkable
  condition set the scanner judges deterministically before any dispatch.
  Shape: `{ version, source: { barId, interval, assetClass? }, sources?, quote?,
  freshness?, indicators?, rule }` where `rule` is one leaf or one
  `{ all: [...] }` / `{ any: [...] }` group (1–8 leaves, no nesting).
  Leaf whitelist: `price_above` / `price_below` / `price_in_range` /
  `price_out_of_range` / `price_cross_above` / `price_cross_below`
  (close only), `price_touch` (a price level overlapping recent closed-bar
  high/low ranges), `ema_alignment` / `price_vs_ema` / `price_vs_vwap`,
  `structure_break` (BOS/CHoCH), `zone_touch` (FVG/OB). Judgement uses
  closed bars only; unknown types are invalid files, never silent misses.
  `watch` requires `when`; `watchPaused` requires `watch`. `price_touch` on
  an intraday interval requires `freshness.maxStaleMinutes`; set it for other
  intraday monitoring too, especially with a delayed source. A signal-less hit dispatches once while it holds; a
  signal-bearing leaf may dispatch again only for a new signal id. Your turn
  opens with a `<watch-verdict>` block (version, per-leaf actuals, bar window, signal
  ids, run id). Your three valid exits: **re-arm** (write a new `watch`
  with a bumped `version` + reason via `issue update --watch …
  --expected-watch-version <live>`; a stale version is refused, re-read
  first), **propose a trade** (stage/commit; approval follows the same
  switch as any suggestion), or **close** (`--status done|canceled`).
  Never invent a fourth exit and never guess hidden state from prose.
  `source` is the default bar context; `sources` adds at most four named lowercase
  contexts and a leaf selects one with `source: '<name>'`. Contexts are
  freshness-gated and judged independently, so `all` / `any` may combine intervals;
  a check is bounded to five contexts, 1,000 total bars (`WATCH_MAX_TOTAL_BARS`), and four concurrent fetches. Out of scope remain
  volume/order-flow thresholds (CVD, absorption, exhaustion, footprint) and
  open/high/low intraday touch. Those stay in `what` as post-hit analysis —
  never as a reason to skip `watch`. Use `price_cross_*` for a one-time
  breakout, `all` for a conjunction, and `any` only when either trigger is
  genuinely valid; each leaf latches independently. For `structure_break`,
  set `since` to the intended observation start; for `zone_touch`, keep
  `lookbackBars` small. Prefer an explicit VWAP `anchor` over `auto` when the
  anchor is part of the thesis. Hybrid pattern: the cheap
  machine-checkable trigger in `watch` (e.g. `price_above` + `ema_alignment`),
  the multi-timeframe + Fib/VWAP + CVD/divergence read in `what`. A fitting
  `watch` fires deterministically with zero LLM; a What-only condition burns a
  full run every tick and can drift. Discover the `barId` first, never guess
  it: `alice analysis search-bars --query NVDA` (see the `alice-analysis`
  skill). Shape authority is
  `src/domain/analysis/technical-analysis/watch/spec.ts`.
- **`watchPaused`** *(optional)* — pause watched dispatch with the plan and
  latch kept; resume continues the same arming (`issue update --watchPaused
  true`; null/false resumes). Prefer this over closing the Issue when the
  thesis is intact but firing should stop.

`agent`, `credential`/`credentialSource`, `model`, and `effort` are one Session-creation tuple.
They are valid only for `@new-then-resume` / `@new-each-run`; an exact `@resumeId` Session owns
the complete tuple, so do not write those fields back onto the Issue file. Humans may still
change that Session's credential, model, and effort from the Issue page; the Agent runtime
stays locked. The scheduler freezes explicit values into the fresh Session runtime
binding and does not rewrite persistent Workspace configuration.

> **Deprecated assignee aliases:** never write `@workspace` or `@new` in a new
> or edited Issue. They exist only so older Workspace files can be migrated:
> `@workspace` → `@new-each-run`, and `@new` → `@new-then-resume`. The CLI and
> API reject both deprecated spellings with the canonical replacement.

The old parallel `execution` field is retired and rejected after migration;
never write it into a new Issue.

The markdown **What** below the closing `---` is the Issue's canonical work
definition. It is useful for every Issue; when scheduled, this exact visible
markdown becomes the headless prompt. Comments are separate structured markdown
records in `.alice/issues/<id>.comments.json`, written through `issue comment`.

Issue files are part of the Workspace's Git history. After intentionally
creating or modifying `.alice/issues/<id>.md`, make a focused Git commit for
that work-definition change; never sweep unrelated working-tree changes into
it. OpenAlice Activity is the readable audit fallback (including edits made
without a commit), while Git is the exact-content history and rollback layer.

## Link entities and issues with `[[name]]`

An Issue's What can reference things in the `[[]]` knowledge graph, exactly like
any other note: write `[[name]]` to link a **tracked entity** (an asset ticker
or topic, e.g. `[[vst]]`, `[[ai-data-center-power]]`) or **another issue** (by
its id or title). The link shows up as a backlink on the target's page and is
clickable in the issue detail — so an issue saying "blocked on
`[[refactor-fetcher]]` until `[[vst]]` earnings clear" wires straight to both.

Names are **global** and team-wide, not workspace-scoped — `[[vst]]` means the
same thing everywhere, and there is no workspace prefix. Because of that, a
**vague or short issue title can collide** with an issue of the same name in
another workspace; nothing blocks you at write time, but the board flags such
clashes with a duplicate-name warning in the UI **for you to clean up
manually** (rename one, or merge them). So give an issue a **specific,
self-describing title** (prefer `Split the data fetcher into source + transform`
over `cleanup`) — it makes the issue a clean, unambiguous `[[ ]]` target and
avoids the collision flag in the first place.

## Write `what` for a headless run

The scheduled run is **headless — nobody is watching, and it cannot see this
conversation.** Write What as a
**complete, standalone instruction**, as if handing the job to a fresh teammate
who has only this workspace's files. Say exactly what to read, do, and produce.

Decide whether the run should notify the human or simply update its work:

- If the run produces something the user should see — a brief, a finding, a
  result — use **Inbox for an outward-facing notification or report**:
  `alice inbox push --body "…"` (reference files with `[[relative/path.ext]]`,
  or publish Markdown using `--body-file <path>`). A report pushed
  during a scheduled run is automatically linked back to the issue that
  triggered it — you don't pass any id.
- If the run is a **check that didn't trigger** (condition not met, nothing
  changed), **exit silently — that is the correct outcome**, not a failure.
  Don't manufacture noise.

A Connector-backed Issue may deliver its reply directly to the connected chat;
other headless runs need not have a chat recipient. Do not assume every runtime
reply is delivered. Put an Inbox push in What when a separate notification or
report is part of completion, and avoid duplicating a reply that already serves
that purpose. Inbox is a human delivery record, not storage for every run result.

Two kinds of conditions — put each in the right place. A **machine-checkable
pre-dispatch trigger** belongs in the `watch` frontmatter field (deterministic,
zero-LLM, judged before every dispatch; see the `watch` entry above). **Everything
else** — order-flow/volume, news, or other analysis beyond the leaf whitelist —
belongs in `what` as post-hit analysis. If the trigger fits the v1 whitelist,
always use `watch`: a What-only condition burns a full headless run every tick
and can drift. For "ping me only if X" with no machine gate, write:
"check X; if it holds, push an alert; otherwise do nothing and exit."
For a `watch` Issue, the scanner already judged the machine condition — your
turn opens with its `<watch-verdict>`, so analyze (don't re-judge), then
take exactly one of the three exits above.

> **Commit the file.** The scanner reads your working tree, so an uncommitted
> `.alice/issues/<id>.md` still takes effect — but commit it so the issue (and
> any schedule) travels with the workspace and survives. Treat it like any
> other source file.

> **Trades still need a human.** A scheduled run can research, prepare, and even
> *stage* trades — but staged trades execute only when you approve them in the
> Web UI (Trading-as-Git). A timer never moves money on its own.

## Notes

- The scanner ticks about once a minute; a sub-minute cadence runs at most once
  a minute. Only issues with a `when` are ever fired.
- The `id` (filename stem) keys the scanner's "last fired" memory for scheduled
  issues, so don't rename a scheduled file you mean to keep (a new filename
  looks like a brand-new issue and fires right away).
- Runs are one-shot and independent — a run can overlap another run or your own
  interactive session in this same checkout. Treat it like ordinary concurrent
  edits; don't assume exclusive access.
- Each file is parsed and re-validated on every scan; a malformed file is
  reported on the board, in isolation, without breaking the other issues.
- Remove an issue by deleting its `.alice/issues/<id>.md` file (and commit). To
  pause a schedule without deleting it, set `status: done` or `status: canceled`.
  To pause only watched dispatch with the plan kept, use
  `issue update --id <id> --watchPaused true`.
- **Legacy:** the old single `.alice/issue.json` is retired. If you find one,
  split each issue into its own `.alice/issues/<id>.md` file with the
  frontmatter above.

Run a scheduled Issue immediately with `alice issue run --id <id>`; add `--await`
when its result is needed now. Retry its latest failed run with
`alice issue retry --id <id> --run-id <taskId>`. Both use the current What and
owner without moving the next scheduled occurrence.
