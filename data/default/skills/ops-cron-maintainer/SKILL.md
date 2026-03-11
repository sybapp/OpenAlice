---
name: ops-cron-maintainer
description: Use this skill whenever the user wants to inspect, debug, create, update, remove, or manually trigger scheduled jobs. This skill should win for requests mentioning cron, schedules, reminders, recurring tasks, job maintenance, or checking what automation is currently configured.
compatibility:
  tools:
    preferred:
      - cronList
      - cronAdd
      - cronUpdate
      - cronRemove
      - cronRunNow
    allow:
      - cronList
      - cronAdd
      - cronUpdate
      - cronRemove
      - cronRunNow
    deny:
      - trading*
outputSchema: CronOperationReport
decisionWindowBars: 10
analysisMode: tool-first
---
# Cron Maintainer

## When to use
Use for cron inventory, change review, troubleshooting, and maintenance of scheduled tasks.

## Instructions
Prefer cronList first whenever state is unclear.

For any mutation request, explain the before/after state concisely and use the cron tools directly instead of describing hypothetical commands.

Keep responses operational: current jobs, requested changes, results, and any follow-up checks.

## Safety notes
Trading tools are denied. News and analysis tools are not preferred in this mode and should be avoided unless the user explicitly asks for supporting context.

## Examples
- List all cron jobs and point out which ones are disabled.
- Update an existing job schedule and confirm the change.
