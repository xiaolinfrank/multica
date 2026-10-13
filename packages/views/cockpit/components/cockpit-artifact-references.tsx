"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isCockpitDefinitiveCommandRejection, cockpitArtifactReferencesOptions, cockpitArtifactVersionsOptions, cockpitArtifactVersionOptions, cockpitArtifactCommandDraftKey,
  cockpitNodeDetailOptions, cockpitObjectPath, cockpitArtifactPath, EMPTY_COCKPIT_SCOPE,
  prepareCockpitArtifactCommand, settleCockpitArtifactCommand, useCockpitArtifactCommandStore, useCreateCockpitArtifactReference,
  useRemoveCockpitArtifactReference, type CockpitScope } from "@multica/core/cockpit";
import type { CockpitArtifactHeader, CockpitArtifactReferenceKind, CockpitArtifactReferencePurpose } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { ArtifactStatus } from "./cockpit-artifact-status";
import { createSafeId } from "@multica/core/utils";

const purposes: CockpitArtifactReferencePurpose[] = ["input", "output", "evidence", "reference"];
function isPurpose(value: string): value is CockpitArtifactReferencePurpose { return value === "input" || value === "output" || value === "evidence" || value === "reference"; }

export function CockpitArtifactReferences({ wsId, artifact, scope, disabled }: { wsId: string; artifact: CockpitArtifactHeader; scope: CockpitScope; disabled: boolean }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false);
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4"><Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{t(($) => $.artifact_runtime.references)}</Button>
    {open && <><p className="text-caption text-muted-foreground">{t(($) => $.artifact_runtime.reference_hint)}</p>
      <ReferencePage key={`${wsId}:${artifact.id}`} wsId={wsId} artifact={artifact} kind="node" scope={scope} disabled={disabled} /></>}
  </section>;
}

function ReferencePage({ wsId, artifact, kind, scope, disabled }: { wsId: string; artifact: CockpitArtifactHeader; kind: CockpitArtifactReferenceKind; scope: CockpitScope; disabled: boolean }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const [cursors, setCursors] = useState<string[]>([""]); const [removing, setRemoving] = useState<string | null>(null); const [error, setError] = useState(""); const lock = useRef(false);
  const query = useQuery(cockpitArtifactReferencesOptions(wsId, artifact.id, kind, { cursor: cursors.at(-1) || undefined, page_size: 25 }));
  const mutation = useRemoveCockpitArtifactReference(wsId); const capture = useCockpitCommandContext(JSON.stringify([wsId, artifact.id, kind, scope])); const page = query.data;
  return <div className="space-y-3"><ReferenceCreate wsId={wsId} artifact={artifact} kind={kind} scope={scope} disabled={disabled} />
    {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      : cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <ul className="max-h-96 space-y-3 overflow-y-auto">{page.items.map((item) => {
      const purpose = item.purpose;
      const href = item.node_id ? cockpitObjectPath(paths.cockpit(), { kind: "node", id: item.node_id, view: "artifacts" }) : null;
      return <li key={item.id} className="space-y-2 rounded-lg bg-muted/40 p-3 text-caption"><div className="flex flex-wrap items-start justify-between gap-2">{href ? <AppLink href={href} className="line-clamp-2 min-w-0 break-words text-primary hover:underline" title={item.target_label}>{item.target_label}</AppLink> : <span>{item.target_label}</span>}
        <span>{isPurpose(purpose) ? t(($) => $.artifact_runtime.purposes[purpose]) : purpose}</span></div>
        <AppLink href={cockpitArtifactPath(paths.cockpit(), artifact.id, scope, item.version_id)} className="text-primary hover:underline">{t(($) => $.workflow.version, { number: item.version_number })}</AppLink>
        {item.version_id !== artifact.approved_version?.id && <p className="text-muted-foreground">{t(($) => $.artifact_runtime.not_current_evidence)}</p>}
        {item.removed_at ? <p className="break-all text-muted-foreground">{t(($) => $.artifact_runtime.reference_removed)} · {item.removed_by} · {item.removed_at}</p>
          : artifact.can_reference && <Button size="xs" variant="outline" disabled={disabled || mutation.isPending} onClick={() => { setError(""); setRemoving(item.id); }}>{t(($) => $.artifact_runtime.remove_reference)}</Button>}
      </li>;
    })}</ul>}
    <Dialog open={Boolean(removing)} onOpenChange={(next) => { if (!next && !lock.current) setRemoving(null); }}><DialogContent><DialogHeader><DialogTitle>{t(($) => $.artifact_runtime.remove_reference)}</DialogTitle><DialogDescription>{t(($) => $.artifact_runtime.remove_reference_hint)}</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}<DialogFooter><DialogClose render={<Button variant="outline" disabled={mutation.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose>
        <Button variant="destructive" disabled={disabled || mutation.isPending || !artifact.can_reference} aria-busy={mutation.isPending} onClick={() => { if (!removing || lock.current) return; lock.current = true; const stillCurrent = capture(); setError("");
          void mutation.mutateAsync({ artifactId: artifact.id, kind, referenceId: removing }).then(() => { if (stillCurrent()) setRemoving(null); }).catch((cause: unknown) => { if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); }).finally(() => { lock.current = false; });
        }}>{mutation.isPending && <Spinner />}{t(($) => $.artifact_runtime.remove_reference)}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}


