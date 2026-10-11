"use client";

import { useWorkspacePaths } from "@multica/core/paths";
import { buttonVariants } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitPreparationRun } from "./cockpit-preparation-run";

export function CockpitSourceContextLinks({ wsId, issueId, runId }: {
  wsId: string;
  issueId: string | null;
  runId: string | null;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  if (!issueId && !runId) return null;
  return <div className="min-w-0 space-y-2">
    <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.source_context)}</p>
    <div className="flex flex-wrap items-center gap-2">
      {issueId && <AppLink href={paths.issueDetail(issueId)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
        {t(($) => $.input_materials.source_issue)} {t(($) => $.action_flow.new_tab)}
      </AppLink>}
      {runId && <CockpitPreparationRun key={`${wsId}:${runId}`} wsId={wsId} issueId={issueId} runId={runId} context="source" />}
    </div>
  </div>;
}
