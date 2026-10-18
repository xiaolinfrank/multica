"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { buildCockpitDisplayCodesFromIndex, cockpitNodeDetailOptions, cockpitScope, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";

export interface CockpitNodeIssueOption {
  node_id: string; code: string; label: string; project_id: string; module_id: string;
}

/** Resolve one persisted selection independently of any search page. */
export function useCockpitSelectedNodeIssueOption(nodeId: string) {
  const wsId = useWorkspaceId();
  const query = useQuery({ ...cockpitNodeDetailOptions(wsId, nodeId, EMPTY_COCKPIT_SCOPE), enabled: Boolean(nodeId) });
  const option = useMemo(() => {
    const data = query.data;
    if (!data || !data.binding.eligible || !data.binding.project_id || !data.binding.module_id) return null;
    const code = buildCockpitDisplayCodesFromIndex(data.node_index).get(data.node.id) ?? data.node.code;
    return { node_id: data.node.id, code, label: `${code} ${data.node.name}`.trim(), project_id: data.binding.project_id, module_id: data.binding.module_id };
  }, [query.data]);
  return { option, isPending: Boolean(nodeId) && query.isPending, isFetching: query.isFetching, isError: query.isError || (query.isSuccess && !query.data), refetch: query.refetch };
}

export function CockpitNodeIssuePicker({ value, onUpdate, disabled = false, triggerRender, align, open, onOpenChange }: {
  value: CockpitNodeIssueOption | null; onUpdate: (next: CockpitNodeIssueOption | null) => void;
  triggerRender?: React.ReactElement; align?: "start" | "center" | "end"; open?: boolean;
  onOpenChange?: (open: boolean) => void; disabled?: boolean;
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("cockpit");
  const navigation = useNavigation();
  return <CockpitNodeChoicePicker scope={cockpitScope(navigation.searchParams)} wsId={wsId} triggerRender={triggerRender} align={align} open={open} onOpenChange={onOpenChange} eligible disabled={disabled} value={value?.label}
    label={t(($) => $.node_picker.none)} allowClear onClear={() => onUpdate(null)} onSelect={(node, displayCode) => {
      if (node.eligible && node.project_id && node.module_id) onUpdate({ node_id: node.id, code: displayCode,
        label: `${displayCode} ${node.title}`.trim(), project_id: node.project_id, module_id: node.module_id });
    }} />;
}
