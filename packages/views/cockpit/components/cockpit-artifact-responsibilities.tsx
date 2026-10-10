"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isCockpitDefinitiveCommandRejection, cockpitArtifactCommandDraftKey, cockpitArtifactProducerHistoryOptions, cockpitArtifactReviewerHandoffsOptions, prepareCockpitArtifactCommand,
  settleCockpitArtifactCommand, useCockpitArtifactCommandStore, useAssignCockpitArtifactProducer, useArchiveCockpitArtifact, useCockpitAssigneeAvailability, type CockpitScope } from "@multica/core/cockpit";
import { issueDetailOptions } from "@multica/core/issues/queries";
import type { CockpitArtifactHeader, CockpitArtifactProducerCommand } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, CockpitIssueChoice } from "./cockpit-task-flow";
import { CockpitArtifactReviewerTransfer } from "./cockpit-artifact-reviewer-transfer";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitTaskFields, cockpitTaskFieldsValue, type CockpitTaskFieldsValue } from "./cockpit-task-fields";

export function CockpitArtifactResponsibilities({ wsId, artifact, scope, currentUserId, disabled }: { wsId: string; artifact: CockpitArtifactHeader; scope: CockpitScope; currentUserId: string; disabled: boolean }) {
  const { t } = useT("cockpit"); const [history, setHistory] = useState(false);
  const version = artifact.current_version;
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label={t(($) => $.artifact_runtime.responsibility)}><h2 className="text-title-sm font-semibold">{t(($) => $.artifact_runtime.responsibility)}</h2>
    <div className="flex flex-wrap gap-2"><ProducerTransfer wsId={wsId} artifact={artifact} disabled={disabled} scope={scope} currentUserId={currentUserId} />
      <CockpitArtifactReviewerTransfer wsId={wsId} target={{ kind: "artifact_reviewer", artifactId: artifact.id }} revision={artifact.revision}
        signature={JSON.stringify([artifact.revision, artifact.reviewer_id, version?.id, version?.revision, version?.reviewer_id, version?.review_issue?.id])}
        reviewerId={artifact.reviewer_id} canTransfer={artifact.can_reassign_reviewer && !artifact.archived_at} disabled={disabled}
        hint={version && ["pending", "not_requested"].includes(version.decision) ? t(($) => $.artifact_runtime.transfer_active_hint) : t(($) => $.artifact_runtime.transfer_future_hint)} />
      <ArchiveControl wsId={wsId} artifact={artifact} disabled={disabled} />
    </div>
    <Button size="sm" variant="ghost" aria-expanded={history} onClick={() => setHistory(!history)}>{t(($) => $.artifact_runtime.responsibility_history)}</Button>
    {history && <ArtifactResponsibilityHistory key={`${wsId}:${artifact.id}`} wsId={wsId} artifactId={artifact.id} />}
  </section>;
}

