"use client";

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitInputDraftKey, cockpitInputSelectedVersionsOptions, emptyCockpitInputForm, setCockpitInputForm, clearCockpitInputForm, useCockpitInputDraftStore, type CockpitInputFormDraft } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { CockpitInputVersionSummary } from "./cockpit-input-version-summary";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitInputCommandRecovery } from "./cockpit-input-command-recovery";
import { useCockpitInputRequest } from "./use-cockpit-input-request";
import { CockpitInputProblem } from "./cockpit-input-problem";
import { createSafeId } from "@multica/core/utils";

export function CockpitInputReferenceForm({ wsId, accountId, meetingId, agendaId = null, versionId, targetLabel, canAdd, onDone, onCancel }: {
  wsId: string; accountId: string; meetingId: string; agendaId?: string | null; versionId: string; targetLabel: string; canAdd: boolean;
  onDone: () => void; onCancel: () => void;
}) {
  const { t } = useT("cockpit");
  const key = cockpitInputDraftKey(wsId, accountId, "reference", meetingId, agendaId || "", versionId);
  const initial = useRef<{ key: string; value: CockpitInputFormDraft } | null>(null);
  if (!initial.current || initial.current.key !== key) initial.current = { key, value: { ...emptyCockpitInputForm(createSafeId(), agendaId), selectedVersionIds: [versionId] } };
  const stored = useCockpitInputDraftStore((state) => state.draft.forms[key]);
  const draft = stored ?? initial.current.value;
  const request = useCockpitInputRequest(wsId, key);
  const selected = useQuery(cockpitInputSelectedVersionsOptions(wsId, [versionId]));
  const version = selected.data?.items.find((item) => item.id === versionId);
  const eligible = Boolean(canAdd && version?.canReference && version.captureState === "ready" && version.contentHash && version.sizeBytes !== null
    && ["file", "text"].includes(version.payloadKind) && ["upload", "nas_file", "attachment", "artifact_version"].includes(version.source.kind));
  const locked = request.busy || Boolean(request.pending);
  async function submit(mode: "submit" | "lookup") {
    if (request.busy || !request.pending && !eligible) return;
    setCockpitInputForm(key, draft);
    const result = mode === "lookup" ? await request.verify() : await request.run(request.pending ?? { kind: "reference", meetingId,
      body: { commandKey: createSafeId(), agendaId: draft.agendaId, inputVersionId: versionId, purpose: draft.purpose } });
    if (!result || result.acknowledged.kind !== "reference") return;
    clearCockpitInputForm(key, draft);
    if (result.stillCurrent()) { toast.success(t(($) => $.input_materials.reference_added)); onDone(); }
  }
  return <section className="min-w-0 space-y-4" aria-label={t(($) => $.input_materials.link_version)}>
    <p className="break-words rounded-lg bg-muted/50 p-3 text-caption [overflow-wrap:anywhere]">{targetLabel}</p>
    <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.reference_keeps_previous)}</p>
    {selected.isPending ? <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
      : selected.isError ? <CockpitFlowError onRetry={() => void selected.refetch()} /> : version ? <><p className="break-words text-caption font-medium [overflow-wrap:anywhere]">{version.filename}</p><CockpitInputVersionSummary version={version} />
        <CockpitInputProblem codes={version.blockedReasons} /></> : <p role="alert" className="text-caption">{t(($) => $.input_materials.unavailable_selection)}</p>}
    <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.purpose)}</span>
      <Select value={draft.purpose} disabled={locked} items={{ material: t(($) => $.input_materials.purpose_material), recording: t(($) => $.input_materials.purpose_recording), supporting: t(($) => $.input_materials.purpose_supporting) }}
        onValueChange={(purpose) => { if (purpose === "material" || purpose === "recording" || purpose === "supporting") setCockpitInputForm(key, { ...draft, purpose }); }}>
        <SelectTrigger className="w-full" aria-label={t(($) => $.input_materials.purpose)}><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="material">{t(($) => $.input_materials.purpose_material)}</SelectItem><SelectItem value="recording">{t(($) => $.input_materials.purpose_recording)}</SelectItem><SelectItem value="supporting">{t(($) => $.input_materials.purpose_supporting)}</SelectItem>
        </SelectContent>
      </Select>
    </label>
    <CockpitInputCommandRecovery pending={Boolean(request.pending)} busy={request.busy} canRetry={request.canRetry} onVerify={() => void submit("lookup")} onRetry={() => void submit("submit")} />
    {request.error && <p role="alert" className="break-words text-caption text-destructive [overflow-wrap:anywhere]">{request.error}</p>}
    {!canAdd && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.add_unavailable)}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel}>{t(($) => $.input_materials.return_materials)}</Button>
      <Button type="button" disabled={locked || !eligible || selected.isFetching} aria-busy={request.busy} onClick={() => void submit("submit")}>{request.busy && <Spinner aria-hidden="true" />}{t(($) => $.input_materials.link_version)}</Button>
    </div>
  </section>;
}

export function CockpitInputReferenceRemove({ wsId, accountId, meetingId, referenceId, inputId, versionId, agendaId = null, label, onDone, onCancel }: {
  wsId: string; accountId: string; meetingId: string; referenceId: string; inputId?: string | null; versionId?: string | null; agendaId?: string | null;
  label: string; onDone: () => void; onCancel: () => void;
}) {
  const { t } = useT("cockpit");
  const key = cockpitInputDraftKey(wsId, accountId, "remove-reference", meetingId, referenceId);
  const request = useCockpitInputRequest(wsId, key);
  const stored = useCockpitInputDraftStore((state) => state.draft.forms[key]);
  async function submit(mode: "submit" | "lookup") {
    const draft = stored ?? { ...emptyCockpitInputForm(createSafeId(), agendaId), description: label, inputId: inputId || null, versionId: versionId || null };
    if (!stored && !request.pending) setCockpitInputForm(key, draft);
    const result = mode === "lookup" ? await request.verify() : await request.run(request.pending ?? { kind: "remove_reference", meetingId, referenceId, body: { commandKey: createSafeId() } });
    if (result?.acknowledged.kind === "remove_reference") { clearCockpitInputForm(key, draft); if (result.stillCurrent()) onDone(); }
  }
  return <section className="space-y-4" aria-label={t(($) => $.input_materials.remove_reference)}>
    <p className="break-words text-body font-medium [overflow-wrap:anywhere]">{stored?.description || label}</p><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.remove_reference_hint)}</p>
    <CockpitInputCommandRecovery pending={Boolean(request.pending)} busy={request.busy} canRetry={request.canRetry} onVerify={() => void submit("lookup")} onRetry={() => void submit("submit")} />
    {request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel}>{t(($) => $.task_create.cancel)}</Button>
      <Button type="button" variant="destructive" disabled={request.busy || Boolean(request.pending)} aria-busy={request.busy} onClick={() => void submit("submit")}>{request.busy && <Spinner aria-hidden="true" />}{t(($) => $.input_materials.remove_reference)}</Button>
    </div>
  </section>;
}
