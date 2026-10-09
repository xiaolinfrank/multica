"use client";

import { useId } from "react";
import type { MemberWithUser } from "@multica/core/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";

export function CockpitReviewerSelect({ members, value, onChange, disabled }: {
  members: MemberWithUser[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="text-caption">{t(($) => $.workflow.reviewer)}</label>
    <Select value={value || null} disabled={disabled}
      items={members.map((member) => ({ value: member.user_id, label: member.name || member.email }))}
      onValueChange={(next) => onChange(next || "")}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder={t(($) => $.workflow.choose_reviewer)} /></SelectTrigger>
      <SelectContent>
        {members.map((member) => <SelectItem key={member.user_id} value={member.user_id}>{member.name || member.email}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
