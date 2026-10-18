export interface CockpitNodeSelectorQuery { project_id?: string; module_id?: string; q?: string; eligible?: boolean; cursor?: string; page_size?: number }
export interface CockpitNodeChoice { id: string; title: string; project_id: string | null; module_id: string | null; code: string; eligible: boolean; reason: string }
export interface CockpitNodeChoicePage {
  workspace_id: string; scope: { project_id: string | null; module_id: string | null; q: string; eligible: boolean };
  items: CockpitNodeChoice[]; total: number; filtered_total: number; next_cursor: string | null;
}
export interface CockpitMemberSelectorQuery { q?: string; ids?: string[]; cursor?: string; page_size?: number }
export interface CockpitMemberChoice { id: string; title: string; avatar_url: string; email?: string; role: string }
export interface CockpitMemberChoicePage {
  workspace_id: string; scope: { q: string; ids: string[] }; items: CockpitMemberChoice[]; total: number; filtered_total: number; next_cursor: string | null;
}

export type CockpitAssigneeType = "member" | "agent" | "squad";
export interface CockpitAssigneeSelectorQuery {
  q?: string; kind?: "all" | CockpitAssigneeType; cursor?: string; page_size?: number;
  selected_type?: CockpitAssigneeType; selected_id?: string;
}
export interface CockpitAssigneeChoice {
  id: string; type: CockpitAssigneeType | "unknown"; title: string; email: string; avatar_url: string;
  status: string; runtime_bound: boolean | null; can_assign: boolean; reason: string;
}
export interface CockpitAssigneeChoicePage {
  workspace_id: string; q: string; kind: "all" | CockpitAssigneeType;
  selected_type: CockpitAssigneeType | null; selected_id: string | null;
  items: CockpitAssigneeChoice[]; total: number; next_cursor: string | null;
}
