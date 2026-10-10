"use client";

import { useMemo } from "react";
import { queryOptions, useQueries, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ContainerOperationBasis, ContainerOperationKind, IssueOperationBasis, IssueOperationName } from "../types/issue-operation-basis";
import type { UpdateIssueRequest } from "../types";
import { OperationBasisReadQueue } from "./operation-basis-queue";

const reads = new OperationBasisReadQueue();

export const issueOperationKeys = {
  all: (wsId: string) => ["issue-operation-basis", wsId] as const,
  issues: (wsId: string) => [...issueOperationKeys.all(wsId), "issues"] as const,
  page: (wsId: string, ids: readonly string[]) => [...issueOperationKeys.issues(wsId), ids] as const,
  containers: (wsId: string) => [...issueOperationKeys.all(wsId), "containers"] as const,
  container: (wsId: string, kind: ContainerOperationKind, id: string) => [...issueOperationKeys.containers(wsId), kind, id] as const,
};

export class IssueOperationBasisUnavailableError extends Error {
  constructor() { super("issue_operation_basis_unconfirmed"); this.name = "IssueOperationBasisUnavailableError"; }
}
function required<T>(value: T | null): T {
  if (value === null) throw new IssueOperationBasisUnavailableError();
  return value;
}

export function issueOperationIds(ids: readonly string[]): string[] {
  if (ids.some((id) => !id)) throw new RangeError("Operation basis cannot omit an empty issue identity");
  return [...new Set(ids)].sort();
}

export function issueOperationPages(ids: readonly string[]): string[][] {
  if (ids.some((id) => !id)) throw new RangeError("Operation basis cannot omit an empty issue identity");
  // Preserve loaded-page order before canonicalizing each query's ID set.
  // Sorting the whole collection would move old rows between queries on every append.
  const unique = [...new Set(ids)];
  const pages: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 100) pages.push(unique.slice(offset, offset + 100));
  return pages;
}

export function issueOperationBasisOptions(wsId: string, issueIds: readonly string[]) {
  const ids = issueOperationIds(issueIds);
  if (ids.length > 100) throw new RangeError("Operation basis pages contain at most 100 issues");
  return queryOptions({
    queryKey: issueOperationKeys.page(wsId, ids),
    queryFn: ({ signal }) => reads.run(signal, () => api.getIssueOperationBasis(wsId, ids, signal).then(required)),
    enabled: Boolean(wsId && ids.length), staleTime: 15_000, retry: false,
  });
}
export function containerOperationBasisOptions(wsId: string, kind: ContainerOperationKind, id: string) {
  return queryOptions({
    queryKey: issueOperationKeys.container(wsId, kind, id),
    queryFn: ({ signal }) => reads.run(signal, () => api.getContainerOperationBasis(wsId, kind, id, signal).then(required)),
    enabled: Boolean(wsId && id), staleTime: 15_000, retry: false,
  });
}

/** Call once per surface or explicit selection, never from every rendered row. */
export function useIssueOperationBasis(wsId: string, issueIds: readonly string[]) {
  const signature = JSON.stringify(issueOperationPages(issueIds));
  const pages = useMemo<string[][]>(() => JSON.parse(signature), [signature]);
  const queries = useQueries({ queries: pages.map((ids) => issueOperationBasisOptions(wsId, ids)) });
  const byIssue = new Map<string, IssueOperationBasis>();
  const pendingIds = new Set<string>(), errorIds = new Set<string>();
  queries.forEach((query, index) => {
    // An errored refresh cannot reuse stale permission hints as current facts.
    if (query.isError) { for (const id of pages[index]!) errorIds.add(id); return; }
    if (!wsId || !query.data) { for (const id of pages[index]!) pendingIds.add(id); return; }
    for (const item of query.data.items) byIssue.set(item.issue_id, item);
  });
  return {
    byIssue, pendingIds, errorIds,
    isPending: pendingIds.size > 0, isError: errorIds.size > 0,
    refetch: () => Promise.all(queries.map((query) => query.refetch())),
  };
}

export function issueOperationAllowed(basis: IssueOperationBasis | null | undefined, operation: IssueOperationName): boolean {
  return basis?.availability === "available" && basis[operation].state === "allowed";
}
export function issueStatusOperationAllowed(basis: IssueOperationBasis | null | undefined, category: string): boolean {
  return issueOperationAllowed(basis, "status") && ["unstarted", "started", "done", "closed"].includes(category)
    && basis!.status.allowed_categories.includes(category);
}
export function issueUpdateOperationAllowed(
  basis: IssueOperationBasis | null | undefined,
  updates: Partial<UpdateIssueRequest>,
  categoryOf: (key: string) => string | null = () => null,
): boolean {
  const has = (field: keyof UpdateIssueRequest) => Object.prototype.hasOwnProperty.call(updates, field) && updates[field] !== undefined;
  const governed = (["status", "assignee_type", "assignee_id", "project_id", "module_id", "parent_issue_id", "duplicate_of_issue_id"] as const).some(has);
  if (!governed) return basis?.availability !== "unavailable";
  if (basis?.availability !== "available") return false;
  if (has("status") && (!updates.status || !issueStatusOperationAllowed(basis, categoryOf(updates.status) ?? ""))) return false;
  // Marking a duplicate closes it even when the request omits a status field.
  if (has("duplicate_of_issue_id") && (!updates.duplicate_of_issue_id || (has("status") && updates.status !== "cancelled")
    || !issueStatusOperationAllowed(basis, "closed"))) return false;
  if ((has("assignee_type") || has("assignee_id")) && !issueOperationAllowed(basis, "assignee")) return false;
  if ((has("project_id") || has("module_id")) && !issueOperationAllowed(basis, "scope")) return false;
  if (has("parent_issue_id") && !issueOperationAllowed(basis, "parent")) return false;
  return true;
}
export function containerOperationAllowed(basis: ContainerOperationBasis | null | undefined, operation: "delete" | "structural_edit" | "add_child"): boolean {
  return basis?.availability === "available" && basis[operation].state === "allowed";
}
export function invalidateIssueOperationBasis(client: QueryClient, wsId: string) {
  // Relation changes can alter restrictions without incrementing Issue.revision.
  void client.invalidateQueries({ queryKey: issueOperationKeys.all(wsId) }, { cancelRefetch: false });
}