function ReferenceCreate({ wsId, artifact, kind, scope, disabled, onCreated }: { wsId: string; artifact: CockpitArtifactHeader; kind: CockpitArtifactReferenceKind; scope: CockpitScope; disabled: boolean; onCreated?: () => void }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const key = cockpitArtifactCommandDraftKey(wsId, "node_reference", artifact.id);
  const stored = useCockpitArtifactCommandStore((state) => state.draft.pending[key]); const pending = stored?.kind === "node_reference" ? stored : null;
  const [open, setOpen] = useState(false); const [versionId, setVersionId] = useState(""); const [targetId, setTargetId] = useState(""); const [purpose, setPurpose] = useState<CockpitArtifactReferencePurpose>("reference"); const [confirmed, setConfirmed] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const chosenVersion = pending?.body.version_id ?? versionId; const chosenTarget = pending?.body.node_id ?? targetId; const chosenPurpose = pending?.body.purpose ?? purpose;
  const version = useQuery({ ...cockpitArtifactVersionOptions(wsId, artifact.id, chosenVersion), enabled: open && Boolean(chosenVersion) });
  const node = useQuery({ ...cockpitNodeDetailOptions(wsId, chosenTarget, EMPTY_COCKPIT_SCOPE), enabled: open && kind === "node" && Boolean(chosenTarget) });
  const targetReady = Boolean(node.data?.binding.eligible && !node.isFetching && !node.isError);
  const knownVersion = Boolean(version.data && ["text", "attachment"].includes(version.data.version.payload_kind) && ["pending", "approved", "changes_requested", "rejected"].includes(version.data.version.decision));
  const valid = Boolean(confirmed && targetReady && knownVersion && version.data?.version.capture_status === "ready" && version.data.version.content_hash && !version.isFetching && !version.isError);
  const mutation = useCreateCockpitArtifactReference(wsId); const capture = useCockpitCommandContext(JSON.stringify([key, scope])); const locked = disabled || mutation.isPending || Boolean(pending);
  const label = t(($) => $.artifact_runtime.add_node_reference);
  async function submit() {
    if (lock.current || disabled || (!pending && (!valid || !artifact.can_reference || artifact.archived_at))) return;
    const common = { reference_key: createSafeId(), version_id: chosenVersion, purpose: chosenPurpose };
    const command = prepareCockpitArtifactCommand(key, { kind: "node_reference", artifactId: artifact.id, body: { ...common, node_id: chosenTarget } });
    const stillCurrent = capture(); lock.current = true; setError("");
    try { await mutation.mutateAsync({ artifactId: artifact.id, kind: "node", body: command.body }); settleCockpitArtifactCommand(key, command.body.reference_key);
      if (stillCurrent()) { setOpen(false); setConfirmed(false); setTargetId(""); onCreated?.(); }
    } catch (cause) { if (isCockpitDefinitiveCommandRejection(cause)) {
        if (stillCurrent()) { setVersionId(command.body.version_id); setPurpose(command.body.purpose); setTargetId(command.body.node_id); setConfirmed(false); }
        settleCockpitArtifactCommand(key, command.body.reference_key);
      }
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.task_flow.unconfirmed));
    } finally { lock.current = false; }
  }
  if ((!artifact.can_reference || artifact.archived_at) && !pending) return null;
  return <Dialog open={open} onOpenChange={(next) => { if (!lock.current) { setOpen(next); setError(""); } }}><DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>{label}</DialogTrigger>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"><DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>{t(($) => $.artifact_runtime.reference_hint)}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">{pending && <p role="status" className="text-caption">{t(($) => $.task_flow.pending_request)}</p>}
        <FixedVersionChoice wsId={wsId} artifactId={artifact.id} value={chosenVersion} number={version.data?.version.version_number} disabled={locked} onChange={(id) => { setVersionId(id); setConfirmed(false); }} />
        {version.data && <ArtifactStatus status={version.data.version.decision} />}
        <p className="text-caption text-muted-foreground">{t(($) => $.artifact_runtime.workspace_reference)}</p>
        <CockpitNodeChoicePicker wsId={wsId} scope={EMPTY_COCKPIT_SCOPE} label={t(($) => $.artifact_runtime.choose_node)} value={node.data?.node.name || chosenTarget} disabled={locked} onSelect={(item) => { setTargetId(item.id); setConfirmed(false); }} />
        {node.isError && <CockpitFlowError onRetry={() => void node.refetch()} />}
        {kind === "node" && node.data && !node.data.binding.eligible && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.artifact_runtime.node_unavailable)}</p>
          <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: chosenTarget, view: "details" })} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.task_flow.details_tab)} {t(($) => $.action_flow.new_tab)}</AppLink></div>}
        <label className="block space-y-1 text-caption"><span>{t(($) => $.artifact_runtime.purpose)}</span><Select value={chosenPurpose} disabled={locked} items={purposes.map((value) => ({ value, label: t(($) => $.artifact_runtime.purposes[value]) }))} onValueChange={(value) => { if (value === "input" || value === "output" || value === "evidence" || value === "reference") { setPurpose(value); setConfirmed(false); } }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{purposes.map((value) => <SelectItem key={value} value={value}>{t(($) => $.artifact_runtime.purposes[value])}</SelectItem>)}</SelectContent></Select></label>
        {version.isError && chosenVersion && <CockpitFlowError onRetry={() => void version.refetch()} />}
        {!pending && <label className="flex items-start gap-2 text-caption"><Checkbox disabled={locked} checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />{t(($) => $.artifact_runtime.confirm_reference)}</label>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      </div><DialogFooter><DialogClose render={<Button variant="outline" disabled={mutation.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button disabled={disabled || mutation.isPending || (!pending && !valid)} aria-busy={mutation.isPending} onClick={() => void submit()}>{mutation.isPending && <Spinner />}{pending ? t(($) => $.artifact_runtime.retry_command) : t(($) => $.artifact_runtime.create_reference)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function FixedVersionChoice({ wsId, artifactId, value, number, disabled, onChange }: { wsId: string; artifactId: string; value: string; number?: number; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const [open, setOpen] = useState(false); const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitArtifactVersionsOptions(wsId, artifactId, { cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open }); const page = query.data;
  return <div className="space-y-2"><Button size="sm" variant="outline" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>{t(($) => $.artifact_runtime.choose_version)}</Button>{value && <p className="break-all text-caption">{number === undefined ? value : t(($) => $.workflow.version, { number })}</p>}
    {open && <>{query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <ul className="max-h-56 overflow-y-auto">{page.items.map((version) => <li key={version.id} className="flex flex-wrap items-center gap-2"><Button size="sm" variant={value === version.id ? "secondary" : "ghost"} disabled={disabled || version.capture_status !== "ready" || !version.content_hash || !["text", "attachment"].includes(version.payload_kind) || !["pending", "approved", "changes_requested", "rejected"].includes(version.decision)} aria-pressed={value === version.id} onClick={() => { onChange(version.id); setOpen(false); }}>{t(($) => $.workflow.version, { number: version.version_number })}</Button><ArtifactStatus status={version.decision} />
      {version.capture_status !== "ready" && <ArtifactStatus status={version.capture_status} />}
      <AppLink href={cockpitArtifactPath(paths.cockpit(), artifactId, EMPTY_COCKPIT_SCOPE, version.id)} target="_blank" rel="noopener noreferrer" className="text-caption text-primary hover:underline">{t(($) => $.artifacts.read_version)} {t(($) => $.action_flow.new_tab)}</AppLink>
    </li>)}</ul>}
      {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
        : cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}</>}
  </div>;
}
