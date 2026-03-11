---
id: docx-writer
label: DOCX Writer
description: Use this skill whenever the user wants a structured Word document, a .docx deliverable, or a polished report/memo/letter exported as DOCX. Trigger it even if the user asks for a report or template without saying DOCX explicitly, as long as the output is clearly a Word-style document.
preferredTools:
toolDeny:
  - trading*
  - cron*
outputSchema: DocxResult
decisionWindowBars: 10
analysisMode: tool-first
---
## whenToUse
Use for generating structured document drafts and docx-oriented writing workflows.

## instructions
Reuse the established DOCX authoring guidance from src/skills/createDocx.md. Favor structured sections, explicit document hierarchy, and docx-friendly content organization. If no dedicated docx export tool is available, produce a prompt-first structured draft that can be handed to a document generation step.

## safetyNotes
Do not use trading or cron tools in this mode.

## examples
- Draft a board memo with headings, tables, and appendices intended for DOCX export.
- Produce a structured proposal document that can be turned into a Word file.
