"use client";

import { CockpitInputPageFailure } from "./cockpit-input-page-failure";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitArtifactsOptions, cockpitArtifactVersionsOptions, cockpitInputAttachmentsOptions, cockpitArtifactPath, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import type { CockpitInputFormDraft } from "@multica/core/cockpit";
import type { Issue } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useLocale, useT } from "../../i18n";
import { formatBytes } from "../../common/format-bytes";
import { AppLink } from "../../navigation";
import { CockpitFlowPaging, CockpitIssueChoice, useCockpitSearch } from "./cockpit-task-flow";
import { ArtifactStatus } from "./cockpit-artifact-status";
import { CockpitSourceContextLinks } from "./cockpit-source-context-links";
import { CockpitInputProblem } from "./cockpit-input-problem";

type SourceChoice = { source: NonNullable<CockpitInputFormDraft["source"]>; title: string };
export function CockpitInputSourcePicker({ wsId, disabled, fileCaptureAvailable, onSelect }: {
  wsId: string; disabled?: boolean; fileCaptureAvailable: boolean; onSelect: (choice: SourceChoice) => void;
}) {
  const { t } = useT("cockpit"); const [kind, setKind] = useState<"artifact" | "attachment">("artifact");
  return <section className="space-y-3" aria-label={t(($) => $.input_materials.choose_source)}>
    <div className="flex flex-wrap gap-2"><Button type="button" variant={kind === "artifact" ? "secondary" : "outline"} aria-pressed={kind === "artifact"} disabled={disabled} onClick={() => setKind("artifact")}>{t(($) => $.input_materials.source_artifact)}</Button>
      <Button type="button" variant={kind === "attachment" ? "secondary" : "outline"} aria-pressed={kind === "attachment"} disabled={disabled} onClick={() => setKind("attachment")}>{t(($) => $.input_materials.source_attachment)}</Button></div>
    {kind === "artifact" ? <ArtifactSourcePicker wsId={wsId} disabled={disabled} onSelect={onSelect} /> : <AttachmentSourcePicker wsId={wsId} disabled={disabled || !fileCaptureAvailable} onSelect={onSelect} />}
    {kind === "attachment" && !fileCaptureAvailable && <CockpitInputProblem codes={["private_storage_required"]} />}
  </section>;
}

function ArtifactSourcePicker({ wsId, disabled, onSelect }: { wsId: string; disabled?: boolean; onSelect: (choice: SourceChoice) => void }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const [search, setSearch] = useState(""); const q = useCockpitSearch(search); const changing = q !== search.trim();
  const [cursors, setCursors] = useState([""]); const [artifact, setArtifact] = useState<{ id: string; title: string } | null>(null); const [versionCursors, setVersionCursors] = useState([""]);
  const query = useQuery({ ...cockpitArtifactsOptions(wsId, { q, relation: "all", page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: !artifact && !changing });
  const versions = useQuery({ ...cockpitArtifactVersionsOptions(wsId, artifact?.id || "", { page_size: 25, cursor: versionCursors.at(-1) || undefined }), enabled: Boolean(artifact) });
  return <div className="space-y-3">{artifact ? <>
    <Button type="button" variant="outline" size="sm" onClick={() => setArtifact(null)}>{t(($) => $.input_materials.choose_other_source)}</Button><h4 className="break-words text-caption font-medium">{artifact.title}</h4>
    <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.artifact_reuse_hint)}</p>
    {versions.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : versions.isError || !versions.data || versions.data.artifact_id !== artifact.id ? <CockpitInputPageFailure onRetry={() => void versions.refetch()} onFirstPage={versionCursors.length > 1 ? () => setVersionCursors([""]) : undefined} /> : <>
      <ul className="max-h-80 space-y-2 overflow-y-auto overscroll-contain">{versions.data.items.map((version) => {
        const eligible = version.capture_status === "ready" && version.content_hash && version.size_bytes !== null && ["text", "attachment"].includes(version.payload_kind);
        return <li key={version.id} className="space-y-2 rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="break-words text-caption">{t(($) => $.workflow.version, { number: version.version_number })} · {version.filename}</p><ArtifactStatus status={version.decision} /></div>
          <CockpitSourceContextLinks wsId={wsId} issueId={version.producer_issue_id || null} runId={version.producer_run_id} />
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled || !eligible} onClick={() => onSelect({ title: artifact.title, source: { kind: "artifact_version", artifactVersion: { artifactId: artifact.id, versionId: version.id }, upload: null, attachment: null, nasFile: null } })}>{t(($) => $.input_materials.select_version)}</Button>
            <AppLink target="_blank" rel="noopener noreferrer" href={cockpitArtifactPath(paths.cockpit(), artifact.id, EMPTY_COCKPIT_SCOPE, version.id)} className="self-center text-caption text-primary underline">{t(($) => $.input_materials.open_source_artifact)} {t(($) => $.action_flow.new_tab)}</AppLink></div>
          {!eligible && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.version_not_selectable)}</p>}
        </li>;
      })}</ul>
      {versions.data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.no_versions)}</p>}
      <CockpitFlowPaging page={versionCursors.length} shown={versions.data.items.length} total={versions.data.total} hasNext={Boolean(versions.data.next_cursor)} busy={versions.isFetching}
        onPrevious={() => setVersionCursors(versionCursors.slice(0, -1))} onNext={() => { if (versions.data.next_cursor) setVersionCursors([...versionCursors, versions.data.next_cursor]); }} />
    </>}
  </> : <>
    <label className="block space-y-1 text-caption">{t(($) => $.artifacts.search)}<Input value={search} disabled={disabled} type="search" autoComplete="off" onChange={(event) => { setSearch(event.target.value); setCursors([""]); }} /></label>
    {query.isPending || changing ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : query.isError || !query.data ? <CockpitInputPageFailure onRetry={() => void query.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} /> : <>
      <ul className="max-h-80 divide-y divide-border overflow-y-auto">{query.data.items.map((item) => <li key={item.id}><Button type="button" variant="ghost" disabled={disabled} className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => { setArtifact({ id: item.id, title: item.title }); setVersionCursors([""]); }}><span className="min-w-0 break-words">{item.title}<span className="block text-caption text-muted-foreground">{item.node_label} · {item.producer_issue.identifier} {item.producer_issue.title}</span></span></Button></li>)}</ul>
      {query.data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.no_matches)}</p>}
      <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.filtered_total} hasNext={Boolean(query.data.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (query.data.next_cursor) setCursors([...cursors, query.data.next_cursor]); }} />
    </>}
  </>}</div>;
}

