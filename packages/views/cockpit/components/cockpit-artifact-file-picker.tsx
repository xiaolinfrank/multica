"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitArtifactSourceAttachmentsOptions } from "@multica/core/cockpit";
import type { Attachment } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Paperclip } from "lucide-react";
import { AppLink } from "../../navigation";
import { formatBytes } from "../../common/format-bytes";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function CockpitArtifactFilePicker({ wsId, artifactId, producerIssueId, selected, selectedId, disabled, onSelect }: {
  wsId: string; artifactId: string; producerIssueId: string; selected: Attachment | null; selectedId: string; disabled: boolean; onSelect: (id: string) => void;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const [text, setText] = useState(""); const [cursors, setCursors] = useState<string[]>([""]);
  const q = useCockpitSearch(text); const changing = q !== text.trim();
  const query = useQuery({ ...cockpitArtifactSourceAttachmentsOptions(wsId, artifactId, { q, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: !changing });
  const data = query.data;
  return <section aria-label={t(($) => $.artifacts.file_picker)} className="space-y-3">
    <div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" name="artifact-file-search" value={text} autoComplete="off" spellCheck={false} aria-label={t(($) => $.artifacts.search_files)} placeholder={t(($) => $.artifacts.search_files)}
      onChange={(event) => { if (text !== event.target.value) setCursors([""]); setText(event.target.value); }} />
      <Button size="sm" variant="outline" disabled={query.isFetching || changing} onClick={() => void query.refetch()}>{t(($) => $.artifact_runtime.refresh_files)}</Button></div>
    {selected && <p className="break-words rounded-lg bg-muted p-3 text-caption">{t(($) => $.artifacts.selected_file, { name: selected.filename })}</p>}
    {query.isError || (query.isSuccess && data?.producer_issue_id !== producerIssueId) ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending || changing ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
      : data && <><ul className="max-h-64 overflow-y-auto divide-y divide-border rounded-lg border border-border">{data.items.map((file) => <li key={file.id}>
        <Button type="button" variant={selectedId === file.id ? "secondary" : "ghost"} aria-pressed={selectedId === file.id} disabled={disabled}
          className="h-auto min-h-12 w-full justify-start rounded-none py-3 text-left" onClick={() => onSelect(file.id)}>
          <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 flex-1"><span className="line-clamp-2 break-words whitespace-normal" title={file.filename}>{file.filename}</span>
            <span className="mt-1 block text-micro text-muted-foreground">{file.content_type} · {formatBytes(file.size_bytes)}</span></span>
        </Button></li>)}</ul>{data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.artifacts.no_files)}</p>}</>}
    {data ? <CockpitFlowPaging page={cursors.length} shown={data.items.length} total={data.filtered_total} hasNext={Boolean(data.next_cursor)} busy={query.isFetching || changing}
      onPrevious={() => { if (cursors.length > 1) setCursors(cursors.slice(0, -1)); }} onNext={() => { if (data.next_cursor) setCursors([...cursors, data.next_cursor]); }} />
      : cursors.length > 1 && <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
    <AppLink href={paths.issueDetail(producerIssueId)} target="_blank" rel="noopener noreferrer" className="text-caption text-primary hover:underline">{t(($) => $.artifact_runtime.open_producer)} {t(($) => $.action_flow.new_tab)}</AppLink>
  </section>;
}
