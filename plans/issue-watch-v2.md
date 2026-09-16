# Plan: Watch v2 — named contexts, cheap volume, closed-bar touch

**Status:** active — Phase 3 complete; Phase 4 next
**Owner guides:** [[docs/workspace-issues-and-scheduling.md]], [[docs/market-data-architecture.md]]
**Base:** `plans/issue-watch-monitor.md` (v1 contract + increments 1–4). This file covers v2 expansion only; v1 file stays the contract until acceptance.
**Delivery:** feature-branch iteration. No PR until maintainer accepts.
**Related code:** `src/domain/analysis/technical-analysis/watch/{spec,eval,check,freshness,identity}.ts`, `src/domain/analysis/technical-analysis/{indicators.ts,order-flow/}`, `src/workspaces/schedule/{scanner,declaration,watch-state}.ts`, `src/domain/market-data/bars/{types,bar-service}.ts`

## Goal

Add the four v1-excluded capabilities as three independent mechanisms (no "Watch v2 big-bang"):

1. **Named contexts** — multi-source + cross-interval via one fetch fan-out mechanism.
2. **Volume layers** — cheap (reuse loaded bars) vs intrabar (two-phase, budgeted).
3. **Closed-bar touch** — `price_touch` event leaf on already-loaded bars; realtime quote stays a separate plan.

Non-goal: realtime/quote source, scanner tick change, bar-layer realtime semantics (Phase 5, separate plan).

## Locked decisions (from review)

1. **`combine(all/any)` unchanged.** All four capabilities are "new leaf types + new context dimension"; combination algebra is orthogonal to leaf type.
2. **Additive-only schema evolution.** `watch.version` is the plan version (stale-plan guard), not a schema version. Everything below is optional (`sources?`, new union members, wider enums) so old files validate unchanged under `strict`.
3. **Order: Phase 1 → remaining Phase 0 seams → 2 → 3 → 4 → 5.** Existing `watchLeaves` and the dependency table covered Phase 1; defer `WatchContext` and per-context dependency extraction until Phase 2, when they have a consumer.

## Phase 0: internal seams (partially complete; finish with Phase 2)

Extract in `watch/`:

- `watchLeaves(rule: WatchRule): WatchLeaf[]` in `spec.ts` — replaces the two inline `'all' in rule` splits (`check.ts:91`, `eval.ts:321`).
- Dependency table with exhaustiveness guard:
  ```ts
  type WatchLeafDataKind = 'price' | 'indicators' | 'priceAction';
  const watchLeafDataKind = {
    price_above: 'price', /* …all 11 v1 leaves… */
  } satisfies Record<WatchLeafType, WatchLeafDataKind>;
  ```
  `WatchLeafType = WatchLeaf['type']`; a new leaf without a table entry fails compilation.
- `needsPriceAction(leaf: WatchLeaf): boolean` — owns the `price_vs_vwap` auto/structure special case now buried in `check.ts:99-103`. `check.ts` calls the table + this function, no more inline type lists.
- `evalLeaf` switch gains `assertNever` default so schema-added-but-unevaluated leaves throw loudly instead of returning `undefined`:
  ```ts
  function assertNever(value: never): never { throw new Error(`Unsupported watch leaf: ${String(value)}`); }
  ```
- `WatchContext` type introduced (single-source shape first, map later):
  ```ts
  type WatchContext =
    | { status: 'ready'; bars: OhlcvBar[]; indicators?: TechnicalAnalysisIndicatorResult; priceAction?: PriceActionAnalysisResult }
    | { status: 'unavailable'; reason: string };
  ```
  Evaluator reads `ready` contexts; `unavailable` contexts yield leaf-level `unavailable` with reason (never guessed from `undefined`).

Verification: `npx tsc --noEmit` + existing `watch/` specs green, zero behavior change.

## Phase 1: closed-bar touch (`price_touch`) — complete

New leaf, no fetch change, no `quote` change (`closed_bar` stays):

```ts
const priceTouchSchema = z.object({
  type: z.literal('price_touch'),
  price: z.number().finite(),
  /** How many of the most recent closed bars may overlap the level (default 1). */
  lookbackBars: z.number().int().min(1).max(500).optional(),
}).strict();
```

Semantics (locked):