function AttachmentSourcePicker({ wsId, disabled, onSelect }: { wsId: string; disabled?: boolean; onSelect: (choice: SourceChoice) => void }) {
  const { t } = useT("cockpit"); const locale = useLocale(); const paths = useWorkspacePaths(); const [issue, setIssue] = useState<Issue | null>(null);
  const [search, setSearch] = useState(""); const q = useCockpitSearch(search); const changing = q !== search.trim(); const [cursors, setCursors] = useState([""]);
  const query = useQuery({ ...cockpitInputAttachmentsOptions(wsId, issue?.id || "", { q, pageSize: 25, cursor: cursors.at(-1) || undefined }), enabled: Boolean(issue && !changing) });
  if (!issue) return <CockpitIssueChoice wsId={wsId} selected={null} disabled={disabled} onSelect={(value) => { setIssue(value); setSearch(""); setCursors([""]); }} />;
  return <div className="space-y-3"><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setIssue(null)}>{t(($) => $.input_materials.choose_other_issue)}</Button>
    <AppLink href={paths.issueDetail(issue.identifier || issue.id)} target="_blank" rel="noopener noreferrer" className="block break-words text-caption text-primary underline">{issue.identifier} {issue.title} · {t(($) => $.action_flow.new_tab)}</AppLink>
    <label className="block space-y-1 text-caption">{t(($) => $.input_materials.search_attachments)}<Input value={search} placeholder={t(($) => $.input_materials.name_prefix)} disabled={disabled} type="search" autoComplete="off" onChange={(event) => { setSearch(event.target.value); setCursors([""]); }} /></label>
    {query.isPending || changing ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : query.isError || !query.data || query.data.issueId !== issue.id || query.data.q !== q ? <CockpitInputPageFailure onRetry={() => void query.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} /> : <>
      <CockpitInputProblem codes={query.data.blockedReasons} />
      <ul className="max-h-80 divide-y divide-border overflow-y-auto">{query.data.items.map((file) => <li key={file.id}><Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" disabled={disabled || !query.data.canCapture || file.sizeBytes > 500 * 1024 * 1024}
        onClick={() => onSelect({ title: file.filename, source: { kind: "attachment", attachment: { issueId: issue.id, attachmentId: file.id }, artifactVersion: null, nasFile: null, upload: null } })}><span className="min-w-0 break-words [overflow-wrap:anywhere]">{file.filename}<span className="block text-caption text-muted-foreground">{formatBytes(file.sizeBytes)} · {new Date(file.createdAt).toLocaleString(locale)}</span></span></Button></li>)}</ul>
      {query.data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.no_attachments)}</p>}
      <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.total} hasNext={Boolean(query.data.nextCursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (query.data.nextCursor) setCursors([...cursors, query.data.nextCursor]); }} />
    </>}
  </div>;
}
