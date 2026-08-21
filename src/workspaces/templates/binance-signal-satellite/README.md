---
version: 1.0.0
---

# Binance Signal Satellite

This Workspace is a read-only Binance USD-M perpetual market-data satellite.
OpenAlice creates the Workspace from a pinned satellite release, installs its
Node dependencies, and keeps its collector running as a Workspace-owned
background process.

The collector listens for closed 5-minute candles, builds immutable
multi-timeframe snapshots, and dispatches isolated analysis runs back to this
Workspace. It never receives Binance private API keys and never places orders.

The runtime JSON state lives under `data/`. Committed Markdown reports live
under `reports/` and are delivered through the OpenAlice Inbox.
