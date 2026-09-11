# Plan: Issue-native conditional monitoring (`watch`)

**Status:** active — increments 1–4 landed; only open-market paper legs + acceptance remain
**Owner guides:** [[docs/workspace-issues-and-scheduling.md]], [[docs/market-data-architecture.md]], [[docs/project-structure.md]]
**Delivery:** feature-branch iteration on `feat/issue-watch-monitor` (based on `feat/technical-analysis-suite`, not `dev`). No PR until maintainer accepts.
**Related code:** `src/workspaces/schedule/scanner.ts`, `src/workspaces/issues/declaration.ts`, `src/workspaces/issues/mutate.ts`, `src/workspaces/schedule/marker-store.ts`, `src/domain/analysis/technical-analysis/interval-analysis.ts`, `src/domain/analysis/technical-analysis/indicators.ts`, `src/domain/analysis/technical-analysis/price-action/`, `src/domain/market-data/bars/bar-service.ts`, `src/tool/trading.ts`, `services/uta/src/http/routes-trading.ts`

## Goal

Give a scheduled Issue an Issue-native conditional-monitor capability: Alice does deterministic observation + judgement, the existing harness does post-hit analysis, UTA does approval + execution. First version covers price / indicator / structure signals together.

```text
Issue(when + watch) -> Alice check (hit/miss/unavailable) -> hit+latch -> harness Session analysis
  -> wait (new watch) | propose trade (stage/commit, same approval switch) | close issue
```

## Decisions (locked with maintainer)

1. **`watch` DSL: strict whitelist + one-level `all` / `any`.** No arbitrary nesting, no expression language in v1. "走势变好" style natural language stays in `What` and is translated by the harness into an executable `watch` on re-arm; the checker never interprets NL.
2. **Default quote is closed bars.** Intraday touch ("盘中碰一下就触发") must explicitly declare a realtime/quote source and semantics; close price never proves an intraday touch.
3. **Approval reuses the one existing switch.** Monitor-staged operations go through the identical stage → commit → push path as normal suggestions, gated by the same `allowAiTrading` switch (`src/tool/trading.ts:786`, `src/main.ts:275`). No separate forced-approval lane for monitor origin; no `origin` flag on push. Accepted consequence: with the switch ON, monitor suggestions auto-push like any other suggestion.
4. **Branch base is the current stack.** Work lives on `feat/issue-watch-monitor` branched from `feat/technical-analysis-suite`. Reconcile with `dev` only at acceptance.
5. **This plan file is the contract.** Increments land as verified commits on the same branch.

## What "1. 再说明白一点" means (the `watch` contract)

### Where it lives

`watch` is Issue frontmatter, alongside `when`. `What` (markdown body) keeps the human intent; `watch` is the machine-checkable subset. `assignee` is reused unchanged (durable Session keeps prior analysis context). Runtime state (`lastCheckedAt`, `lastTriggeredAt`, consumed signals, evidence, run/approval refs) lives in Alice launcher state, never in the markdown.

```yaml
---
title: NVDA breakout watch
status: todo
assignee: "@new-then-resume"
when: { kind: every, every: "15m" }
watch:
  version: 1
  source: { barId: "tradingview|NVDA", interval: "1h", assetClass: equity }
  quote: { kind: closed_bar }        # v1 default; intraday must say so explicitly
  freshness: { maxStaleTradingDays: 0 }
  rule:
    all:
      - { type: price_above, price: 190.5, field: close }
      - { type: ema_alignment, direction: bullish }
---
Body: why we watch NVDA, what the harness should do on hit, risk constraints.
```

One level only: `rule` is either a single condition or `{ all: [...] }` / `{ any: [...] }` with 1–8 leaf conditions. No `all` inside `all`.

### v1 whitelist (closed set, unknown `type` = invalid file, never silent miss)

