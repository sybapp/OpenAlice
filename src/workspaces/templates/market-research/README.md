---
version: 0.1.0
---

# Market Research

A replayable research workspace for technical analysis and, incrementally,
fundamental analysis. It collects OpenAlice market data into versioned snapshots,
runs deterministic evaluators over those snapshots, and renders auditable reports.

## Workflow

```text
collect -> snapshot -> analyze -> result -> report -> Inbox
```

The satellite repository contains the commands and evaluator tests. OpenAlice
supplies K-lines through `alice analysis bars`, fundamentals through `traderhub`,
and report delivery through `alice-workspace inbox push`.

Order-flow conclusions are OHLCV bar proxies, not tick or order-book data. Keep
the returned fidelity, coverage, confidence, and degradation metadata visible in
reports.

## Local Development

Set `MARKET_RESEARCH_LAB_DIR` to a local clone of the satellite repository before
creating the workspace. Without the override, OpenAlice maintains a mirror of
`TraderAlice/Market-Research-Lab` under the launcher root.
