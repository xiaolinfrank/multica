"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { cockpitRunInputManifestOptions } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitInputManifestItems } from "./cockpit-input-manifest-items";
import { CockpitInputDetail } from "./cockpit-input-detail";
import { CockpitInputProblem } from "./cockpit-input-problem";

export function CockpitRunInputManifest({ wsId, runId, runtimeId }: { wsId: string; runId: string; runtimeId?: string | null }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const accountId = useAuthStore((state) => state.user?.id);
  const query = useQuery(cockpitRunInputManifestOptions(wsId, runId));
  const [inspected, setInspected] = useState<{ inputId: string; versionId: string } | null>(null);
  const labels: Record<string, string> = {
    pending: t(($) => $.input_materials.manifest_run_pending), preparing: t(($) => $.input_materials.manifest_run_preparing),
    required_ready: t(($) => $.input_materials.manifest_run_ready), failed: t(($) => $.input_materials.manifest_run_failed),
  };
  const value = query.data;
  return <section className="min-w-0 space-y-3" aria-label={t(($) => $.input_materials.manifest_run_title)}>
    <h3 className="text-caption font-medium">{t(($) => $.input_materials.manifest_run_title)}</h3>
    {query.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : query.isError || !value || value.taskId !== runId ? <CockpitFlowError onRetry={() => void query.refetch()} />
      : !value.manifestVersion ? <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_run_unrecorded)}</p> : <>
        <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_run_notice)}</p>
        <p className="text-caption">{labels[value.preparationState] ?? t(($) => $.artifacts.unknown)}</p>
        <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_count, { count: value.counts.total, required: value.counts.required })}</p>
        {!value.runtimeSupported && <div className="space-y-2 text-caption"><p>{t(($) => $.input_materials.manifest_runtime_upgrade)}</p>{runtimeId && <AppLink target="_blank" rel="noopener noreferrer" className="text-primary underline" href={paths.runtimeDetail(runtimeId)}>{t(($) => $.input_materials.manifest_open_runtime)} {t(($) => $.action_flow.new_tab)}</AppLink>}</div>}
        {value.errorCode && <CockpitInputProblem codes={[value.errorCode]} />}
        <CockpitInputManifestItems key={value.manifestVersion.id} wsId={wsId} version={value.manifestVersion} onInspect={(inputId, versionId) => setInspected({ inputId, versionId })} />
        {value.issueId && <AppLink href={paths.issueDetail(value.issueId)} target="_blank" rel="noopener noreferrer" className="text-caption text-primary underline">{t(($) => $.input_materials.manifest_open_issue)} {t(($) => $.action_flow.new_tab)}</AppLink>}
      </>}
    <Button type="button" variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{t(($) => $.input_materials.refresh_version)}</Button>
    <Dialog open={Boolean(inspected)} onOpenChange={(open) => { if (!open) setInspected(null); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.material_detail)}</DialogTitle></DialogHeader>
      {inspected && accountId && <><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_fixed_run)}</p><CockpitInputDetail key={inspected.inputId} wsId={wsId} accountId={accountId} {...inspected} onVersionChange={(versionId) => setInspected({ ...inspected, versionId })} /></>}
    </DialogContent></Dialog>
  </section>;
}


export function CockpitRunInputManifestTrigger({ wsId, runId, runtimeId }: { wsId: string; runId: string; runtimeId?: string | null }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false);
  return <><Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>{t(($) => $.input_materials.manifest_title)}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.manifest_run_title)}</DialogTitle></DialogHeader>
      {open && <CockpitRunInputManifest wsId={wsId} runId={runId} runtimeId={runtimeId} />}
    </DialogContent></Dialog>
  </>;
}