| Family | `type` | Parameters | Judgement basis |
|---|---|---|---|
| Price | `price_above` / `price_below` | `price`, `field: close` (v1 only close) | Declared `barId` closed-bar close |
| Price | `price_in_range` / `price_out_of_range` | `low`, `high`, `field: close` | Closed-bar close vs explicit band |
| Price | `price_cross_above` / `price_cross_below` | `price`, `field: close` | Prev-close → last-close crossing on consecutive closed bars |
| Indicator | `ema_alignment` | `direction: bullish/bearish`, `fast/slow/long?` | `buildTechnicalAnalysisIndicators` EMA bias on the same bars |
| Indicator | `price_vs_ema` | `which: fast/slow/long`, `relation: above/below` | Last close vs that EMA value |
| Indicator | `price_vs_vwap` | `relation: above/below/at`, `anchor?` | Indicator VWAP relation; unavailable anchor = `unavailable`, not miss |
| Structure | `structure_break` | `kind: BOS/CHoCH/any`, `direction?`, `level?`, `since?` | New confirmed event with stable identity (see below), not array index |
| Structure | `zone_touch` | `zone: FVG/OB`, `relation: touch`, `lookbackBars?` | Last closed bar range vs active zone band |

Explicitly out of v1: `open/high/low` intraday touch on closed-bar quote, volume/order-flow thresholds, multi-source rules, cross-interval rules (one `source.interval` per `watch`; multi-timeframe stays a harness job after hit).

### Checker semantics (the five rules from the proposal)

1. **Latch after hit.** One arming triggers at most one dispatch. A still-true condition does not re-fire. Re-arm requires the harness to write a new `watch` (bumped `version`) or an explicit re-arm. Cooldown is auxiliary only.
2. **Check vs dispatch clocks are separate.** `lastCheckedAt` advances on every check; `lastTriggeredAt` only on hit-dispatch. Waiting must not render as scheduling failure.
3. **`unavailable ≠ miss`.** Stale bars, insufficient history, unclosed anchor bar, uncomputable indicator → `unavailable` + reason, no dispatch, visible cause. Minute-level staleness is added (current `computeFreshness` is trading-day only).
4. **Hit is traceable and recoverable.** Persist `watchVersion`, bar window `[from,to]`, `dataAsOf`, actual values, event identities, `runId`. Restart reconciles without double-dispatch; capacity shortage never consumes a valid hit. Structure identity is `(level, kind, direction, brokenSwing price/time, break bar time)` — never a rolling-array index.
5. **Stale analysis cannot overwrite a new plan.** `watch` updates carry `expectedWatchVersion`; a harness verdict computed against an older version is rejected as conflict and must re-read.

### Cost control

One `source + interval + params` fetch/compute is shared per scan tick. The checker reuses the low-level algorithms (`indicators.ts`, `price-action/analyze.ts`) on loaded bars and never routes through `analyzeTechnicalAnalysisInterval` (which always computes order-flow even in `context` mode). Full analysis runs only after a hit, inside the harness turn.

## Seam placement

- New deep module `src/domain/analysis/technical-analysis/watch/` — small interface, all judgement logic + tests behind it:
  - `spec.ts`: `watch` zod schema + versioning (the only place that knows the DSL).
  - `eval.ts`: `evaluateWatch(loadedBars, indicators, priceAction, watch, ctx) -> hit | miss | unavailable + evidence` (pure, no IO — the interface tests target).
  - `check.ts`: `checkWatch({ barService }, watch, now) -> Verdict` (fetch + selective compute + freshness + closed-bar gate; internal seam, faked `BarService` in tests).
- `src/workspaces/schedule/scanner.ts` only orchestrates: due → check → latch → dispatch-or-record. No indicator math in the scanner.
- `src/workspaces/issues/` owns `watch` declaration/mutation/display; launcher state owns `watch-state.json` (separate file from `schedule-markers.json`, pruned per scan).
- Trading path untouched: no UTA `origin` column, no push-route change (per decision 3).

## Increments

### 1. Condition + data contract

