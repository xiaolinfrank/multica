"use client";

import { CockpitInputPageFailure } from "./cockpit-input-page-failure";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitInputManifestItemsOptions } from "@multica/core/cockpit";
import type { CockpitInputManifestVersionMetadata } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitInputProblem } from "./cockpit-input-problem";

/** A bounded, read-only page of the exact manifest; never used to build an edit. */
export function CockpitInputManifestItems({ wsId, version, onInspect }: {
  wsId: string; version: CockpitInputManifestVersionMetadata; onInspect: (inputId: string, versionId: string) => void;
}) {
  const { t } = useT("cockpit");
  const [cursors, setCursors] = useState([""]);
  const purposeNames: Record<string, string> = { material: t(($) => $.input_materials.purpose_material), recording: t(($) => $.input_materials.purpose_recording), supporting: t(($) => $.input_materials.purpose_supporting) };
  const query = useQuery(cockpitInputManifestItemsOptions(wsId, version.issueId, version.id, { pageSize: 25, cursor: cursors.at(-1) || undefined }));
  const page = query.data;
  if (query.isPending) return <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p>;
  if (query.isError || !page || page.manifestHash !== version.manifestHash || page.manifestVersionId !== version.id || page.total !== version.itemTotal) return <CockpitInputPageFailure onRetry={() => void query.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} />;
  return <div className="space-y-3">
    <ul className="max-h-80 space-y-2 overflow-y-auto overscroll-contain">{page.items.map((item) => <li key={item.inputVersionId} className="space-y-1 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-start justify-between gap-2"><p className="min-w-0 break-words text-caption font-medium [overflow-wrap:anywhere]">{item.inputTitle || item.filename} · {t(($) => $.workflow.version, { number: item.inputVersionNumber })}</p>
        <Button type="button" variant="ghost" size="xs" onClick={() => onInspect(item.inputId, item.inputVersionId)}>{t(($) => $.input_materials.manifest_inspect)}</Button></div>
      <p className="text-caption text-muted-foreground">{item.required ? t(($) => $.input_materials.manifest_required) : t(($) => $.input_materials.manifest_optional)} · {item.availability === "available" ? t(($) => $.input_materials.available) : item.availability === "unavailable" ? t(($) => $.input_materials.unavailable) : t(($) => $.input_materials.unknown_availability)}</p>
      <p className="break-words text-caption [overflow-wrap:anywhere]">{Object.hasOwn(purposeNames, item.purpose) ? purposeNames[item.purpose] : t(($) => $.input_materials.unknown_purpose)}</p>
      {item.unavailableReason && <CockpitInputProblem codes={[item.unavailableReason]} />}
    </li>)}</ul>
    {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_empty)}</p>}
    {(cursors.length > 1 || page.nextCursor) && <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.nextCursor)} busy={query.isFetching}
      onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.nextCursor) setCursors([...cursors, page.nextCursor]); }} />}
  </div>;
}
