---
id: ta-ict-smc
label: ICT / SMC Structure
description: Use this skill whenever the user wants ICT or SMC framing: liquidity sweeps, fair value gaps, BOS, CHOCH, displacement, premium/discount, mitigation, or structure-based execution narrative. Trigger this skill even if the user asks indirectly for liquidity or imbalance analysis rather than naming ICT/SMC explicitly.
preferredTools:
  - ictSmcAnalyze
  - ictSmc*
  - analysis*
  - market-search*
toolAllow:
  - ictSmcAnalyze
  - ictSmc*
  - analysis*
  - market-search*
toolDeny:
  - trading*
  - cronAdd
  - cronUpdate
  - cronRemove
  - cronRunNow
outputSchema: AnalysisReport
decisionWindowBars: 10
analysisMode: tool-first
---
## whenToUse
Use for ICT/SMC structure analysis, liquidity targeting, imbalance reading, displacement quality, and narrative framing around swing structure.

## instructions
Run deterministic ICT/SMC structure tools first. Prefer ictSmcAnalyze as the main entry point, and use ictSmc* sub-tools when you need to inspect swings, liquidity, FVGs, or structure components directly.

Focus the narrative on liquidity pools, liquidity sweeps, fair value gaps, imbalance, BOS, CHOCH, mitigation, premium/discount, and invalidation.

Only consume structured signals plus the most recent 10 decision-window bars. Do not reason over long raw bar history.

The model should synthesize the structured market story and propose bias, thesis, evidence, and invalidation in ICT/SMC terms rather than replacing the structure detector.

## safetyNotes
Analysis only. Trading and cron mutation tools are denied in this mode.

## examples
- Identify likely buy-side or sell-side liquidity targets.
- Explain whether a move is displacement into imbalance or a weak sweep likely to revert.
