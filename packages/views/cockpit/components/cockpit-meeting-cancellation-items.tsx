"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cockpitCancellationImpactOptions, cockpitCancellationRunsOptions, cockpitMeetingDetailOptions, cockpitAgendaOptions, cockpitAgendaDetailOptions,
  cockpitMeetingContextPath, EMPTY_COCKPIT_SCOPE, type CockpitPreparationFormDraft,
} from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { usePreparationRunStatusLabel, CockpitPreparationRun } from "./cockpit-preparation-run";
import { CockpitPreparationReasons } from "./cockpit-preparation-preview";
import { CockpitMeetingPicker, cockpitMeetingLabel } from "./cockpit-meeting-picker";

type Draft = Extract<CockpitPreparationFormDraft, { kind: "cancellation" }>;
type Choice = Draft["issues"][number];

export function CockpitCancellationItems({ wsId, meetingId, value, onChange, disabled }: {
  wsId: string; meetingId: string; value: Draft; onChange: (value: Draft) => void; disabled: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const [text, setText] = useState(""); const q = useCockpitSearch(text);
  const [cursors, setCursors] = useState([""]); const [runsIssueId, setRunsIssueId] = useState<string | null>(null);
  const query = useQuery(cockpitCancellationImpactOptions(wsId, meetingId, { q, cursor: cursors.at(-1) || undefined, page_size: 25 })); const page = query.data;
  const update = (choice: Choice) => {
    if (disabled) return;
    const remaining = value.issues.filter((item) => item.issue_id !== choice.issue_id);
    onChange({ ...value, issues: choice.action === "retain" ? remaining : [...remaining, choice] });
  };
  const actions = ["retain", "change_due_date", "link_meeting", "cancel"] as const;
  const labels = { retain: t(($) => $.meeting_disposition.retain), change_due_date: t(($) => $.meeting_disposition.change_due_date), link_meeting: t(($) => $.meeting_disposition.link_meeting), cancel: t(($) => $.meeting_disposition.cancel_issue) };
  return <section aria-label={t(($) => $.meeting_disposition.preparation_impact)} className="space-y-3">
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.keep_default)}</p>
    <label className="block space-y-1 text-caption">{t(($) => $.task_flow.search)}<Input value={text} name="cancellation-issue-search" autoComplete="off" onChange={(event) => { setText(event.target.value); setCursors([""]); }} /></label>
    {query.isPending || q !== text.trim() ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      <ul className="max-h-[48vh] divide-y divide-border overflow-y-auto rounded-lg border border-border px-3">{page.items.map((item) => {
        const selected = value.issues.find((choice) => choice.issue_id === item.issue.id);
        const choice: Choice = selected ?? { issue_id: item.issue.id, expected_revision: item.issue_revision, action: "retain", cancel_status: null, due_date: null, target_meeting_id: null, target_agenda_id: null };
        const permitted = (action: Choice["action"]) => action === "retain" || action === "cancel" && item.can_cancel && Boolean(item.cancel_status) || action === "change_due_date" && item.can_change_due_date || action === "link_meeting" && item.can_link_meeting;
        return <li key={item.issue.id} className="space-y-2 py-3"><AppLink target="_blank" rel="noopener noreferrer" className="line-clamp-2 block break-words text-body font-medium text-primary underline" title={item.issue.title} href={paths.issueDetail(item.issue.identifier || item.issue.id)}>{item.issue.identifier} {item.issue.title} {t(($) => $.action_flow.new_tab)}</AppLink>
          {item.agenda_total > 1 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.shared_agendas, { count: item.agenda_total })}</p>}
          <Select value={choice.action} disabled={disabled} items={actions.map((action) => ({ value: action, label: labels[action] }))} onValueChange={(next) => {
            const action = actions.find((action) => action === next); if (!action || !permitted(action)) return;
            update({ ...choice, expected_revision: item.issue_revision, action, cancel_status: action === "cancel" ? item.cancel_status : null,
              due_date: action === "change_due_date" ? item.issue.due_date : null, target_meeting_id: null, target_agenda_id: null });
          }}><SelectTrigger className="w-full" aria-label={t(($) => $.meeting_disposition.issue_choice, { issue: item.issue.identifier || item.issue.title })}><SelectValue /></SelectTrigger><SelectContent>{actions.map((action) => <SelectItem key={action} value={action} disabled={!permitted(action)}>{labels[action]}</SelectItem>)}</SelectContent></Select>
          {choice.action === "change_due_date" && <label className="block space-y-1 text-caption">{t(($) => $.task_flow.due_date)}<Input type="date" value={choice.due_date ?? ""} disabled={disabled} onChange={(event) => update({ ...choice, due_date: event.target.value || null })} /><span className="text-muted-foreground">{t(($) => $.meeting_disposition.clear_due)}</span></label>}
          {choice.action === "link_meeting" && <CancellationDestination wsId={wsId} sourceMeetingId={meetingId} value={choice} disabled={disabled} onChange={update} />}
          {choice.action === "cancel" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.cancel_wakeups, { ordinary: item.ordinary_wakeup_count, system: item.system_rule_count, queued: item.unstarted_wakeup_run_count })}</p>}
          {selected && selected.expected_revision !== item.issue_revision && <div className="space-y-2 text-caption"><p className="text-warning">{t(($) => $.meeting_disposition.issue_changed)}</p><Button size="sm" variant="outline" disabled={disabled || !permitted(choice.action)} onClick={() => update({ ...choice, expected_revision: item.issue_revision, cancel_status: choice.action === "cancel" ? item.cancel_status : null })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}
          {!permitted("cancel") && <CockpitPreparationReasons codes={item.blocked_reasons} targets={item.targets} />}
          {item.active_run_count > 0 && <div className="space-y-2"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.runs_separate, { count: item.active_run_count })}</p><Button variant="outline" size="sm" aria-expanded={runsIssueId === item.issue.id} onClick={() => setRunsIssueId(runsIssueId === item.issue.id ? null : item.issue.id)}>{t(($) => $.meeting_disposition.choose_runs)}</Button>
            {runsIssueId === item.issue.id && <CancellationRuns wsId={wsId} meetingId={meetingId} issueId={item.issue.id} value={value.run_ids} disabled={disabled} onChange={(run_ids) => onChange({ ...value, run_ids })} />}</div>}
        </li>;
      })}</ul>
      {page.items.length === 0 && <p className="text-caption text-muted-foreground">{q ? t(($) => $.task_flow.no_matches) : t(($) => $.meeting_disposition.no_preparation)}</p>}
    </>}
    {cursors.length > 1 && <Button variant="outline" size="sm" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    <p className="text-caption">{t(($) => $.meeting_disposition.selection_count, { issues: value.issues.length, runs: value.run_ids.length })}</p>
    <div className="flex flex-wrap gap-2">{value.issues.length > 0 && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, issues: [] })}>{t(($) => $.meeting_disposition.keep_all_issues)}</Button>}{value.run_ids.length > 0 && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, run_ids: [] })}>{t(($) => $.meeting_disposition.keep_all_runs)}</Button>}</div>
    {value.issues.length + value.run_ids.length > 50 && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_disposition.selection_limit)}</p>}
  </section>;
}

