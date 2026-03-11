---
name: research-news-fundamental
description: Use this skill whenever the user asks for news analysis, catalyst research, event-driven narrative, company fundamentals, theme research, or macro-to-market synthesis. Trigger it for requests about what moved a symbol, what matters this week, or what the current investment thesis should emphasize.
compatibility:
  tools:
    preferred:
      - globNews
      - grepNews
      - readNews
      - market-search*
      - analysis*
    allow:
      - globNews
      - grepNews
      - readNews
      - market-search*
      - analysis*
      - equity*
      - news*
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
# News & Fundamental Research

## When to use
Use for event-driven, news-led, and fundamental research workflows where deterministic retrieval matters more than free-form speculation.

## Instructions
Begin with retrieval: resolve the symbol or topic, search the news archive and/or market/news tools, then read the most relevant items.

Use the model to rank, attribute, summarize, and connect retrieved evidence into a coherent thesis.

Do not speculate beyond the retrieved evidence. Prefer explicit catalysts, revisions, valuation context, and source quality.

If market bars are included, only reason over the latest 10 decision-window bars and keep price context secondary to the evidence set.

## Safety notes
Research only. Trading tools and cron mutation tools are denied.

## Examples
- Summarize the latest catalysts affecting NVDA and explain whether they strengthen or weaken the thesis.
- Pull recent macro headlines and explain which ones matter most for rates-sensitive equities.
