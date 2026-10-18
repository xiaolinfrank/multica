"use client";

import { CockpitInputPageFailure } from "./cockpit-input-page-failure";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitInputManifestVersionOptions, cockpitInputManifestVersionsOptions } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitInputManifestItems } from "./cockpit-input-manifest-items";
import { CockpitInputDetail } from "./cockpit-input-detail";

export function CockpitInputManifestHistory({ wsId, accountId, issueId, manifestVersionId, onSelect, onClose }: {
  wsId: string; accountId: string; issueId: string; manifestVersionId: string | null;
  onSelect: (manifestVersionId: string) => void; onClose: () => void;
}) {
  const { t } = useT("cockpit"); const locale = useLocale();
  const [browse, setBrowse] = useState(false); const [cursors, setCursors] = useState([""]);
  const [inspected, setInspected] = useState<{ inputId: string; versionId: string } | null>(null);
  const versions = useQuery({ ...cockpitInputManifestVersionsOptions(wsId, issueId, { pageSize: 25, cursor: cursors.at(-1) || undefined }), enabled: browse || !manifestVersionId });
  const version = useQuery({ ...cockpitInputManifestVersionOptions(wsId, issueId, manifestVersionId || ""), enabled: Boolean(manifestVersionId && !browse) });
  const exact = version.data?.id === manifestVersionId && version.data?.issueId === issueId && version.data?.workspaceId === wsId ? version.data : null;
  return <><Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.manifest_history)}</DialogTitle></DialogHeader>
    <div className="space-y-3">{!browse && manifestVersionId ? <>
      <Button type="button" variant="outline" size="sm" onClick={() => setBrowse(true)}>{t(($) => $.input_materials.manifest_browse_history)}</Button>
      {version.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : version.isError || !exact ? <CockpitFlowError onRetry={() => void version.refetch()} /> : <>
        <p className="text-caption font-medium">{t(($) => $.workflow.version, { number: exact.versionNumber })}</p>
        <p className="text-caption text-muted-foreground">{exact.createdByName} · {new Date(exact.createdAt).toLocaleString(locale)}</p>
        <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_history_notice)}</p>
        {exact.note && <p className="whitespace-pre-wrap break-words text-caption">{exact.note}</p>}
        <CockpitInputManifestItems key={exact.id} wsId={wsId} version={exact} onInspect={(inputId, versionId) => setInspected({ inputId, versionId })} />
      </>}
    </> : versions.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : versions.isError || !versions.data ? <CockpitInputPageFailure onRetry={() => void versions.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} /> : <>
      <ul className="max-h-80 space-y-2 overflow-y-auto overscroll-contain">{versions.data.items.map((item) => <li key={item.id}><Button type="button" variant="outline" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => { onSelect(item.id); setBrowse(false); }}><span className="min-w-0 break-words">{t(($) => $.workflow.version, { number: item.versionNumber })}<span className="block text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_count, { count: item.itemTotal, required: item.requiredTotal })} · {item.createdByName} · {new Date(item.createdAt).toLocaleString(locale)}</span></span></Button></li>)}</ul>
      {versions.data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_no_history)}</p>}
      <CockpitFlowPaging page={cursors.length} shown={versions.data.items.length} total={versions.data.total} hasNext={Boolean(versions.data.nextCursor)} busy={versions.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (versions.data.nextCursor) setCursors([...cursors, versions.data.nextCursor]); }} />
    </>}
    <Button type="button" variant="outline" onClick={onClose}>{t(($) => $.input_materials.manifest_close)}</Button></div>
  </DialogContent></Dialog>
    <Dialog open={Boolean(inspected)} onOpenChange={(open) => { if (!open) setInspected(null); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.material_detail)}</DialogTitle></DialogHeader>
      {inspected && <><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_history_notice)}</p><CockpitInputDetail key={inspected.inputId} wsId={wsId} accountId={accountId} {...inspected} onVersionChange={(versionId) => setInspected({ ...inspected, versionId })} /></>}
    </DialogContent></Dialog>
  </>;
}
