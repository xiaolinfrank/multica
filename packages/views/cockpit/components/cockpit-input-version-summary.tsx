"use client";

import type { CockpitInputVersionMetadata } from "@multica/core/types/cockpit-input";
import { cockpitArtifactPath, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { formatBytes } from "../../common/format-bytes";
import { useLocale, useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { ArtifactStatus } from "./cockpit-artifact-status";
import { CockpitSourceContextLinks } from "./cockpit-source-context-links";

export function CockpitInputVersionSummary({ version }: { version: CockpitInputVersionMetadata }) {
  const { t } = useT("cockpit");
  const capture: Record<string, string> = {
    awaiting_upload: t(($) => $.input_materials.awaiting_bytes),
    queued: t(($) => $.input_materials.queued),
    capturing: t(($) => $.input_materials.capturing),
    ready: t(($) => $.input_materials.fixed),
    needs_attention: t(($) => $.input_materials.needs_attention),
  };
  const availability: Record<string, string> = {
    unknown: t(($) => $.input_materials.availability_unknown),
    checking: t(($) => $.input_materials.verifying),
    available: t(($) => $.input_materials.available),
    unavailable: t(($) => $.input_materials.unavailable),
  };
  return <div className="space-y-1 text-caption">
    <p className="flex flex-wrap gap-x-3 gap-y-1">
      <span>{t(($) => $.workflow.version, { number: version.versionNumber })}</span>
      <span>{capture[version.captureState] ?? t(($) => $.input_materials.unknown_state)}</span>
      {version.sizeBytes !== null && <span className="text-muted-foreground tabular-nums">{formatBytes(version.sizeBytes)}</span>}
    </p>
    {version.captureState === "ready" && <p className="text-muted-foreground">{availability[version.availability] ?? t(($) => $.input_materials.unknown_state)}</p>}
  </div>;
}

export function CockpitInputVersionSource({ version }: { version: CockpitInputVersionMetadata }) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const locale = useLocale();
  const source = version.source;
  const sourceNames: Record<string, string> = {
    upload: t(($) => $.input_materials.source_upload),
    nas_file: t(($) => $.input_materials.source_nas),
    attachment: t(($) => $.input_materials.source_attachment),
    artifact_version: t(($) => $.input_materials.source_artifact),
  };
  return <details className="min-w-0 space-y-3 text-caption">
    <summary className="cursor-pointer text-muted-foreground">{t(($) => $.input_materials.source_details)}</summary>
    <dl className="min-w-0 space-y-3 rounded-md bg-muted/50 p-3 [overflow-wrap:anywhere]">
      <div><dt className="text-muted-foreground">{t(($) => $.input_materials.source)}</dt><dd>{sourceNames[source.kind] ?? t(($) => $.input_materials.unknown_state)}</dd></div>
      <div><dt className="text-muted-foreground">{t(($) => $.input_materials.submitted_by)}</dt><dd>{version.submittedBy.actorName || t(($) => $.common.unset)}</dd></div>
      {version.submittedBy.actorType === "agent" && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.authorized_by)}</dt><dd>{version.submittedBy.authorizingUserName || t(($) => $.common.unset)}</dd></div>}
      {version.filename && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.filename)}</dt><dd>{version.filename}</dd></div>}
      {source.issue && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.file_source_issue)}</dt><dd>
        <AppLink href={paths.issueDetail(source.issue.id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          {source.issue.identifier} {source.issue.title} {t(($) => $.action_flow.new_tab)}
        </AppLink>
      </dd></div>}
      {source.kind === "artifact_version" && source.artifactId && source.artifactVersionId && <div className="space-y-1">
        <dt className="text-muted-foreground">{t(($) => $.input_materials.source_artifact)}</dt>
        <dd className="space-y-2"><AppLink href={cockpitArtifactPath(paths.cockpit(), source.artifactId, EMPTY_COCKPIT_SCOPE, source.artifactVersionId)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          {source.artifactTitle || t(($) => $.input_materials.open_source_artifact)}
          {source.artifactVersionNumber !== null && <> · {t(($) => $.workflow.version, { number: source.artifactVersionNumber })}</>} {t(($) => $.action_flow.new_tab)}
        </AppLink><div><ArtifactStatus status={source.artifactDecision ?? "unknown"} /></div></dd>
      </div>}
      {source.relativePath && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.source_path)}</dt><dd dir="ltr">{source.relativePath}</dd></div>}
      {source.kind === "upload" && source.sourceUnavailableReason === "local_source_not_checked" && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.original_location)}</dt><dd>{t(($) => $.input_materials.local_source_not_checked)}</dd></div>}
      {source.kind !== "upload" && !source.sourceAvailable && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.original_location)}</dt><dd>{t(($) => $.input_materials.source_unavailable)}</dd></div>}
      {version.readyAt && Number.isFinite(Date.parse(version.readyAt)) && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.fixed_at)}</dt><dd>{new Date(version.readyAt).toLocaleString(locale)}</dd></div>}
      {version.contentHash && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.content_hash)}</dt><dd dir="ltr" className="font-mono">{version.contentHash}</dd></div>}
    </dl>
    <CockpitSourceContextLinks wsId={version.workspaceId} issueId={version.submittedBy.issueId} runId={version.submittedBy.runId} />
  </details>;
}
