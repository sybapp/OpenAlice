# Milestone A: Engine Runtime Boundary

OpenAlice is moving toward an OpenClaw/AgentSkill-native runtime model where session execution is an explicit pipeline rather than a hybrid engine with embedded special cases.

## Target model

For session-based execution, the runtime boundary is:

1. `local-command` handlers
2. `agent-skill` handlers
3. `provider-route` handlers

Each step receives the same session request contract and may either:
- decline and pass control onward, or
- terminate the request with a concrete result/stream.

## Why this matters

Before this slice, `Engine` directly knew about:
- slash/local commands
- script-loop skill execution
- provider fallback

That made the core runtime feel like a hybrid with one special skill-loop side path.

After this slice:
- `Engine` owns orchestration of a session runtime pipeline
- local command handling is one runtime step
- AgentSkill/script-loop execution is one runtime step
- provider routing is the terminal runtime step
- bootstrap decides the concrete pipeline composition

## What Milestone A does not finish

This milestone does **not** yet make the entire project AgentSkill-native. It leaves these follow-ups:
- unify script-loop naming and contracts with broader AgentSkill terminology
- make cron/heartbeat/job execution choose runtime steps more declaratively
- reduce remaining provider-specific assumptions in higher-level runtime entrypoints
- continue migrating skill registry/runtime metadata toward project-wide ownership boundaries