- `watch` zod schema (+ `IssueFieldPatch.watch`, `expectedWatchVersion` concurrency, declaration/mutate/board wiring, invalid-file isolation).
- Pure `evaluateWatch` for all v1 leaf types + one-level `all`/`any`, with evidence shape.
- Freshness extension: closed-bar gate + minute-level staleness alongside `staleTradingDays`.
- Structure identity helper (stable id from confirmed event, not index).
- [x] Fixed-bar replay specs: every leaf + combos deterministic (`watch/eval.spec.ts`, 17 cases).
- [x] Stale / missing / in-progress fixtures → `unavailable`, never hit (`watch/freshness.spec.ts`, `watch/check.spec.ts`: fetch throw, trading-day + minute staleness, closed-bar drop).
- [x] Unknown `type` / bad params → invalid issue, loud (`issues/watch.spec.ts`: schema + create/update/clear/round-trip + stale-version guard).
- [x] `checkWatch` orchestration: one `getBars` → freshness/closed-bar gate → `analyzePriceActionBars` + indicators (fib/confluence off) → `evaluateWatch`; fetch throw → `unavailable`.
- [x] Insufficient-history / unconfirmed-structure replay end-to-end (`check.spec.ts`: single-bar cross → `unavailable` (needs two closes); volume-less window VWAP → `unavailable`; flat short window structure → `miss` with no phantom signals).

### 2. Background trigger

- [x] Scanner gating (`schedule/scanner.ts:fireWatched`): `when`-due + `watch` verdict; `miss`/`unavailable`/latched-hit record check memory, zero dispatch (zero LLM). Checker + state are optional deps — unwired tests keep the legacy always-fire path.
- [x] `watch-state.json` (`schedule/watch-state.ts`): `{ watchVersion, lastCheckedAt, lastTriggeredAt, lastStatus, lastReason, lastEvidence, consumedSignalIds, lastRunId }`, atomic write, per-scan prune, restart reload dedups.
- [x] Latch: signal hits dedup on consumed ids (new id on same version re-fires); signal-less hits fire once per arming until the version bumps. Capacity/busy skip consumes nothing (hit stays live). Check throw isolates per-issue as `unavailable`.
- [x] Per-tick sharing: identical watches judge once per scan (shared in-flight promise, incl. rejections); each issue still dispatches its own run.
- [x] Wiring: `WatchRuntimeStore` loaded in `service.ts`, `checkWatch({barService})` injected as the scanner's checker via `WebPlugin(ctx.barService)`; board/detail/schedule snapshots carry `watch` + `watchState`; `automation-health` reads due-but-gated as `healthy` (waiting / stale-data / dispatched), never failure.
- [x] Specs: miss/unavailable → no dispatch; sustained hit + restart → single dispatch; new signal re-fires; capacity retry; failure isolation; sharing; health readings (`scanner.spec.ts` watch block, `watch-state.spec.ts`, health spec).

### 3. Analysis + approval close-loop

