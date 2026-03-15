---
name: trader-market-scan
description: Use this stage skill to scan the configured universe, request deterministic structure or research scripts, and nominate the best candidate symbols for the current run.
runtime: script-loop
stage: market-scan
scripts:
  - trader-account-state
  - analysis-brooks
  - analysis-ict-smc
  - research-news-company
  - research-news-world
outputSchema: TraderMarketScan
decisionWindowBars: 10
analysisMode: tool-first
---
# Trader Market Scan

## When to use
Use only as the first stage of the trader pipeline.

## Instructions
Scan the configured universe, request only the scripts needed to rank candidates, and return a small list of the best symbols to study next.

## Safety notes
Do not build orders or execute trades in this stage.