- Overlap test on each of the last `lookbackBars` closed bars: `bar.low <= price && bar.high >= price` (same overlap idiom as `zone_touch` internals).
- Comparison is inclusive (`<=`/`>=`); equality touches.
- Forming bars always excluded (existing closed-bar gate decides, unchanged).
- `price_above/below/range/cross` keep `field: close` only — `lookbackBars` does **not** spread to state leaves.
- `quote: { kind: 'closed_bar' }` unchanged. Rejected alternative: `quote: { kind: 'full_range' }` — reads as realtime quote, misleading.
- Latch: `price_touch` is an **event leaf** (like `structure_break`), not state: signal-less, so per-leaf latch rule applies — hit dispatches once per arming; a `miss` (no bar in window overlaps) clears the latch so a later touch re-fires; `unavailable` preserves the latch (data gap is not an exit).
- Re-arm semantic: "window contains no touch, then a later window does" (window-based, not "price left and returned" — the latter is unobservable from overlap alone and must not be promised).
- Dependency table entry: `'price_touch': 'price'`. No indicator/priceAction cost.
- Touch + intraday interval ⇒ `superRefine` requires `freshness.maxStaleMinutes` (touch without a minute bound is a false-positive machine).

Verified: equality boundary, lookback window, forming-bar exclusion, and missing `maxStaleMinutes` on intraday ⇒ invalid file. Existing generic signal-less scanner coverage verifies latch clear-on-miss / preserve-on-unavailable.

## Phase 2: named contexts (multi-source + cross-interval)

One mechanism: fetch key is `(barId, interval)`; N sources = N contexts.

### Schema

```ts
// SourceSpec = existing watchSourceSchema content (barId + interval + assetClass?)
source: SourceSpec;                  // always the `default` context; unchanged
sources?: Record<string, SourceSpec>; // keys: ^[a-z][a-z0-9-]{0,31}$, max 4, `default` forbidden
```

Leaf gains `source?: string` (default `"default"`). Normalization (single function, `spec.ts`):

```ts
{ default: watch.source, ...watch.sources }
```

Compatibility rules (all schema-enforced, invalid file otherwise):

- `sources` max 4 named (+ default = max 5 contexts).
- Leaf `source` referencing an absent name ⇒ invalid.
- `sources.default` key ⇒ invalid (default comes only from `source`).
- `sources.X` identical `(barId, interval)` to `default` ⇒ invalid (copy-paste guard).
- Two named sources sharing one `(barId, interval)` fetch once (dedupe by pair, fan out to both names).

### Check path

- Fetch per unique `(barId, interval)` with existing `WATCH_CHECK_BARS` count, concurrency cap 4, total bar cap 5×200. Each fetch failure is caught **per context** → `{ status: 'unavailable', reason }`, never a whole-check reject (no bare `Promise.all`).
- Per-context freshness gate (existing rules already split by interval: intraday `maxStaleMinutes`, daily/weekly trading-day).
- Per-context selective compute: the Phase-0 dependency table evaluated per context's leaves (a context whose leaves are all `price` pays no indicator/priceAction cost).
- `WatchEvalInput` becomes `Map<string, WatchContext>`; `evalLeaf` resolves `input.get(leaf.source ?? 'default')`. `combine()` untouched.
- Typical use is multi-timeframe confirmation: `all: [{price_cross_above, source: 'h1'}, {ema_alignment, source: 'd1'}]`.

### Partial failure truth table

| Context A leaf | Context B leaf | `all` | `any` |
|---|---|---|---|
| hit | unavailable | unavailable | **hit** |
| miss | unavailable | unavailable | unavailable |
| unavailable | unavailable | unavailable | unavailable |

Rationale: `any` with a hit is decided regardless of the gap. In every other row an unavailable leaf remains visible because the final condition cannot be fully established. This matches the existing `combine()` precedence (`all`: hit → unavailable → miss; `any`: hit → unavailable → miss); no combination-algebra change is needed.

### Evidence + latch

- Evidence groups per source: `evidence.contexts: Record<sourceName, { close?, barFrom?, barTo?, barCount? }>`; top-level legacy `close/barFrom/barTo/barCount` mirror `default` for backward-compat display. Per-leaf evidence carries `{ source, fidelity? }` (see Phase 3/4).
- Signal ids namespaced: `${sourceName}|${identity}` for **non-default** sources only; `default` keeps the bare `identity.ts` format. No migration: v1 watch/state never shipped (branch-only per `watch-state.ts` header + plan decision 4), so unprefixed persistence has no released reader.

Budgets (locked): max 5 contexts, max 1000 total bars/check, max 4 concurrent fetches, intrabar budget defined in Phase 4.

