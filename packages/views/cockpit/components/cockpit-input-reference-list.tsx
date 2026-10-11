"use client";

import { cockpitMeetingAgendaPath } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink, useNavigation } from "../../navigation";
import type { ReactNode } from "react";
import type { CockpitInputReference, CockpitInputReferencePage } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitInputProblem } from "./cockpit-input-problem";
import { CockpitInputVersionSummary } from "./cockpit-input-version-summary";

export function CockpitInputReferenceList({ page, pageNumber, search, busy, toolbar, onPrevious, onNext, onInspect, onRemove }: {
  page: CockpitInputReferencePage;
  pageNumber: number;
  search: string;
  busy: boolean;
  toolbar?: ReactNode;
  onPrevious: () => void;
  onNext: () => void;
  onInspect: (reference: CockpitInputReference) => void;
  onRemove?: (reference: CockpitInputReference) => void;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths(); const navigation = useNavigation();
  const summary = page.summary;
  const purposeNames: Record<string, string> = {
    material: t(($) => $.input_materials.purpose_material),
    recording: t(($) => $.input_materials.purpose_recording),
    supporting: t(($) => $.input_materials.purpose_supporting),
  };
  return <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4" aria-label={t(($) => $.input_materials.title)} aria-busy={busy}>
    <div className="space-y-3"><h3 className="text-title-sm font-medium">{t(($) => $.input_materials.title)}</h3>{toolbar}</div>
    <CockpitInputProblem codes={page.blockedReasons} />
    <div className="space-y-2"><p className="text-caption text-muted-foreground">{page.agendaId ? t(($) => $.input_materials.all_agenda_materials) : t(($) => $.input_materials.all_meeting_materials)}</p>
    <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-caption">
      <div><dt className="text-muted-foreground">{t(($) => $.input_materials.fixed)}</dt><dd className="mt-1 text-title-sm font-medium tabular-nums">{summary.ready}</dd></div>
      <div><dt className="text-muted-foreground">{t(($) => $.input_materials.pending)}</dt><dd className="mt-1 text-title-sm font-medium tabular-nums">{summary.pending}</dd></div>
      <div><dt className="text-muted-foreground">{t(($) => $.input_materials.needs_attention)}</dt><dd className="mt-1 text-title-sm font-medium tabular-nums">{summary.needsAttention}</dd></div>
    </dl></div>
    {summary.ready > 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.availability_summary, {
      available: summary.availableReady, unavailable: summary.unavailableReady, unknown: summary.unknownReady,
    })}</p>}
    {page.items.length === 0 ? busy ? <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
      : <p className="text-caption text-muted-foreground">{search ? t(($) => $.input_materials.no_search_results) : t(($) => $.input_materials.empty)}</p> : <ul className="max-h-[50dvh] min-w-0 divide-y divide-border overflow-y-auto overscroll-contain">
      {page.items.map((reference) => <li key={reference.id} className="min-w-0 space-y-2 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 min-w-0 flex-1 justify-start whitespace-normal px-0 text-left"
            onClick={() => onInspect(reference)}><span className="line-clamp-2 min-w-0 break-words font-medium [overflow-wrap:anywhere]" title={reference.inputTitle}>{reference.inputTitle}</span></Button>
          {onRemove && reference.canRemove && !reference.removedAt && <Button type="button" variant="ghost" size="sm" disabled={busy}
            aria-label={t(($) => $.input_materials.remove_reference_named, { name: reference.inputTitle })} onClick={() => onRemove(reference)}>{t(($) => $.input_materials.remove_reference)}</Button>}
        </div>
        <p className="break-words text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {purposeNames[reference.purpose] ?? t(($) => $.input_materials.unknown_purpose)}
          {reference.agendaId && <> · <AppLink className="text-primary hover:underline" href={cockpitMeetingAgendaPath(paths.cockpit(), reference.meetingId, reference.agendaId, navigation.searchParams)}>{reference.agendaTitle || t(($) => $.input_materials.agenda_reference)}</AppLink></>}
        </p>
        <CockpitInputVersionSummary version={reference.version} />
        {reference.removedAt && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.reference_removed)}</p>}
      </li>)}
    </ul>}
    <CockpitFlowPaging page={pageNumber} shown={page.items.length} total={page.total} hasNext={Boolean(page.nextCursor)} busy={busy}
      onPrevious={onPrevious} onNext={onNext} />
  </section>;
}
