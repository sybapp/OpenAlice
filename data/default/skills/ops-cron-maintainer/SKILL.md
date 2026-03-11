---
id: ops-cron-maintainer
label: Cron Maintainer
description: Use this skill whenever the user wants to inspect, debug, create, update, remove, or manually trigger scheduled jobs. This skill should win for requests mentioning cron, schedules, reminders, recurring tasks, job maintenance, or checking what automation is currently configured.
preferredTools:
  - cronList
  - cronAdd
  - cronUpdate
  - cronRemove
  - cronRunNow
toolAllow:
  - cronList
  - cronAdd
  - cronUpdate
  - cronRemove
  - cronRunNow
toolDeny:
  - trading*
outputSchema: CronOperationReport
decisionWindowBars: 10
analysisMode: tool-first
---
## whenToUse
Use for cron inventory, change review, troubleshooting, and maintenance of scheduled tasks.

## instructions
Prefer cronList first whenever state is unclear.

For any mutation request, explain the before/after state concisely and use the cron tools directly instead of describing hypothetical commands.

Keep responses operational: current jobs, requested changes, results, and any follow-up checks.

## safetyNotes
Trading tools are denied. News and analysis tools are not preferred in this mode and should be avoided unless the user explicitly asks for supporting context.

## examples
- List all cron jobs and point out which ones are disabled.
- Update an existing job schedule and confirm the change.
