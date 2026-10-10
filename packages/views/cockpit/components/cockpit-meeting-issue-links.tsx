"use client";

import { useRef, useState } from "react";
import type { CockpitMeetingIssueLink, Issue } from "@multica/core/types";
import { cockpitMeetingHasDirectReference, cockpitObjectPath, COCKPIT_MEETING_ISSUE_ROLES, CockpitUnconfirmedWriteError, isCockpitMeetingIssueRole } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { LoaderCircle, X } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { StatusIcon } from "../../issues/components/status-icon";
import { CockpitIssueChoice } from "./cockpit-task-flow";

function useRoleLabels() {
  const { t } = useT("cockpit");
  return {
    preparation: t(($) => $.meeting_roles.preparation),
    support: t(($) => $.meeting_roles.support),
    minutes: t(($) => $.meeting_roles.minutes),
    review: t(($) => $.meeting_roles.review),
    action: t(($) => $.meeting_roles.action),
    delivery: t(($) => $.meeting_roles.delivery),
    reference: t(($) => $.meeting_roles.reference),
  };
}

export function CockpitMeetingRoleLabels({ link }: {
  link: Pick<CockpitMeetingIssueLink, "role" | "roles">;
}) {
  const { t } = useT("cockpit");
  const labels = useRoleLabels();
  const roles = [...new Set(link.roles ?? [])];
  const texts = roles.length > 0
    ? roles.map((role) => isCockpitMeetingIssueRole(role)
      ? labels[role]
      : t(($) => $.meeting_roles.unknown, { role }))
    : [link.role === "task"
      ? t(($) => $.meeting_roles.legacy_task)
      : link.role
        ? t(($) => $.meeting_roles.unknown, { role: link.role })
        : t(($) => $.meeting_roles.unclassified)];
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {texts.map((text) => (
        <span key={text} className="max-w-full rounded-sm bg-muted px-1.5 py-0.5 text-micro text-muted-foreground break-words">
          {text}
        </span>
      ))}
    </span>
  );
}

