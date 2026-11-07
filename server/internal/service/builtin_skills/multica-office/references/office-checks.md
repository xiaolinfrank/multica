# Office verification checklist

Run the block for the format you produced. Every line is a thing that has been
observed to reach a customer unnoticed.

## All formats

- [ ] The file opens without a repair prompt in its real application (not just
      in the library that wrote it).
- [ ] Text extracted from the finished file contains no `TODO`, `Lorem`,
      `{{`, `XXX`, `#REF!`, `NaN`, `None`, `undefined`.
- [ ] Every number has a unit and a period.
- [ ] The file name says what it is and when: `2026-11_销售周报_v3.xlsx`, not
      `output.xlsx` / `新建文档(2).docx`.
- [ ] The member was told what was checked and what was not.

## docx

- [ ] Heading styles used, not manual bold+size; outline shows the sections.
- [ ] Table of contents present when >5 pages, and its page numbers match.
- [ ] Page numbers in the footer; header repeated on each page if tabular.
- [ ] No heading stranded at the bottom of a page; no table split without a
      repeated header row.
- [ ] Images at their intended aspect ratio (not stretched to fill a cell).

## xlsx

- [ ] Header row frozen; no merged cells inside the data range.
- [ ] Formulas, not pasted values, wherever the member will change an input —
      and the workbook recalculates to the numbers you quoted.
- [ ] One sheet per question; a `说明` sheet for assumptions, sources, and
      definitions of any calculated column.
- [ ] Units declared once in the header (`金额（万元）`), not per cell.
- [ ] No hidden columns carrying the only copy of a number.
- [ ] Print area and orientation set if the member will print it.

## pptx

- [ ] Every slide title is an assertion, readable on its own in the outline.
- [ ] No slide over ~6 bullets or ~40 words of body text.
- [ ] Charts label their axes and their period; no default legend like
      `Series1`.
- [ ] Speaker notes carry the spoken argument, not the slide text.
- [ ] Nothing overflows the slide edge — check the last row of every table.
- [ ] Deck opens on its title slide in presentation mode without a blank page.

## pdf

- [ ] Page count matches what you told the member.
- [ ] Text is selectable (a scan that was OCR'd, not an image-only page), or the
      member was told it is a scan.
- [ ] Bookmarks/outline present for anything over ~10 pages.
- [ ] Merged documents keep their original page order; nothing dropped between
      files.
- [ ] Filled forms keep their fields; signatures and stamps are not resampled
      into mush.
