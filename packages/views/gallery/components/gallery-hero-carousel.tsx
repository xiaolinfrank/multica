"use client";

/**
 * The gallery's opening spread: the plates a work was delivered with, shown
 * one at a time above the catalogue.
 *
 * These are figure plates, not banners. Each is a 1536x864 painting whose
 * smallest labels sit near the legibility floor, so every decision here serves
 * reading them: the plate keeps its whole frame, all chrome sits off the
 * artwork, nothing auto-advances, and "看大图" is a first-class control rather
 * than a hover secret — the dialog caps at 1600px, which is where a 1536px
 * plate finally lands at native resolution.
 *
 * Titles and captions are committed content and stay untranslated, for the
 * same reason the works' own names do (see gallery-catalog.ts). Only the
 * chrome around them goes through i18n.
 */

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { UI_EASE_OUT, UI_MOTION_DURATION } from "@multica/ui/lib/motion";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { galleryAssetUrl } from "./gallery-asset-src";
import {
  GALLERY_DIAGRAM_HEIGHT,
  GALLERY_DIAGRAM_WIDTH,
  type GalleryWork,
} from "./gallery-catalog";
import { isDiagramNavKey, resolveDiagramKey, stepDiagramIndex } from "./gallery-hero-steps";

/**
 * How wide the plate is allowed to get.
 *
 * The cap is really about height — an uncapped 16:9 plate across a 1150px
 * column is 647px tall and buries the catalogue whose page this is — but it has
 * to be spelled as a width, because the box takes its height from the aspect
 * ratio. At 62svh the first work card's top edge still clears the fold on a
 * 900px window, and the 660px ceiling stops a tall monitor turning the plate
 * into a poster. Below the cap the plate simply fills the column.
 *
 * `svh`, not `dvh`: `dvh` changes when a mobile browser's URL bar collapses,
 * and this value drives the width of the plate and so the height of everything
 * under it — the one place a reflow mid-scroll would be most obvious.
 */
const PLATE_MAX_WIDTH = "calc(min(62svh, 660px) * 16 / 9)";

interface GalleryHeroCarouselProps {
  /** The work whose plates are on show. Its `diagrams` must be non-empty. */
  work: GalleryWork;
}

