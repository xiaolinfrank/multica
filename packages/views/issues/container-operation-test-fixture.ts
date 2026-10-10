import type { ContainerOperationBasis, ContainerOperationKind } from "@multica/core/types";

export function containerOperationFixture(wsId: string, kind: ContainerOperationKind, id: string, overrides: Partial<ContainerOperationBasis> = {}): ContainerOperationBasis {
  const allowed = { state: "allowed" as const, reason_codes: [] };
  return { workspace_id: wsId, schema_version: 1, generated_at: "2026-10-11T00:00:00Z", resource_kind: kind, resource_id: id,
    resource_revision: null, availability: "available", delete: allowed, structural_edit: allowed, add_child: allowed,
    targets: [], targets_total: 0, ...overrides };
}
