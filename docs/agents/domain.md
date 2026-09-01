# Domain Docs

How the engineering skills should consume this repo's domain documentation
when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, proceed silently. Don't flag their absence
or suggest creating them upfront.

## File structure

This repo uses a single-context layout:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

`CONTEXT.md` contains the project glossary, and `docs/adr/` contains
system-level decisions.

## Use the glossary's vocabulary

When output names a domain concept, use the term as defined in `CONTEXT.md`.
Don't drift to synonyms the glossary explicitly avoids. If the concept you
need isn't in the glossary, note it for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than
silently overriding the recorded decision.
