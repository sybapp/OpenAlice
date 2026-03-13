---
name: ta-ict-smc
description: Use this skill whenever the user wants ICT or SMC framing: liquidity sweeps, fair value gaps, BOS, CHOCH, displacement, premium/discount, mitigation, or structure-based execution narrative. Trigger this skill even if the user asks indirectly for liquidity or imbalance analysis rather than naming ICT/SMC explicitly.
compatibility:
  tools:
    preferred:
      - ictSmcAnalyze
      - market-search*
    allow:
      - ictSmcAnalyze
      - market-search*
    deny:
      - trading*
      - cronAdd
      - cronUpdate
      - cronRemove
      - cronRunNow
outputSchema: AnalysisReport
decisionWindowBars: 10
analysisMode: tool-first
---
# ICT / SMC Structure

## When to use
Use for ICT/SMC structure analysis, liquidity targeting, imbalance reading, displacement quality, and narrative framing around swing structure.

## Instructions
Run deterministic ICT/SMC tools first. Prefer `ictSmcAnalyze` as the single entry point. The tool returns **v2 layered output**:
- `core`: stable fields intended for trading decisions / programmatic use
- `detailed`: full deterministic breakdown intended for UI, debugging, and post-trade review

Default to `detailLevel: full` for human analysis. For automated/trading-mode decisions, prefer `detailLevel: core`.

Focus the narrative on liquidity pools, liquidity sweeps, fair value gaps, imbalance, BOS, CHOCH, mitigation, premium/discount, and invalidation.

Only consume structured tool output and the decision-window bars included in the output. Do not reason over long raw bar history.

## Safety notes
Analysis only. Trading and cron mutation tools are denied in this mode.

## Examples
- Identify likely buy-side or sell-side liquidity targets.
- Explain whether a move is displacement into imbalance or a weak sweep likely to revert.