function ProducerTransfer({ wsId, artifact, disabled, scope, currentUserId }: { wsId: string; artifact: CockpitArtifactHeader; disabled: boolean; scope: CockpitScope; currentUserId: string }) {
  const { t } = useT("cockpit"); const key = cockpitArtifactCommandDraftKey(wsId, "producer", artifact.id);
  const saved = useCockpitArtifactCommandStore((state) => state.draft.pending[key]); const pending = saved?.kind === "producer" ? saved : null;
  const [open, setOpen] = useState(false); const [issueId, setIssueId] = useState(""); const [reason, setReason] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("existing"); const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [fields, setFields] = useState<CockpitTaskFieldsValue>(() => cockpitTaskFieldsValue(currentUserId));
  const [observed, setObserved] = useState(artifact.revision); const [error, setError] = useState(""); const lock = useRef(false);
  const selectedId = pending?.body.issue_id ?? issueId; const text = pending?.body.reason ?? reason;
  const effectiveMode = pending ? pending.body.new_issue ? "new" : "existing" : mode;
  const newIssue = pending?.body.new_issue;
  const effectiveFields = newIssue ? cockpitTaskFieldsValue(currentUserId, { assignee_type: newIssue.assignee_type ?? undefined, assignee_id: newIssue.assignee_id ?? undefined, priority: newIssue.priority, due_date: newIssue.due_date ?? undefined }) : fields;
  const executor = useCockpitAssigneeAvailability(wsId, open && effectiveMode === "new" && !pending ? fields.assigneeType : null, open && effectiveMode === "new" && !pending ? fields.assigneeId : null);
  const selected = useQuery({ ...issueDetailOptions(wsId, selectedId), enabled: open && effectiveMode === "existing" && Boolean(selectedId) });
  const mismatch = Boolean(selected.data && (selected.data.project_id !== artifact.project_id || selected.data.module_id !== artifact.module_id));
  const targetValid = effectiveMode === "existing" ? Boolean(selected.data && selected.data.id !== artifact.producer_issue.id && !mismatch && !selected.isFetching && !selected.isError)
    : Boolean(title.trim() && executor.available && !executor.isFetching && !executor.isError);
  const valid = Boolean(targetValid && text.trim() && new TextEncoder().encode(text.trim()).length <= 16000 && confirmed);
  const stale = !pending && observed !== artifact.revision;
  const mutation = useAssignCockpitArtifactProducer(wsId); const captureContext = useCockpitCommandContext(JSON.stringify([key, scope]));
  async function submit() {
    if (lock.current || disabled || stale || (!pending && (artifact.archived_at || !artifact.can_assign_producer || !valid))) return;
    const priority = (["none", "low", "medium", "high", "urgent"] as const).find((value) => value === fields.priority) ?? "none";
    const base = { expected_revision: observed, command_key: crypto.randomUUID(), reason: text.trim() };
    const body: CockpitArtifactProducerCommand = effectiveMode === "new" ? { ...base, new_issue: { title: title.trim(), description: description.trim(),
      assignee_type: fields.assigneeType, assignee_id: fields.assigneeId, priority, ...(fields.dueDate ? { due_date: fields.dueDate } : {}) } } : { ...base, issue_id: selectedId };
    const command = prepareCockpitArtifactCommand(key, { kind: "producer", artifactId: artifact.id, body });
    const stillCurrent = captureContext(); lock.current = true; setError("");
    try { await mutation.mutateAsync({ artifactId: command.artifactId, body: command.body }); settleCockpitArtifactCommand(key, command.body.command_key);
      if (stillCurrent()) { setOpen(false); setReason(""); setIssueId(""); setTitle(""); setDescription(""); setConfirmed(false); }
    } catch (cause) { if (isCockpitDefinitiveCommandRejection(cause)) {
        if (stillCurrent()) {
          setReason(command.body.reason); setObserved(command.body.expected_revision); setConfirmed(false);
          if (command.body.new_issue) { const original = command.body.new_issue; setMode("new"); setTitle(original.title); setDescription(original.description);
            setFields(cockpitTaskFieldsValue(currentUserId, { assignee_type: original.assignee_type ?? undefined, assignee_id: original.assignee_id ?? undefined, priority: original.priority, due_date: original.due_date ?? undefined }));
          } else { setMode("existing"); setIssueId(command.body.issue_id); }
        }
        settleCockpitArtifactCommand(key, command.body.command_key);
      }
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.task_flow.unconfirmed));
    } finally { lock.current = false; }
  }
  if ((!artifact.can_assign_producer || artifact.archived_at) && !pending) return null;
  return <Dialog open={open} onOpenChange={(next) => { if (lock.current) return; if (next) { setObserved(artifact.revision); setError(""); setConfirmed(false); } setOpen(next); }}>
    <DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>{t(($) => $.artifact_runtime.transfer_producer)}</DialogTrigger>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"><DialogHeader><DialogTitle>{t(($) => $.artifact_runtime.transfer_producer)}</DialogTitle><DialogDescription>{t(($) => $.artifact_runtime.producer_hint)}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">{pending && <p role="status" className="text-caption">{t(($) => $.task_flow.pending_request)}</p>}
        {stale && <p role="alert" className="text-caption text-destructive">{t(($) => $.artifact_runtime.command_changed)}</p>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant={effectiveMode === "existing" ? "secondary" : "outline"} aria-pressed={effectiveMode === "existing"} disabled={Boolean(pending) || mutation.isPending} onClick={() => { setMode("existing"); setConfirmed(false); }}>{t(($) => $.workflow.adopt_existing)}</Button>
          <Button size="sm" variant={effectiveMode === "new" ? "secondary" : "outline"} aria-pressed={effectiveMode === "new"} disabled={Boolean(pending) || mutation.isPending} onClick={() => { setMode("new"); setConfirmed(false); }}>{t(($) => $.artifact_runtime.new_revision_issue)}</Button></div>
        {effectiveMode === "existing" ? <><CockpitIssueChoice wsId={wsId} selected={selected.data ?? null} disabled={Boolean(pending) || mutation.isPending} onSelect={(issue) => { setIssueId(issue.id); setConfirmed(false); }} />
          {selected.isError && selectedId && <CockpitFlowError onRetry={() => void selected.refetch()} />}
          {mismatch && <p role="alert" className="text-caption text-destructive">{t(($) => $.artifacts.source_scope_mismatch)}</p>}</>
          : <><label className="block space-y-1 text-caption"><span>{t(($) => $.task_flow.title)}</span><Input value={newIssue?.title ?? title} disabled={Boolean(pending) || mutation.isPending} onChange={(event) => { setTitle(event.target.value); setConfirmed(false); }} /></label>
            <label className="block space-y-1 text-caption"><span>{t(($) => $.task_flow.description)}</span><Textarea value={newIssue?.description ?? description} disabled={Boolean(pending) || mutation.isPending} onChange={(event) => { setDescription(event.target.value); setConfirmed(false); }} /></label>
            <CockpitTaskFields wsId={wsId} value={effectiveFields} disabled={Boolean(pending) || mutation.isPending} onChange={(value) => { setFields(value); setConfirmed(false); }} />
            <p className="text-caption text-muted-foreground">{t(($) => $.artifact_runtime.new_revision_hint)}</p></>}
        <label className="block space-y-1 text-caption"><span>{t(($) => $.artifact_runtime.reason)}</span><Textarea value={text} disabled={Boolean(pending) || mutation.isPending} onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} /></label>
        {!pending && <label className="flex items-start gap-2 text-caption"><Checkbox checked={confirmed} disabled={stale || mutation.isPending} onCheckedChange={(value) => setConfirmed(value === true)} />{t(($) => $.artifact_runtime.confirm_responsibility)}</label>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      </div><DialogFooter><DialogClose render={<Button variant="outline" disabled={mutation.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button disabled={disabled || mutation.isPending || stale || (!pending && !valid)} aria-busy={mutation.isPending} onClick={() => void submit()}>{mutation.isPending && <Spinner />}{pending ? t(($) => $.artifact_runtime.retry_command) : t(($) => $.artifact_runtime.confirm_transfer)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ArchiveControl({ wsId, artifact, disabled }: { wsId: string; artifact: CockpitArtifactHeader; disabled: boolean }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const [observed, setObserved] = useState(artifact.revision); const [error, setError] = useState("");
  const mutation = useArchiveCockpitArtifact(wsId); const capture = useCockpitCommandContext(JSON.stringify([wsId, artifact.id])); const lock = useRef(false);
  const archived = Boolean(artifact.archived_at); const label = archived ? t(($) => $.artifact_runtime.restore) : t(($) => $.artifact_runtime.archive);
  if (!(archived ? artifact.can_restore : artifact.can_archive)) return null;
  return <Dialog open={open} onOpenChange={(next) => { if (!lock.current) { if (next) { setObserved(artifact.revision); setError(""); } setOpen(next); } }}><DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>{label}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>{t(($) => $.artifact_runtime.archive_hint)}</DialogDescription></DialogHeader>
      {observed !== artifact.revision && <p role="alert" className="text-caption text-destructive">{t(($) => $.artifact_runtime.command_changed)}</p>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><DialogClose render={<Button variant="outline" disabled={mutation.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button disabled={disabled || mutation.isPending || observed !== artifact.revision} aria-busy={mutation.isPending} onClick={() => {
        if (lock.current) return; lock.current = true; const stillCurrent = capture(); setError("");
        void mutation.mutateAsync({ artifactId: artifact.id, archived: !archived, expectedRevision: observed }).then(() => { if (stillCurrent()) setOpen(false); }).catch((cause: unknown) => { if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); }).finally(() => { lock.current = false; });
      }}>{mutation.isPending && <Spinner />}{label}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ArtifactResponsibilityHistory({ wsId, artifactId }: { wsId: string; artifactId: string }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const [kind, setKind] = useState<"producer" | "reviewer">("producer"); const [cursors, setCursors] = useState<string[]>([""]);
  const producer = useQuery({ ...cockpitArtifactProducerHistoryOptions(wsId, artifactId, { cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: kind === "producer" });
  const reviewer = useQuery({ ...cockpitArtifactReviewerHandoffsOptions(wsId, artifactId, { cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: kind === "reviewer" });
  const query = kind === "producer" ? producer : reviewer; const page = query.data;
  return <div className="space-y-3"><div className="flex gap-2">{(["producer", "reviewer"] as const).map((value) => <Button key={value} size="sm" variant={kind === value ? "secondary" : "ghost"} aria-pressed={kind === value} onClick={() => { setKind(value); setCursors([""]); }}>{value === "producer" ? t(($) => $.artifact_runtime.producer_history) : t(($) => $.artifact_runtime.reviewer_history)}</Button>)}</div>
    {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      : cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <ul className="max-h-96 space-y-3 overflow-y-auto">{page.items.map((item) => <li key={item.id} className="space-y-2 rounded-lg bg-muted/40 p-3 text-caption">
      {"from_issue_id" in item ? <p className="break-all"><AppLink href={paths.issueDetail(item.from_issue_id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{[item.from_issue_identifier, item.from_issue_title].filter(Boolean).join(" · ") || item.from_issue_id}</AppLink> → <AppLink href={paths.issueDetail(item.to_issue_id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{[item.to_issue_identifier, item.to_issue_title].filter(Boolean).join(" · ") || item.to_issue_id}</AppLink></p>
        : <><p className="break-all">{item.from_reviewer_name || item.from_reviewer_id} → {item.to_reviewer_name || item.to_reviewer_id}</p><p>{item.version_number === null ? t(($) => $.artifact_runtime.future_only) : t(($) => $.workflow.version, { number: item.version_number })}</p><div className="flex flex-wrap gap-3">{item.from_review_issue_id && <AppLink href={paths.issueDetail(item.from_review_issue_id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.artifact_runtime.previous_review_task)}</AppLink>}{item.to_review_issue_id && <AppLink href={paths.issueDetail(item.to_review_issue_id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.artifact_runtime.current_review_task)}</AppLink>}</div></>}
      <p className="whitespace-pre-wrap break-words">{item.reason}</p><p className="break-all text-micro text-muted-foreground">{item.created_by_name || item.created_by} · <time dateTime={item.created_at}>{item.created_at}</time></p>
    </li>)}</ul>}
  </div>;
}