function MeetingIssueRolePicker({ link, onSave, disabled, requiredRoles = [] }: {
  link: CockpitMeetingIssueLink;
  onSave: (issueId: string, roles: string[]) => Promise<unknown>;
  disabled?: boolean;
  requiredRoles?: readonly string[];
}) {
  const { t } = useT("cockpit");
  const labels = useRoleLabels();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const saveLock = useRef(false);
  const save = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(link.issue_id, draft);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof CockpitUnconfirmedWriteError
        ? t(($) => $.meeting_roles.unconfirmed_save)
        : cause instanceof Error ? cause.message : t(($) => $.meeting_roles.save_failed));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={(next) => {
      if (saving) return;
      if (next) {
        setDraft([...new Set([...(link.roles ?? []), ...requiredRoles])]);
        setError("");
      }
      setOpen(next);
    }}>
      <PopoverTrigger render={
        <Button variant="ghost" size="xs" disabled={disabled}
          aria-label={t(($) => $.meeting_roles.edit, { identifier: link.issue_identifier || link.issue_id })}>
          {t(($) => $.meeting_roles.title)}
        </Button>
      } />
      <PopoverContent align="end" className="w-64 space-y-3">
        <fieldset disabled={saving} className="space-y-2">
          <legend className="mb-2 text-label font-medium">{t(($) => $.meeting_roles.title)}</legend>
          {COCKPIT_MEETING_ISSUE_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-body">
              <Checkbox checked={draft.includes(role)} disabled={requiredRoles.includes(role)} onCheckedChange={(checked) => {
                if (requiredRoles.includes(role)) return;
                setDraft((current) => checked === true
                  ? [...current.filter((value) => value !== role), role]
                  : current.filter((value) => value !== role));
              }} />
              {labels[role]}
            </label>
          ))}
        </fieldset>
        {draft.some((role) => !isCockpitMeetingIssueRole(role)) && (
          <CockpitMeetingRoleLabels link={{ role: "", roles: draft.filter((role) => !isCockpitMeetingIssueRole(role)) }} />
        )}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <Button disabled={saving} aria-busy={saving} size="sm" onClick={() => void save()}>
          {saving && <LoaderCircle className="size-3.5 animate-spin" />}
          {t(($) => $.meeting_roles.save)}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function CockpitMeetingIssueLinks({ wsId, links, onLink, onUnlink, onSaveRoles, disabled, requiredRolesByIssue }: {
  wsId: string;
  links: CockpitMeetingIssueLink[];
  onLink: (issueId: string) => Promise<unknown>;
  onUnlink: (issueId: string) => void;
  onSaveRoles?: (issueId: string, roles: string[]) => Promise<unknown>;
  disabled?: boolean;
  requiredRolesByIssue?: ReadonlyMap<string, readonly string[]>;
}) {
  const paths = useWorkspacePaths();
  const { t } = useT("cockpit");
  return (
    <div className="space-y-2">
      <ul className="max-h-[45vh] space-y-2 overflow-y-auto overscroll-contain">
        {links.map((link) => (
          <li key={link.issue_id} className="space-y-1.5 rounded-md border border-border p-2">
            <div className="flex items-start gap-1.5">
              <AppLink href={paths.issueDetail(link.issue_identifier || link.issue_id)}
                newTabTitle={link.issue_title} className="flex min-w-0 flex-1 items-start gap-1.5 text-caption hover:underline">
                <StatusIcon status={link.issue_status} className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-2 min-w-0 break-words" title={link.issue_title}><span className="mr-1.5 font-mono text-muted-foreground">{link.issue_identifier || link.issue_id}</span>{" "}{link.issue_title}</span>
              </AppLink>
              {!disabled && cockpitMeetingHasDirectReference(link) && !requiredRolesByIssue?.has(link.issue_id) && (
                <Button variant="ghost" size="icon-xs" onClick={() => onUnlink(link.issue_id)}
                  aria-label={link.has_agenda_reference ? t(($) => $.meeting_lifecycle.unlink_direct, { name: link.issue_identifier || link.issue_id }) : t(($) => $.issues.unlink_issue, { identifier: link.issue_identifier || link.issue_id })}>
                  <X className="size-3" />
                </Button>
              )}
            </div>
            <div className="flex items-start justify-between gap-1">
              {cockpitMeetingHasDirectReference(link) && <CockpitMeetingRoleLabels link={{ ...link, roles: [...new Set([...(link.roles ?? []), ...(requiredRolesByIssue?.get(link.issue_id) ?? [])])] }} />}
              {!disabled && cockpitMeetingHasDirectReference(link) && onSaveRoles && <MeetingIssueRolePicker link={link} onSave={onSaveRoles} requiredRoles={requiredRolesByIssue?.get(link.issue_id)} />}
            </div>
            {link.has_agenda_reference && <div className="flex flex-wrap gap-2 text-caption text-muted-foreground"><span>{t(($) => $.meeting_lifecycle.agenda_source, { count: link.agenda_total ?? 1 })}</span>{link.agenda_id && <AppLink className="text-primary underline" href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: link.meeting_id, view: "agenda", agendaId: link.agenda_id })}>{t(($) => $.meeting_lifecycle.open_agenda)}</AppLink>}</div>}
            {requiredRolesByIssue?.has(link.issue_id) && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.managed_link)}</p>}
          </li>
        ))}
      </ul>
      {!disabled && <MeetingIssueAppend wsId={wsId} onLink={onLink} />}
    </div>
  );
}

function MeetingIssueAppend({ wsId, onLink }: { wsId: string; onLink: (id: string) => Promise<unknown> }) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  return <Popover open={open} onOpenChange={(next) => { if (!lock.current) setOpen(next); }}>
    <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>{t(($) => $.issues.link)}</PopoverTrigger>
    <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] space-y-3">
      <CockpitIssueChoice wsId={wsId} selected={selected} onSelect={(issue) => { setSelected(issue); setError(""); }} disabled={busy} />
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <Button type="button" size="sm" disabled={!selected || busy} onClick={() => {
        if (!selected || lock.current) return; lock.current = true; setBusy(true); setError("");
        void onLink(selected.id).then(() => { setSelected(null); setOpen(false); })
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)))
          .finally(() => { lock.current = false; setBusy(false); });
      }}>{busy && <LoaderCircle className="size-3 animate-spin" />}{t(($) => $.issues.link)}</Button>
    </PopoverContent>
  </Popover>;
}