- [x] Harness exits via validated tools only (never NL-sniffing): re-arm (`issue update --watch … --expected-watch-version <live>` + reason comment), stage/commit trade proposal, or close (`--status done|canceled`). Skill documents the three exits (`self-scheduling/SKILL.md`).
- [x] Verdict block (`issueWatchVerdictBlock`): dispatched prompt opens with version, per-leaf actuals, bar window, signal ids, and the dispatch's own run id; stored prompt rewritten post-dispatch via `HeadlessTaskRegistry.setPrompt` (scanner `rewritePrompt` dep, wired in `service.ts`). Stale turns detect themselves via `watchVersion`.
- [x] Stale-version verdict rejected: `expectedWatchVersion` mismatch → `invalid` (`mutate.ts`), covered at tool + HTTP layers (`issue-tools.spec.ts`, `routes/issues.spec.ts`).
- [x] Switch ON + OFF verified: monitor-staged proposals use the identical `tradingPush` gate, no origin bypass (`trading.spec.ts`: OFF refuses, ON executes).
- [x] Paper sweep green, account left flat — `alpaca-paper` (Alpaca paper, equity $99,687.77, market CLOSED 2026-09-11 02:1x EDT): `pnpm test:live:alpaca-paper` 2 files / 8 passed / 8 skipped (fill-flow + TPSL-bracket skipped market-closed; limit stage→commit→push→cancel + aliceId search/quote/details green). Baseline vs post-run identical: 0 positions, same 2 pre-existing BAC/JPM open orders untouched.
- [x] Stop-move (`modifyOrder`) exercised on paper with venue-truth finding: staged modify reaches the venue and Alpaca answers `42210000 cannot replace order in accepted status` — a venue race (order still in `accepted`, not yet `new`), confirmed by immediate `getOrder` (`accepted`) vs seconds-later poll (`Submitted`). Test residue cancelled through Alice; account back to baseline (2 pre-existing orders, 0 positions, staging clean). Finding filed as #27 (retry-after-settle or map 42210000 to a retryable modify response; S4 currently has no modify coverage on Alpaca). Market-hours fill + TPSL legs still need an open-market run.
- [x] Live-venue read path proven on `binance-main` (read-only, crypto 24/7 so no market-hours gate): federated `BarService` UTA branch over live UTA HTTP discovers `binance-ea409010|BTC/USDT` (`realtime`, `crypto`), `getBars(1h×5)` returns fresh bars (`stale:0`, `latest:true`, ~1.1s). Full `checkWatch` end-to-end on live bars: `price_above 70000` → hit (actual 77252.86), `price_below 80000` → hit, `ema_alignment bullish` → miss (actual `mixed`) — verdict + evidence + `dataAsOf` all real, zero writes (binance wallet status clean, no staging).

### 4. Operation UI (decisions AA: independent pause switch + read-only detail section)

- [x] `watchPaused` frontmatter switch: plan + latch preserved, dispatch suppressed, resume continues the same arming (declaration/mutate/change-tracker/tool/route; scanner `noteWatchPaused`; health reads paused as healthy).
- [x] `watchState` projected on board/detail/schedule markers (`IssueFiringMarkers.watchState` → `detailIssue`/`snapshotBoardIssue`/`ScheduleSnapshotTask`); UI `IssueWatch`/`WatchRuntimeState` types on `api/issues.ts` + `api/schedule.ts`.
- [x] Detail `WatchSection` (read-only): human-readable conditions (`watch-summary.ts`, shared with the board badge), last check + status/reason, last trigger, next step (health message), analysis-run link (`lastRunId` → open run; waiting note when the run record is absent); pause/resume button via `PATCH {watchPaused}` + re-arm hint, no rule editor.
- [x] Board `paused` badge on watched+paused rows only; no sort change.
- [x] i18n `issues.watch.*` + `issues.detail.monitoring` + `mutationField.watch/watchPaused` in en/zh/ja/zh-Hant; Activity renders pause/condition changes via the generic mutation path.
- [x] Demo: `thesis-watch` carries `watch` + `watchState` on issues + schedule fixtures; demo PATCH accepts `watchPaused` (400 otherwise).
- [x] Real browser route walk (`pnpm -F open-alice-ui dev:demo`, headless Chrome 1440px, zero page errors): Issues → `thesis-watch` detail shows Monitoring (conditions / last check+status / last trigger / next step + `demo-run-thesis-2` link); pause → `Monitoring paused` + Resume button; board row shows `paused` badge beside Healthy while paused; resume → verdict message restored. Screenshots in run notes (not committed).

## Verification

```text
npx tsc --noEmit
pnpm vitest run src/domain/analysis/technical-analysis/watch src/workspaces/schedule/scanner.spec.ts src/workspaces/issues/declaration.spec.ts src/workspaces/issues/mutate.spec.ts
pnpm test:changed
```

Full `pnpm test` on cross-owner touch (scanner + issues + analysis). Paper-trading lane per [[docs/uta-live-testing.md]] for increment 3, account left flat. UI increment adds `cd ui && npx tsc -b` + real browser route.

## Completion

Delete this file and its `PLANS.md` bullet in the same change that records acceptance. Do not keep a Completed section or archive.