function CancellationRuns({ wsId, meetingId, issueId, value, onChange, disabled }: { wsId: string; meetingId: string; issueId: string; value: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const { t } = useT("cockpit"); const status = usePreparationRunStatusLabel(); const [cursors, setCursors] = useState([""]);
  const query = useQuery(cockpitCancellationRunsOptions(wsId, meetingId, issueId, { page_size: 25, cursor: cursors.at(-1) || undefined })); const page = query.data;
  return <section aria-label={t(($) => $.meeting_disposition.choose_runs)} className="space-y-2 rounded-md border border-border p-3">
    {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      <ul className="max-h-52 space-y-3 overflow-y-auto">{page.items.map((run) => <li key={run.id} className="space-y-1 text-caption"><label className="flex items-start gap-2"><input type="checkbox" checked={value.includes(run.id)} disabled={disabled || !value.includes(run.id) && (!run.can_stop || !["queued", "deferred", "dispatched", "running", "waiting_local_directory"].includes(run.status))} onChange={(event) => { if (event.target.checked && (!run.can_stop || !["queued", "deferred", "dispatched", "running", "waiting_local_directory"].includes(run.status))) return; onChange(event.target.checked ? [...new Set([...value, run.id])] : value.filter((id) => id !== run.id)); }} /><span className="min-w-0 break-words">{run.agent_name || run.agent_id} · {status(run.status)}<span className="block break-all text-micro text-muted-foreground">{run.id}</span></span></label><CockpitPreparationRun wsId={wsId} runId={run.id} issueId={run.issue_id} /><CockpitPreparationReasons codes={run.blocked_reasons} /></li>)}</ul>
    </>}{cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.stop_hint)}</p>
  </section>;
}

