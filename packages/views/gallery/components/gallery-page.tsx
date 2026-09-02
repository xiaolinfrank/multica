"use client";

import { useState } from "react";
import { Images, KeyRound, Play } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { CollectionPageHeader, CollectionPageState } from "../../layout";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useT } from "../../i18n";
import { GALLERY_WORKS, type GalleryWork } from "./gallery-catalog";
import { PrototypeThumbnail } from "./prototype-frame";
import { PrototypeViewer } from "./prototype-viewer";

interface OpenTarget {
  work: GalleryWork;
  screenId: string;
}

/**
 * 成果画廊 — what this workspace has shipped, shown as the running thing
 * rather than a screenshot of it.
 *
 * The catalogue is committed content (see gallery-catalog.ts), so the page has
 * no server state and no loading path: it renders the same on web, desktop and
 * offline.
 */
export function GalleryPage() {
  const { t } = useT("gallery");
  const [target, setTarget] = useState<OpenTarget | null>(null);
  const works = GALLERY_WORKS;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <CollectionPageHeader
        icon={Images}
        title={t(($) => $.page.title)}
        count={works.length}
        description={t(($) => $.page.description)}
      />

      {works.length === 0 ? (
        <CollectionPageState
          icon={Images}
          title={t(($) => $.empty.title)}
          description={t(($) => $.empty.description)}
        />
      ) : (
        <div className={cn("min-h-0 flex-1 overflow-y-auto py-4", PAGE_GUTTER)}>
          <div className="flex flex-col gap-4">
            {works.map((work) => (
              <WorkCard
                key={work.id}
                work={work}
                onOpen={(screenId) => setTarget({ work, screenId })}
              />
            ))}
          </div>
        </div>
      )}

      <PrototypeViewer
        work={target?.work ?? null}
        initialScreenId={target?.screenId}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}

interface WorkCardProps {
  work: GalleryWork;
  onOpen: (screenId: string) => void;
}

/**
 * One delivered work: a live miniature of its lead screen beside the pitch and
 * a row of entry points, one per screen.
 *
 * Laid out as a wide row rather than a grid tile so a gallery holding a single
 * work still reads as deliberate, and a gallery holding ten reads as a list of
 * substantial things rather than a wall of thumbnails.
 */
function WorkCard({ work, onOpen }: WorkCardProps) {
  const { t } = useT("gallery");
  const lead = work.screens[0];
  const credentials = work.screens.find((screen) => screen.credentials)?.credentials;

  return (
    <article className="overflow-hidden rounded-xl border bg-card">
      <div className="grid md:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        {lead ? (
          <button
            type="button"
            onClick={() => onOpen(lead.id)}
            aria-label={t(($) => $.work.open_screen, { screen: lead.name })}
            className="group relative aspect-[16/10] border-b bg-surface text-left md:border-r md:border-b-0"
          >
            <PrototypeThumbnail
              screen={lead}
              title={`${work.name} · ${lead.name}`}
              className="h-full w-full"
            />
            <span className="absolute inset-0 flex items-center justify-center bg-background/60 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-caption font-medium text-background">
                <Play aria-hidden="true" className="size-3.5" />
                {t(($) => $.work.open)}
              </span>
            </span>
          </button>
        ) : null}

        <div className="flex min-w-0 flex-col gap-3 p-5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-title-sm font-semibold text-foreground">{work.name}</h2>
            <span className="text-caption text-muted-foreground">{work.tagline}</span>
          </div>

          <p className="text-body text-muted-foreground">{work.summary}</p>

          {work.highlights.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {work.highlights.map((highlight) => (
                <li
                  key={highlight}
                  className="rounded-md bg-accent/50 px-2 py-0.5 text-caption text-muted-foreground"
                >
                  {highlight}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-auto flex flex-col gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              {work.screens.map((screen, index) => (
                <Button
                  key={screen.id}
                  type="button"
                  size="sm"
                  variant={index === 0 ? "default" : "outline"}
                  className="h-8"
                  onClick={() => onOpen(screen.id)}
                >
                  {screen.name}
                </Button>
              ))}
            </div>

            {credentials ? (
              <p className="inline-flex items-center gap-1.5 text-caption text-muted-foreground">
                <KeyRound aria-hidden="true" className="size-3.5 shrink-0" />
                {t(($) => $.work.credentials, {
                  account: credentials.account,
                  password: credentials.password,
                })}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}
