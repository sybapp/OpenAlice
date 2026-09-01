---
name: alice-analysis
description: >
  Use OpenAlice K-line analysis for technical or quantitative price questions:
  source discovery, unified market structure and Delta Proxy context, indicators,
  multi-timeframe reads, dated snapshots, simulations, and custom Quant
  Calculator expressions. Trigger for RSI/MACD/EMA/VWAP/Fibonacci, FVG/iFVG,
  order blocks, BOS/CHoCH, liquidity, delta/CVD, volume profile, correlations,
  z-scores, and historical price-path questions.
---

# Alice K-line analysis

All commands use an explicit `barId`. Discover one first, then choose the
smallest verb that answers the question.

```bash
alice analysis search-bars --query AAPL
alice analysis technical-analysis --bar-id 'tradingview|NASDAQ:AAPL' --interval 1h --count 200
```

## Choose the source

Prefer a returned broker source that matches the account being traded. Otherwise
use a paid vendor, then a delayed/free source. Treat `barCapability`, freshness,
coverage, and degradation metadata as part of the answer.

- Native sources such as `tradingview|NASDAQ:AAPL` and broker barIds infer
  routing; do not pass `assetClass` unless the source requires it.
- Compatibility vendor barIds such as `yfinance|AAPL` require
  `--asset-class equity` (or `crypto`, `currency`, `commodity`).
- TradingView accepts exchange-qualified symbols directly. Bare symbols such as
  `tradingview|AAPL` are resolved by search and can be ambiguous.
- Optional vendors only participate when enabled. Inspect or change them with
  `alice market vendors` and `alice market vendor-set --vendor <id> --enabled true`.

## Unified technical analysis

Use `technical-analysis` for one coherent descriptive read across Price Action,
the OHLCV-derived Delta Proxy, EMA/VWAP/Fibonacci, and confluence zones.

Supported target intervals are `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, and `1w`.

```bash
# One interval
alice analysis technical-analysis \
  --bar-id 'tradingview|NASDAQ:AAPL' \
  --interval 1h \
  --count 200

# Higher timeframe to execution timeframe; arrays are JSON CLI values
alice analysis technical-analysis \
  --bar-id 'alpaca-paper|AAPL' \
  --intervals '["4h","1h","15m"]' \
  --mode execution \
  --count 200
```

Modes:

- `context` (default): compact read; Price Action volume confirmation is off.
- `execution`: enables lower-timeframe confirmation and retains the latest five
  Delta Proxy bars.
- `debug`: returns raw delta bars and volume-profile bins.

The tool loads each target interval once, automatically selects a supported
intrabar interval, and caps intrabar work at 5,000 bars. Read
`requestedCount`, `actualCount`, `truncated`, `intrabarInterval`, and
`degradationReason` before using derived evidence.

Interpret the result as context, not a trade signal:

- `fidelity: bar_proxy` and `isApproximation: true` mean delta/CVD and profile
  use lower-timeframe OHLCV, not trades, tape, footprint, or order-book depth.
- `barCompletion: unknown` means the source contract cannot prove the latest
  bar is closed. Latest-bar absorption/exhaustion candidates remain provisional.
- Unavailable components include a reason such as missing intrabars, missing
  volume, insufficient coverage, or insufficient samples. Do not turn an
  unavailable component into neutral evidence.
- Multi-timeframe `bias`, `alignment`, `conflicts`, and `confluences` summarize
  the returned intervals; inspect the interval results for supporting facts.

Use runtime help for the current tuning schema instead of guessing flags:

```bash
alice analysis technical-analysis --help
```

Nested `--indicators` and `--price-action` values are JSON objects, for example:

```bash
alice analysis technical-analysis \
  --bar-id 'tradingview|NASDAQ:AAPL' \
  --interval 1h \
  --indicators '{"vwapAnchor":"week","atrPeriod":100}' \
  --price-action '{"marketStructureMode":"extreme","gapMode":"all"}'
```

## Quant Calculator

Use `quant` for custom scalar calculations or a labeled panel. The language is
bounded and side-effect-free: assignments followed by one result expression.

```bash
alice analysis quant --script $'s = bars("alpaca-paper|AAPL", "1d", count=250)\n{"rsi": rsi(s.close, 14), "vs_200ma": s.close[-1] - sma(s.close, 200)}'
```

`bars(barId, interval, count=, asOf=, start=, end=, asset=)` returns
`open/high/low/close/volume` series. Raw columns require indexing; indicator
functions already return their latest scalar.

- Trend: `sma`, `ema`, `macd`, `slope`
- Momentum: `rsi`, `roc`
- Volatility: `stdev`, `atr`, `bbands`, `zscore`
- Volume: `rvol`, `obv`, `mfi`, `vwap`
- Stats: `max`, `min`, `sum`, `average`, `median`, `highest`, `lowest`
- Comparison: `correlation`

Batch related calculations into one object instead of making repeated calls.
On a structured Quant error, follow its `suggestion`; common fixes are raising
`count`, removing `[-1]` from an indicator result, or replacing pandas syntax
with a listed function.

## Dated paths

- `snapshot`: dated, no-lookahead read with freshness metadata. Use for “what
  did this look like as of T?”
- `simulate`: one bounded entry/exit path with return, MFE, and MAE.
- `quant --dates true`: attach date axes when a custom calculation needs them.

Run `alice analysis <verb> --help` for the live flags before using either path.