Specs: dedupe (shared pair = 1 fetch), per-context failure → leaf `unavailable` + `any`-hit still fires, `all`-miss dominates, evidence grouping, non-default namespace ids, invalid files (unknown source ref, `default` key, duplicate pair, 5th source).

## Phase 3: cheap volume (zero new fetch)

Reuse the already-loaded 200 closed bars. All unavailable when no positive volume in window (same posture as VWAP-no-volume today):

| Leaf | Params | Basis |
|---|---|---|
| `volume_spike` | `lookback: 1..199 (default 20)`, `multiplier > 1 (default 2)` | last-bar volume vs mean of prior `lookback` |
| `cvd_slope` | `direction: rising/falling`, `lookback` | bar-proxy CVD (`sign(close-open) × volume` cumulative; `OrderFlowFidelity = 'bar_proxy'` per `order-flow/summary.ts`) |
| `price_volume_divergence` | `kind: bullish/bearish`, `lookback` | existing `order-flow/divergence.ts` over loaded bars |

- Dependency table: all three `'price'` (volume rides on bars; no new context kind).
- Fidelity: per-leaf evidence `{ fidelity: 'bar_proxy' }`; verdict copy for proxy hits uses "suggests/possible" language — proxy is heuristic, never reported as measured flow.
- Latch: `volume_spike` event (signal-less, miss-clears); `cvd_slope`/`divergence` state (hold semantics).

## Phase 4: intrabar order-flow (budgeted, two-phase)

Candidate leaves (all `fidelity: 'intrabar'`, explicit opt-in per leaf): `absorption {side}`, `exhaustion {side}`, footprint-derived threshold (exact set fixed at implementation; mechanism below is leaf-agnostic).

- **Trigger:** `loadIntrabarWindow` (`order-flow/intrabar-window.ts`) per context that has an intrabar leaf, capped at 500 intrabar bars/context and only from contexts already loaded in phase one.
- **Two-phase truth table** (locked):

| Rule | Cheap phase result | Fetch intrabar? | Final status if intrabar skipped/unavailable |
|---|---|---|---|
| `any` | any cheap leaf hit | No | hit (decided) |
| `any` | cheap all miss/unavailable | Yes iff an intrabar leaf could still decide | intrabar decides; unexecuted expensive leaf marked `not_evaluated`, never `unavailable` |
| `all` | any cheap leaf miss | No | miss (decided) |
| `all` | cheap all hit | Yes | intrabar decides |
| `all` | any cheap leaf unavailable, rest hit | No | unavailable (can never confirm all) |

- **Unexecuted ≠ unavailable.** A skipped expensive leaf is reported as `status: 'not_evaluated'` (a report-only status, distinct from `unavailable`) with reason `cheap phase decided first`. The evaluator passes only actually evaluated leaves to the unchanged `combine()` function; skipped leaves remain in evidence/prompt output. If the cheap phase cannot decide the rule, the expensive phase must run or return an explicit `unavailable` context — it may not manufacture a final result from `not_evaluated` leaves.
- **Signal identity:** event-type (one id per detected bar event, `identity.ts` style: `absorption|<barDate>|<side>|<price>`), namespaced per Phase 2; latch follows signal-bearing rules.
- **Budget:** intrabar fetch only runs when the truth table says Yes; max 500 bars/context; cheap-miss is the common case so most checks pay zero intrabar cost.

## Phase 5: realtime quote (separate plan, not designed here)

Explicitly out: quote-source type, second-level freshness, forming-bar dedup, scanner tick change. Phase 1's `closed_bar` touch must not be presented as covering it.

## Cross-cutting verification

- Each phase: `npx tsc --noEmit`, `watch/` + `scanner.spec.ts` + `issues/` specs, `pnpm test:changed`; cross-owner touch escalates to full `pnpm test` per AGENTS.md ladder.
- Phase 2/4 add replay specs with faked `BarService` (multi-context success/partial-failure; two-phase skip/fetch matrix).
- Docs: `docs/workspace-issues-and-scheduling.md` watch row + `self-scheduling/SKILL.md` gain per-phase authoring guidance (`sources`, `maxStaleMinutes` for touch, `since`/narrow lookbacks unchanged, proxy-vs-intrabar language).

## Completion

Land phases as verified commits on the v1 branch (or its successor after v1 acceptance); update this file per increment. On full acceptance, fold the durable contract into [[docs/workspace-issues-and-scheduling.md]] and delete this file + its `PLANS.md` bullet in the same change (per [[PLANS.md]] contract).
