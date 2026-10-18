"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitInputManifestVersionOptions, cockpitInputManifestVersionsOptions, cockpitIssueInputManifestOptions, cockpitIssueInputManifestPath } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { AppLink } from "../../navigation";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, CockpitIssueChoice } from "./cockpit-task-flow";
import { CockpitInputPageFailure } from "./cockpit-input-page-failure";

/** Human citation is an explicit saved manifest selection. Producer changes and
 * browsing other issues never infer or replace the selected manifest. */
export function CockpitArtifactInputManifest({ wsId, producerIssueId, selectedIssueId, selectedVersionId, disabled, onChange }: {
  wsId: string; producerIssueId: string; selectedIssueId: string; selectedVersionId: string; disabled?: boolean;
  onChange: (selection: { inputManifestIssueId: string; inputManifestVersionId: string }) => void;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const locale = useLocale();
  const [open, setOpen] = useState(false); const [scopeIssueId, setScopeIssueId] = useState(selectedIssueId || producerIssueId);
  const [choosingIssue, setChoosingIssue] = useState(false); const [cursors, setCursors] = useState([""]);
  const selected = useQuery(cockpitInputManifestVersionOptions(wsId, selectedIssueId, selectedVersionId));
  const selectedIssue = useQuery({ ...cockpitIssueInputManifestOptions(wsId, selectedIssueId), enabled: Boolean(selectedIssueId && selectedVersionId) });
  const scope = useQuery({ ...cockpitIssueInputManifestOptions(wsId, scopeIssueId), enabled: open && !choosingIssue && Boolean(scopeIssueId) });
  const versions = useQuery({ ...cockpitInputManifestVersionsOptions(wsId, scopeIssueId, { pageSize: 25, cursor: cursors.at(-1) || undefined }), enabled: open && !choosingIssue && Boolean(scopeIssueId) });
  return <section className="space-y-2 rounded-lg border border-border p-3" aria-label={t(($) => $.input_materials.artifact_manifest_source)}>
    <p className="text-caption font-medium">{t(($) => $.input_materials.artifact_manifest_source)}</p>
    {selectedVersionId && selectedIssueId ? <>
      <AppLink href={cockpitIssueInputManifestPath(paths.issueDetail(selectedIssueId), new URLSearchParams(), selectedVersionId)} target="_blank" rel="noopener noreferrer" className="block break-words text-caption text-primary underline">
        {selectedIssue.data ? `${selectedIssue.data.issue.identifier} ${selectedIssue.data.issue.title}` : t(($) => $.input_materials.artifact_view_manifest)}
        {selected.data && <> · {t(($) => $.workflow.version, { number: selected.data.versionNumber })}</>} · {t(($) => $.action_flow.new_tab)}
      </AppLink>
      {(selected.isError || selectedIssue.isError) && <CockpitFlowError onRetry={() => { void selected.refetch(); void selectedIssue.refetch(); }} />}
      {(selected.isPending || selectedIssue.isPending) && <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p>}
    </> : <p className="text-caption text-muted-foreground">{selectedVersionId || selectedIssueId ? t(($) => $.input_materials.artifact_incomplete_manifest) : t(($) => $.input_materials.artifact_no_manifest)}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { setScopeIssueId(selectedIssueId || producerIssueId); setChoosingIssue(false); setCursors([""]); setOpen(true); }}>{t(($) => $.input_materials.artifact_choose_manifest)}</Button>
      {(selectedVersionId || selectedIssueId) && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ inputManifestIssueId: "", inputManifestVersionId: "" })}>{t(($) => $.input_materials.artifact_clear_manifest)}</Button>}</div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.artifact_choose_manifest)}</DialogTitle></DialogHeader>
      <div className="space-y-3">{choosingIssue ? <><CockpitIssueChoice wsId={wsId} selected={null} disabled={disabled} onSelect={(issue) => { setScopeIssueId(issue.id); setCursors([""]); setChoosingIssue(false); }} />
        <Button type="button" variant="outline" size="sm" onClick={() => setChoosingIssue(false)}>{t(($) => $.input_materials.return_materials)}</Button>
      </> : <>
        <div className="flex flex-wrap justify-between gap-2"><p className="break-words text-caption font-medium">{scope.data?.issue.identifier} {scope.data?.issue.title}</p><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setChoosingIssue(true)}>{t(($) => $.input_materials.choose_other_issue)}</Button></div>
        {scope.isError && <CockpitFlowError onRetry={() => void scope.refetch()} />}
        {versions.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : versions.isError || !versions.data || versions.data.workspaceId !== wsId || versions.data.issueId !== scopeIssueId || versions.data.items.some((item) => item.workspaceId !== wsId || item.issueId !== scopeIssueId) ? <CockpitInputPageFailure onRetry={() => void versions.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} /> : <>
          <ul className="max-h-80 space-y-2 overflow-y-auto overscroll-contain">{versions.data.items.map((version) => <li key={version.id} className="space-y-2 rounded-lg border border-border p-3"><p className="text-caption font-medium">{t(($) => $.workflow.version, { number: version.versionNumber })}</p>
            <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_count, { count: version.itemTotal, required: version.requiredTotal })} · {version.createdByName} · {new Date(version.createdAt).toLocaleString(locale)}</p>
            <div className="flex flex-wrap gap-2"><Button type="button" variant={version.id === selectedVersionId ? "secondary" : "outline"} size="sm" disabled={disabled || scope.isError || !scope.data || version.id === selectedVersionId} onClick={() => { onChange({ inputManifestIssueId: version.issueId, inputManifestVersionId: version.id }); setOpen(false); }}>{version.id === selectedVersionId ? t(($) => $.input_materials.version_selected) : t(($) => $.input_materials.select_version)}</Button>
              <AppLink href={cockpitIssueInputManifestPath(paths.issueDetail(version.issueId), new URLSearchParams(), version.id)} target="_blank" rel="noopener noreferrer" className="self-center text-caption text-primary underline">{t(($) => $.input_materials.artifact_view_manifest)} · {t(($) => $.action_flow.new_tab)}</AppLink></div>
          </li>)}</ul>
          {versions.data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_no_history)}</p>}
          <CockpitFlowPaging page={cursors.length} shown={versions.data.items.length} total={versions.data.total} hasNext={Boolean(versions.data.nextCursor)} busy={versions.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (versions.data.nextCursor) setCursors([...cursors, versions.data.nextCursor]); }} />
        </>}
      </>}</div>
    </DialogContent></Dialog>
  </section>;
}