export function GalleryHeroCarousel({ work }: GalleryHeroCarouselProps) {
  const { t } = useT("gallery");
  // Canonical repo idiom: the hook returns null until hydration.
  const shouldReduceMotion = useReducedMotion() ?? false;
  const panelId = useId();
  const descriptionId = useId();
  const zoomDescriptionId = useId();
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  // Each plate fades in when its OWN bytes resolve, so paging during the first
  // load never lands on a blank stage. Gating all three on the lead looked
  // simpler and was wrong: the lead is the largest of the three files, so on a
  // throttled link it is the one most likely to finish last.
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Identity-stable once a plate is in, because the ref probe below re-runs on
  // every commit and a fresh Set each time would re-render forever.
  const markReady = (id: string): void => {
    setReady((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  const diagrams = work.diagrams ?? [];
  const total = diagrams.length;
  const active = diagrams[index] ?? diagrams[0];
  if (!active) return null;

  /**
   * Page the set.
   *
   * `moveFocus` is the tablist half of the APG pattern: an arrow key pressed
   * while a chip has focus carries focus to the newly selected chip, but the
   * same key pressed anywhere else in the spread leaves focus where the reader
   * put it. The chips stay mounted across the swap, so focusing straight away
   * is safe — `tabIndex={-1}` is still programmatically focusable.
   */
  const goTo = (next: number, moveFocus = false): void => {
    setIndex(next);
    if (moveFocus) chipRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // A modified arrow belongs to the browser or the OS — Ctrl+End jumps to the
    // end of the page, Cmd+Left goes back. Claiming those would be a hijack, so
    // check modifiers before the key, as attachment-preview-modal.tsx does.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (!isDiagramNavKey(event.key)) return;
    // Swallowed even when the move is blocked: an arrow at the last plate must
    // not fall through and scroll the page instead.
    event.preventDefault();
    const next = resolveDiagramKey(event.key, index, total);
    if (next === null) return;
    const fromChips =
      event.target instanceof Element && event.target.closest('[role="tablist"]') !== null;
    goTo(next, fromChips);
  };

  const previousIndex = stepDiagramIndex(index, -1, total);
  const nextIndex = stepDiagramIndex(index, 1, total);
  const position = t(($) => $.hero.position, { index: index + 1, total });
  const enlargeLabel = t(($) => $.hero.enlarge);

  const pager = total > 1 ? (
    <div className="flex shrink-0 items-center gap-0.5">
      <PlateArrow
        side="prev"
        label={t(($) => $.hero.previous)}
        onClick={previousIndex === null ? undefined : () => goTo(previousIndex)}
      />
      {/* aria-hidden: position is announced by the live region below, which
          also names the plate. "2 / 3" on its own tells a reader nothing. */}
      <span
        aria-hidden="true"
        className="min-w-10 text-center text-caption tabular-nums text-muted-foreground select-none"
      >
        {position}
      </span>
      <PlateArrow
        side="next"
        label={t(($) => $.hero.next)}
        onClick={nextIndex === null ? undefined : () => goTo(nextIndex)}
      />
    </div>
  ) : null;

  return (
    // Bound to the section, not the document: this spread is not modal, and a
    // page-wide arrow-key grab would fight the reader's own scrolling. The
    // modal precedent in attachment-preview-modal.tsx does not apply.
    <section
      aria-roledescription={t(($) => $.hero.roledescription)}
      aria-label={t(($) => $.hero.label)}
      onKeyDown={handleKeyDown}
      className="overflow-hidden rounded-xl border bg-card"
    >
      {/* Running head. Everything in it is constant across plates, so paging
          never reflows this row. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4 pb-3">
        {/* Not the usual `text-micro uppercase tracking-wide` eyebrow: this one
            carries a long Chinese product name, where uppercase does nothing
            and letter-spacing only loosens characters that are already square.
            A quiet caption reads as the label it is. */}
        <p className="min-w-0 flex-1 truncate text-caption font-medium text-muted-foreground">
          {work.name}
        </p>

        <div className="flex shrink-0 items-center gap-2">
          {pager}
          {/* Never hidden responsively: the narrower the window, the smaller
              the plate renders, and the more this is the control that matters. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => setZoomed(true)}
          >
            <Maximize2 aria-hidden="true" className="size-3.5" />
            {enlargeLabel}
          </Button>
        </div>
      </div>

      <span className="sr-only" aria-live="polite">
        {t(($) => $.hero.status, { index: index + 1, total, title: active.title })}
      </span>

      {/* A tab panel only when there are tabs to own it: a single-plate work
          renders the picker away (below), and a panel whose role points at a
          tablist that is not in the document is worse than a plain div.
          aria-label rather than aria-labelledby for the same reason — the chip
          it would name does not always exist. */}
      <div
        id={panelId}
        role={total > 1 ? "tabpanel" : undefined}
        aria-label={total > 1 ? active.title : undefined}
        className="mx-5 flex justify-center"
      >
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={t(($) => $.hero.open_diagram, { title: active.title })}
          aria-describedby={descriptionId}
          style={{ maxWidth: PLATE_MAX_WIDTH }}
          className={cn(
            "group relative block w-full cursor-zoom-in overflow-hidden rounded-lg",
            "aspect-[16/9] bg-surface ring-1 ring-surface-border",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {diagrams.map((diagram, diagramIndex) => {
            const isActive = diagramIndex === index;
            const isLead = diagramIndex === 0;
            return (
              <img
                key={diagram.id}
                // A cached plate can finish decoding before React commits
                // `onLoad`, which on a second visit would leave it invisible
                // forever — the probe is the only signal in that case. Block
                // body on purpose: React 19 reads a ref callback's return value
                // as a cleanup function.
                ref={(node) => {
                  if (node?.complete === true) markReady(diagram.id);
                }}
                src={galleryAssetUrl(diagram.file)}
                alt={diagram.title}
                width={GALLERY_DIAGRAM_WIDTH}
                height={GALLERY_DIAGRAM_HEIGHT}
                aria-hidden={!isActive}
                // All plates stay mounted so the browser decodes each once:
                // paging back and forth to compare two diagrams is the point of
                // the set, and a src swap flashes an empty well the first time.
                loading={isLead ? "eager" : "lazy"}
                fetchPriority={isLead ? "high" : "auto"}
                decoding="async"
                draggable={false}
                onLoad={() => markReady(diagram.id)}
                // A missing file must not strand the reader on a blank stage.
                onError={() => markReady(diagram.id)}
                style={
                  shouldReduceMotion
                    ? undefined
                    : {
                        transitionProperty: "opacity",
                        transitionDuration: `${UI_MOTION_DURATION.standard}s`,
                        transitionTimingFunction: `cubic-bezier(${UI_EASE_OUT.join(", ")})`,
                      }
                }
                className={cn(
                  "absolute inset-0 h-full w-full object-contain",
                  // The artwork is cream paper; on the dark canvas it reads as a
                  // light bomb. brightness() is multiplicative, so paper and ink
                  // scale together — the contrast nudge puts back the separation
                  // that dimming costs. Full brightness is restored in the
                  // dialog, where the plate owns the screen.
                  "dark:brightness-[0.9] dark:contrast-[1.06]",
                  isActive && ready.has(diagram.id) ? "opacity-100" : "opacity-0",
                )}
              />
            );
          })}

          {/* A corner pill, not a scrim. WorkCard blurs its whole thumbnail on
              hover; here the reader hovers to look closer, and greying out the
              diagram is exactly the wrong answer. */}
          <span className="pointer-events-none absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-background/85 px-2 py-1 text-caption text-foreground opacity-0 backdrop-blur-[1px] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
            <Maximize2 aria-hidden="true" className="size-3" />
            {enlargeLabel}
          </span>
        </button>
      </div>

      {/* Figure legend. The caption is the reading key — what the plate argues
          — not the title the artwork already carries, restated. The plate in
          words hangs off the frame for a reader who cannot see it. */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 pt-3 pb-5">
        <div className="min-w-0 max-w-2xl flex-1">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground">
              {t(($) => $.hero.figure, { index: index + 1 })}
            </span>
            {/* Deliberately not a heading: it changes with the plate, and a
                heading that mutates corrupts the page outline under the h1. */}
            <p className="min-w-0 text-title-sm font-semibold text-foreground">{active.title}</p>
          </div>
          {/* Pinned to two lines so the card does not jolt when a two-line
              caption pages to a one-line one. */}
          <p className="mt-1.5 line-clamp-2 min-h-10 text-body text-muted-foreground">
            {active.caption}
          </p>
          <span id={descriptionId} className="sr-only">
            {active.description}
          </span>
        </div>

        {total > 1 ? (
          <div
            role="tablist"
            aria-label={t(($) => $.hero.picker_label)}
            className="flex shrink-0 flex-wrap items-center gap-1"
          >
            {diagrams.map((diagram, diagramIndex) => {
              const isActive = diagramIndex === index;
              return (
                <button
                  key={diagram.id}
                  ref={(node) => {
                    chipRefs.current[diagramIndex] = node;
                  }}
                  type="button"
                  role="tab"
                  aria-controls={panelId}
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  data-active={isActive || undefined}
                  onClick={() => goTo(diagramIndex)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-caption transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    // Weight and foreground colour carry the selection, and the
                    // data-active:hover: compound is spelled out — hovering the
                    // selected chip must not demote it to a plain hover state.
                    "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    "data-active:bg-accent data-active:font-medium data-active:text-foreground",
                    "data-active:hover:bg-accent data-active:hover:text-foreground",
                  )}
                >
                  {diagram.shortTitle}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <Dialog
        open={zoomed}
        onOpenChange={(open) => {
          if (!open) setZoomed(false);
        }}
      >
        {/* The prototype viewer's geometry, deliberately: a plate and a framed
            prototype are the same kind of thing to look at, and 1600px is where
            a 1536px source stops being scaled down. */}
        {/* Its own handler, not the section's. The dialog is a React child of
            the section, but its keys do not reach the section's onKeyDown — the
            popup swallows them on the way out — so paging at full size needs
            this. Verified by the dialog case in the component suite; removing
            it makes the arrows dead inside the dialog. */}
        <DialogContent
          showCloseButton
          onKeyDown={handleKeyDown}
          className="flex h-[min(92vh,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[1600px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1600px]"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 pr-12">
            <div className="min-w-0">
              <DialogTitle className="truncate text-body font-medium">{active.title}</DialogTitle>
              <DialogDescription className="truncate text-caption text-muted-foreground">
                {active.caption}
              </DialogDescription>
            </div>
            {total > 1 ? <div className="ml-auto">{pager}</div> : null}
          </div>

          {/* The plate-in-words again, on this side of the modal barrier.
              Opening a dialog puts aria-hidden on everything outside it, so the
              copy hanging off the on-page plate goes unreachable exactly when
              the reader has asked to look closer.

              The live region above is deliberately NOT duplicated here: Base
              UI's markOthers carves every [aria-live] element out of that sweep,
              so the section's region keeps announcing through the open dialog
              and a second one would say everything twice. */}
          <span id={zoomDescriptionId} className="sr-only">
            {active.description}
          </span>

          {/* One img swapped by src: the page has already decoded all three, and
              a reader studying a plate at full size wants the swap, not a fade.
              No brightness knock here — the dark surround is the mat. */}
          <div className="min-h-0 flex-1 bg-surface p-3">
            <img
              src={galleryAssetUrl(active.file)}
              alt={active.title}
              aria-describedby={zoomDescriptionId}
              width={GALLERY_DIAGRAM_WIDTH}
              height={GALLERY_DIAGRAM_HEIGHT}
              className="h-full w-full object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

interface PlateArrowProps {
  side: "prev" | "next";
  label: string;
  /** Absent means the boundary is reached. */
  onClick?: () => void;
}

/**
 * The pager arrows, off the artwork.
 *
 * At a boundary the button stays mounted and goes unavailable rather than
 * unmounting, so the reader can see they are at one end and nothing to its
 * right shifts — the rule the editor's image sequence states.
 *
 * `aria-disabled` rather than the real `disabled` attribute: a browser blurs a
 * focused control the instant it becomes disabled, so pressing Enter on "next"
 * at the last plate would drop the reader out of the carousel onto <body> and
 * restart their next Tab at the top of the page. The attachment viewer can
 * afford the real attribute because its focus trap catches the fall; a hero on
 * a scrolling page cannot. Either way it is announced as unavailable, and with
 * no `onClick` there is nothing to activate.
 */
function PlateArrow({ side, label, onClick }: PlateArrowProps) {
  const Icon = side === "prev" ? ChevronLeft : ChevronRight;
  const blocked = !onClick;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-disabled={blocked || undefined}
      onClick={onClick}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        blocked ? "cursor-default text-faint-foreground" : "hover:bg-secondary hover:text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}