function CancellationDestination({ wsId, sourceMeetingId, value, onChange, disabled }: { wsId: string; sourceMeetingId: string; value: Choice; onChange: (value: Choice) => void; disabled: boolean }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation(); const [text, setText] = useState(""); const q = useCockpitSearch(text); const [cursors, setCursors] = useState([""]);
  const meeting = useQuery({ ...cockpitMeetingDetailOptions(wsId, value.target_meeting_id ?? "", EMPTY_COCKPIT_SCOPE), enabled: Boolean(value.target_meeting_id) });
  const agendas = useQuery({ ...cockpitAgendaOptions(wsId, value.target_meeting_id ?? "", { q, page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: Boolean(value.target_meeting_id) }); const page = agendas.data;
  const selected = useQuery({ ...cockpitAgendaDetailOptions(wsId, value.target_meeting_id ?? "", value.target_agenda_id ?? ""), enabled: Boolean(value.target_meeting_id && value.target_agenda_id) });
  return <section className="space-y-2 rounded-md border border-border p-3">
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.link_meeting_hint)}</p>
    <CockpitMeetingPicker wsId={wsId} disabled={disabled} label={meeting.data ? cockpitMeetingLabel(meeting.data.meeting) : t(($) => $.meeting_disposition.target_meeting)} onSelect={async (id) => {
      if (id === sourceMeetingId) throw new Error(t(($) => $.meeting_disposition.other_meeting));
      onChange({ ...value, target_meeting_id: id, target_agenda_id: null }); setText(""); setCursors([""]);
    }} />
    {value.target_meeting_id && <>
      {meeting.isError && <CockpitFlowError onRetry={() => void meeting.refetch()} />}
      <label className="block space-y-1 text-caption">{t(($) => $.meeting_disposition.target_agenda)}<Input value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setCursors([""]); }} /></label>
      {agendas.isPending ? <Spinner /> : agendas.isError || !page ? <CockpitFlowError onRetry={() => void agendas.refetch()} /> : <>
        <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={agendas.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
        <ul className="max-h-52 overflow-y-auto">{page.items.map((agenda) => <li key={agenda.id}><Button size="sm" variant={value.target_agenda_id === agenda.id ? "secondary" : "ghost"} aria-pressed={value.target_agenda_id === agenda.id} disabled={disabled || Boolean(agenda.removed_at)} className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => onChange({ ...value, target_agenda_id: agenda.id })}><span className="line-clamp-2 break-words">{agenda.title}</span></Button></li>)}</ul>
        {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.empty)}</p>}
      </>}
      {cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
      {value.target_agenda_id && <p className="break-words text-caption">{selected.data?.title ?? value.target_agenda_id}</p>}
      {selected.isError && <CockpitFlowError onRetry={() => void selected.refetch()} />}
      <AppLink className={buttonVariants({ variant: "outline", size: "sm" })} target="_blank" rel="noopener noreferrer" href={cockpitMeetingContextPath(paths.cockpit(), value.target_meeting_id, EMPTY_COCKPIT_SCOPE, navigation.searchParams, "agenda")}>{t(($) => $.meeting_lifecycle.open_agenda)} {t(($) => $.action_flow.new_tab)}</AppLink>
    </>}
  </section>;
}
