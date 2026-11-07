---
name: multica-office
description: "Use when the deliverable is an office file someone else will open — docx/xlsx/pptx/pdf (报告、周报、台账、汇报、扫描件): format choice, layout rules, and the generate→verify→hand-off loop. Not for chat about documents."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Office deliverables

A file that opens wrong is worse than no file: the member forwards it, a
customer sees it, and the mistake is now theirs. This skill is the discipline
between "content exists" and "content survives Word, Excel, PowerPoint, or a
printer".

Deliver into the issue (file in a comment, or the project's collaboration
directory) and say what you produced, where it is, and what you checked.

## 1. Pick the format before writing a word

| The member wants | Produce | Why not the others |
| --- | --- | --- |
| Something to read, sign, or archive | **PDF** | Reflows nowhere; fixed layout |
| Something they will edit again | **docx** | Editable headings, tracked changes |
| Numbers they will re-calculate | **xlsx** | Live formulas, their own pivots |
| Numbers to present once | **pptx** (or an xlsx chart pasted in) | Deck, not a model |
| A deck for a room | **pptx** | Never a docx printed landscape |
| A form to fill | **PDF** with fields, or xlsx | Not a docx table |

If the request is ambiguous, choose editable (docx/xlsx) and say why in one
clause. Never ask the member to pick between formats they did not know were
different.

## 2. The three rules that cover most failures

1. **The file is checked by opening it, not by writing it.** Re-read the
   produced file before claiming done — extract its text, count pages/sheets,
   confirm the formulas still compute. "I generated the file" is not evidence.
2. **Placeholders are defects.** `TODO`, `Lorem`, `{{name}}`, `#REF!`,
   `NaN`, an empty chart series — each one is a bug, not a draft state.
3. **Numbers carry their unit and their date.** A table of money without
   currency, a chart without a period, a percentage without a base — all three
   get misread. Fix them at generation time; the member will not.

## 3. Per-format discipline

**docx** — one `Heading 1` per section, no manual bold-as-heading; a table of
contents only when the document exceeds ~5 pages (and then update its fields);
page numbers in the footer; no heading as the last line of a page.

**xlsx** — one header row, no merged cells inside the data range; formulas over
hard-coded results where the member will re-run; a units row or column header
(`万元`, `%`) rather than a note at the bottom; freeze the header; one sheet per
question, not one sheet per department.

**pptx** — one assertion per page as the title, not a topic label ("Q3 毛利下滑
主要来自原料涨价" beats "Q3 毛利分析"); every number traceable to the appendix or
the model it came from; speaker notes carry the argument you would say out loud,
not a copy of the slide.

**pdf** — for a scanned source, OCR first and say so; never silently reflow a
paged original; merging files preserves page order and bookmarks; a filled form
keeps its field structure instead of being flattened into text.

## 4. Hand-off

Close with three lines: **what** (one sentence), **where** (file name and
location), **checked** (what you verified). If a requirement could not be met —
a font missing, a chart that will not render, a page count the member asked
for — say it here. Do not let them discover it.

`references/office-checks.md` has the per-format verification checklist. Open it
when you are about to declare an office file finished.
