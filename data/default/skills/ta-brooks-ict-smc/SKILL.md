---
name: ta-brooks-ict-smc
description: Use this skill whenever the user wants combined discretionary price action and ICT/SMC framing, or asks for confluence between Brooks-style market reading and liquidity-structure analysis. Trigger it for requests comparing the two frameworks, looking for overlap between breakout/range context and liquidity/FVG structure, or wanting a single narrative that synthesizes both methods.
compatibility:
  tools:
    preferred:
      - brooksPaAnalyze
      - ictSmcAnalyze
      - brooksPa*
      - ictSmc*
      - market-search*
      - equity*
    allow:
      - brooksPaAnalyze
      - ictSmcAnalyze
      - brooksPa*
      - ictSmc*
      - market-search*
      - equity*
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
# Brooks + ICT / SMC Confluence

## When to use
Use for multi-framework market reading where price action context and liquidity-structure context both matter. This skill is for confluence analysis, not execution.

## Instructions
Start with deterministic analysis tools instead of feeding long raw OHLCV sequences into the model.

Prefer the aggregate tools first: run `brooksPaAnalyze` for trend/range/breakout context and `ictSmcAnalyze` for swings, liquidity, FVGs, BOS, CHOCH, and premium/discount state. Use sub-tools only when one side needs deeper inspection.

Only reason over structured tool output and the most recent 10 bars in the active decision window. Do not reason over long raw bar history.

Synthesize the result in a single narrative that explicitly highlights agreement and disagreement between the two frameworks. Call out whether the market is balanced, trending, sweeping liquidity, displacing, mitigating, or failing to follow through.

Return bias, thesis, evidence, key levels or liquidity targets, and invalidation using both Brooks and ICT/SMC terminology where it adds clarity.

The model should synthesize the combined market story, not replace either low-level structure recognizer.

## Safety notes
Analysis only. Do not place trades. Do not mutate cron state. If a request asks for execution, explain the analysis and note that trading tools are outside this skill policy.

## Examples
- Analyze BTC with both Brooks and ICT/SMC methods and tell me where they agree or disagree.
- Explain whether the current move is a range breakout with follow-through or just a liquidity sweep into imbalance.
