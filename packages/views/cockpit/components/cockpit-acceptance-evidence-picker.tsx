"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitArtifactsOptions, type CockpitAcceptanceEvidenceSelection, type CockpitScope } from "@multica/core/cockpit";
import type { CockpitArtifactHeader } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function approvedAcceptanceEvidence(artifact: CockpitArtifactHeader | null | undefined) {
  const version = artifact?.evidence_version;
  return artifact && !artifact.archived_at && version?.artifact_id === artifact.id && version.decision === "approved" && version.capture_status === "ready"
    && version.content_hash && ["text", "attachment"].includes(version.payload_kind) ? version : null;
}

export function CockpitAcceptanceEvidencePicker({ wsId, nodeId, criterionTitle, selected, disabled, onSelect }: {
  wsId: string; nodeId: string; scope: CockpitScope; criterionTitle: string; selected: CockpitAcceptanceEvidenceSelection[]; disabled: boolean;
  onSelect: (reference: CockpitAcceptanceEvidenceSelection) => void;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false); const [text, setText] = useState(""); const [cursors, setCursors] = useState<string[]>([""]);
  const q = useCockpitSearch(text); const changing = q !== text.trim();
  const query = useQuery({ ...cockpitArtifactsOptions(wsId, { node_id: nodeId, relation: "all",
    q, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open && !changing });
  const page = query.data;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled || selected.length >= 20}
      aria-label={t(($) => $.acceptance_request.choose_for, { title: criterionTitle })} />}>{t(($) => $.acceptance_request.choose_evidence)}</PopoverTrigger>
    <PopoverContent align="start" className="w-[min(30rem,calc(100vw-2rem))] space-y-3 p-3">
      <Input autoFocus value={text} aria-label={t(($) => $.acceptance_request.search_evidence)} placeholder={t(($) => $.acceptance_request.search_evidence)}
        onChange={(event) => { if (event.target.value !== text) setCursors([""]); setText(event.target.value); }} />
      {query.isPending || changing ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
        : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <div className="max-h-72 space-y-2 overflow-y-auto overscroll-contain">
          {page.items.map((artifact) => {
            const version = approvedAcceptanceEvidence(artifact); const chosen = Boolean(version && selected.some((item) => item.versionId === version.id));
            return <div key={artifact.id} className="space-y-1"><Button type="button" variant={chosen ? "secondary" : "ghost"} className="h-auto w-full justify-start whitespace-normal text-left"
              disabled={disabled || !version || chosen || selected.length >= 20} onClick={() => { if (version) { onSelect({ artifactId: artifact.id, versionId: version.id }); setOpen(false); } }}>
              <span className="min-w-0"><span className="line-clamp-2 break-words">{artifact.title}</span>{version && <span className="text-micro text-muted-foreground">{t(($) => $.workflow.version, { number: version.version_number })}</span>}</span>
            </Button>{!version && <p className="px-3 text-micro text-muted-foreground">{t(($) => $.acceptance_request.no_approved_version)}</p>}</div>;
          })}
          {page.items.length === 0 && <p className="py-3 text-caption text-muted-foreground">{t(($) => $.task_flow.no_matches)}</p>}
        </div>}
      {page && <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.filtered_total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching || changing}
        onPrevious={() => setCursors((value) => value.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors((value) => [...value, page.next_cursor!]); }} />}
      {!page && cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    </PopoverContent>
  </Popover>;
}
