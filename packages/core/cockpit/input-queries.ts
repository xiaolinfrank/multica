import { cockpitReadKeys } from "./read-queries";
import { cockpitPreparationKeys } from "./meeting-preparation-queries";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitInputListQuery, CockpitInputPageQuery, CockpitInputNASBrowseInput, CockpitInputManifestVersionMetadata } from "../types/cockpit-input";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";

export const cockpitInputKeys = {
  all: (ws: string) => [...cockpitKeys.all(ws), "inputs"] as const,
  browse: (ws: string) => [...cockpitKeys.all(ws), "input-browse"] as const,
  meeting: (ws: string, meeting: string) => [...cockpitInputKeys.all(ws), "meeting", meeting] as const,
  input: (ws: string, input: string) => [...cockpitInputKeys.all(ws), "input", input] as const,
  issue: (ws: string, issue: string) => [...cockpitInputKeys.all(ws), "issue", issue] as const,
  run: (ws: string, run: string) => [...cockpitInputKeys.all(ws), "run", run] as const,
};
function bounded<T extends CockpitInputPageQuery>(query: T): T & { pageSize: number } {
  const size = query.pageSize ?? 25;
  return { ...query, cursor: query.cursor || undefined, pageSize: Number.isInteger(size) ? Math.min(100, Math.max(1, size)) : 25 };
}

export function cockpitInputCapabilitiesOptions(wsId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.all(wsId), "capabilities"],
    queryFn: ({ signal }) => api.getCockpitInputCapabilities(wsId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId), retry: false,
  });
}

/** Recover up to 200 selected fixed versions in at most two bounded requests. */
export function cockpitInputSelectedVersionsOptions(wsId: string, versionIds: string[]) {
  const ids = [...versionIds];
  return queryOptions({ queryKey: [...cockpitInputKeys.all(wsId), "selected-versions", ids], retry: false,
    enabled: Boolean(wsId && ids.length > 0),
    queryFn: async ({ signal }) => {
      if (ids.length > 200 || new Set(ids).size !== ids.length) throw new Error("Invalid input version selection");
      const pages = await Promise.all([ids.slice(0, 100), ids.slice(100)].filter((batch) => batch.length > 0)
        .map((batch) => api.getCockpitInputVersionBatch(wsId, batch, signal).then(requireCockpitReadResult)));
      return { workspaceId: wsId, requestedIds: ids, items: pages.flatMap((page) => page.items), unavailableIds: pages.flatMap((page) => page.unavailableIds) };
    },
  });
}

export function cockpitInputsOptions(wsId: string, params: CockpitInputListQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.all(wsId), "list", query],
    queryFn: ({ signal }) => api.getCockpitInputs(wsId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId), retry: false,
  });
}

export function cockpitInputDetailOptions(wsId: string, inputId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "header"],
    queryFn: ({ signal }) => api.getCockpitInput(wsId, inputId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId), retry: false,
  });
}

export function cockpitInputVersionsOptions(wsId: string, inputId: string, params: CockpitInputPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "versions", query],
    queryFn: ({ signal }) => api.getCockpitInputVersions(wsId, inputId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId), retry: false,
  });
}

export function cockpitInputVersionOptions(wsId: string, inputId: string, versionId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "version", versionId],
    queryFn: ({ signal }) => api.getCockpitInputVersion(wsId, inputId, versionId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId && versionId), retry: false,
  });
}

export function cockpitInputCreateCommandOptions(wsId: string, commandKey: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.all(wsId), "create-command", commandKey],
    queryFn: ({ signal }) => api.getCockpitInputCreateCommand(wsId, commandKey, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && commandKey), retry: false,
  });
}

export function cockpitInputVersionCommandOptions(wsId: string, inputId: string, commandKey: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "version-command", commandKey],
    queryFn: ({ signal }) => api.getCockpitInputVersionCommand(wsId, inputId, commandKey, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId && commandKey), retry: false,
  });
}

export function cockpitInputTransfersOptions(wsId: string, inputId: string, versionId: string, params: CockpitInputPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "transfers", versionId, query],
    queryFn: ({ signal }) => api.getCockpitInputTransfers(wsId, inputId, versionId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId && versionId), retry: false,
  });
}

export function cockpitInputTransferOptions(wsId: string, inputId: string, versionId: string, transferId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "transfer", versionId, transferId],
    queryFn: ({ signal }) => api.getCockpitInputTransfer(wsId, inputId, versionId, transferId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId && versionId && transferId), retry: false,
    refetchInterval: (query) => query.state.data && ["queued", "reading", "pinned", "writing", "verifying"].includes(query.state.data.state) ? 2_000 : false,
  });
}

export function cockpitInputRestartCommandOptions(wsId: string, inputId: string, versionId: string, commandKey: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "restart-command", versionId, commandKey],
    queryFn: ({ signal }) => api.getCockpitInputRestartCommand(wsId, inputId, versionId, commandKey, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId && versionId && commandKey), retry: false,
  });
}

export function cockpitInputTransferCommandOptions(wsId: string, inputId: string, versionId: string, transferId: string, commandKey: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.input(wsId, inputId), "transfer-command", versionId, transferId, commandKey],
    queryFn: ({ signal }) => api.getCockpitInputTransferCommand(wsId, inputId, versionId, transferId, commandKey, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && inputId && versionId && transferId && commandKey), retry: false,
  });
}

export function cockpitMeetingInputReferencesOptions(wsId: string, meetingId: string, params: CockpitInputPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.meeting(wsId, meetingId), "all", query],
    queryFn: ({ signal }) => api.getCockpitMeetingInputReferences(wsId, meetingId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && meetingId), retry: false,
  });
}

export function cockpitAgendaInputReferencesOptions(wsId: string, meetingId: string, agendaId: string, params: CockpitInputPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.meeting(wsId, meetingId), "agenda", agendaId, query],
    queryFn: ({ signal }) => api.getCockpitAgendaInputReferences(wsId, meetingId, agendaId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && meetingId && agendaId), retry: false,
  });
}

export function cockpitInputReferenceCommandOptions(wsId: string, meetingId: string, commandKey: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.meeting(wsId, meetingId), "command", commandKey],
    queryFn: ({ signal }) => api.getCockpitInputReferenceCommand(wsId, meetingId, commandKey, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && meetingId && commandKey), retry: false,
  });
}

export function cockpitIssueInputManifestOptions(wsId: string, issueId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.issue(wsId, issueId), "header"],
    queryFn: ({ signal }) => api.getCockpitIssueInputManifest(wsId, issueId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && issueId), retry: false,
  });
}

export function cockpitInputManifestVersionsOptions(wsId: string, issueId: string, params: CockpitInputPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.issue(wsId, issueId), "versions", query],
    queryFn: ({ signal }) => api.getCockpitInputManifestVersions(wsId, issueId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && issueId), retry: false,
  });
}

export function cockpitInputManifestVersionOptions(wsId: string, issueId: string, manifestVersionId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.issue(wsId, issueId), "version", manifestVersionId],
    queryFn: ({ signal }) => api.getCockpitInputManifestVersion(wsId, issueId, manifestVersionId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && issueId && manifestVersionId), retry: false,
  });
}

export function cockpitInputManifestItemsOptions(wsId: string, issueId: string, manifestVersionId: string, params: CockpitInputPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.issue(wsId, issueId), "items", manifestVersionId, query],
    queryFn: ({ signal }) => api.getCockpitInputManifestItems(wsId, issueId, manifestVersionId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && issueId && manifestVersionId), retry: false,
  });
}

export function cockpitInputManifestEditItemsOptions(wsId: string, issueId: string, version: CockpitInputManifestVersionMetadata | null) {
  return queryOptions({ queryKey: [...cockpitInputKeys.issue(wsId, issueId), "edit-items", version?.id ?? null, version?.manifestHash ?? null],
    enabled: Boolean(wsId && issueId), retry: false,
    queryFn: async ({ signal }) => {
      if (!version) return [];
      if (version.workspaceId !== wsId || version.issueId !== issueId || version.itemTotal > 200) throw new Error("input_manifest_scope_changed");
      const first = requireCockpitReadResult(await api.getCockpitInputManifestItems(wsId, issueId, version.id, { pageSize: 100 }, signal));
      const pages = [first];
      if (first.nextCursor) pages.push(requireCockpitReadResult(await api.getCockpitInputManifestItems(wsId, issueId, version.id, { pageSize: 100, cursor: first.nextCursor }, signal)));
      const items = pages.flatMap((page) => page.items);
      if (pages.at(-1)?.nextCursor || pages.some((page) => page.manifestHash !== version.manifestHash || page.total !== version.itemTotal)
        || items.length !== version.itemTotal || new Set(items.map((item) => item.inputVersionId)).size !== items.length
        || items.some((item, index) => item.position !== index)) throw new Error("input_manifest_incomplete");
      return items;
    },
  });
}

export function cockpitInputManifestCommandOptions(wsId: string, issueId: string, commandKey: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.issue(wsId, issueId), "command", commandKey],
    queryFn: ({ signal }) => api.getCockpitInputManifestCommand(wsId, issueId, commandKey, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && issueId && commandKey), retry: false,
  });
}

export function cockpitRunInputManifestOptions(wsId: string, taskId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.run(wsId, taskId)],
    queryFn: ({ signal }) => api.getCockpitRunInputManifest(wsId, taskId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && taskId), retry: false,
  });
}

export function cockpitInputSpacesOptions(wsId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.browse(wsId), "spaces"],
    queryFn: ({ signal }) => api.getCockpitInputSpaces(wsId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId), retry: false,
  });
}

export function cockpitInputEntriesOptions(wsId: string, rootId: string, body: CockpitInputNASBrowseInput) {
  return queryOptions({ queryKey: [...cockpitInputKeys.browse(wsId), "entries", rootId, body],
    queryFn: ({ signal }) => api.browseCockpitInputEntries(wsId, rootId, body, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && rootId), retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
  });
}

/** Cancel stale reads before refetching server-owned progress or references. */
export async function invalidateCockpitInputs(client: QueryClient, wsId: string) {
  const filters = { queryKey: cockpitInputKeys.all(wsId) };
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}


export function cockpitInputAttachmentsOptions(wsId: string, issueId: string, params: CockpitInputPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({
    queryKey: [...cockpitInputKeys.issue(wsId, issueId), "attachments", query],
    queryFn: ({ signal }) => api.getCockpitInputAttachments(wsId, issueId, query, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && issueId), retry: false,
  });
}


export function cockpitInputSelectedAttachmentOptions(wsId: string, issueId: string, attachmentId: string) {
  return queryOptions({
    queryKey: [...cockpitInputKeys.issue(wsId, issueId), "attachment", attachmentId],
    queryFn: ({ signal }) => api.getCockpitInputAttachment(wsId, issueId, attachmentId, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && issueId && attachmentId), retry: false,
  });
}

/** Header labels for an explicit selection; currentVersion never replaces a selected fixed version. */
export function cockpitInputSelectedHeadersOptions(wsId: string, inputIds: string[]) {
  const ids = [...inputIds];
  return queryOptions({
    queryKey: [...cockpitInputKeys.all(wsId), "selected-headers", ids],
    enabled: Boolean(wsId && ids.length), retry: false,
    queryFn: async ({ signal }) => {
      if (ids.length > 200 || new Set(ids).size !== ids.length) throw new Error("Invalid input header selection");
      const pages = await Promise.all([ids.slice(0, 100), ids.slice(100)].filter((batch) => batch.length)
        .map(async (batch) => {
          const page = requireCockpitReadResult(await api.getCockpitInputs(wsId, { ids: batch, archive: "all", pageSize: 100 }, signal));
          if (page.nextCursor || page.total !== page.items.length || page.items.some((item) => item.workspaceId !== wsId || !batch.includes(item.id))
            || new Set(page.items.map((item) => item.id)).size !== page.items.length) throw new Error("Incomplete selected input header response");
          return page.items;
        }));
      const items = new Map(pages.flat().map((item) => [item.id, item]));
      return { workspaceId: wsId, requestedIds: ids, items: ids.flatMap((id) => { const item = items.get(id); return item ? [item] : []; }), unavailableIds: ids.filter((id) => !items.has(id)) };
    },
  });
}


export async function invalidateCockpitInputReferenceContext(client: QueryClient, wsId: string, meetingId: string) {
  const keys = [[...cockpitReadKeys.all(wsId), "context"], cockpitPreparationKeys.basis(wsId, meetingId)];
  await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

/** A reclaimed Run keeps its manifest pin but has a new preparation state. */
export async function invalidateCockpitRunInputs(client: QueryClient, wsId: string, taskId: string) {
  const filter = { queryKey: cockpitInputKeys.run(wsId, taskId) };
  await client.cancelQueries(filter);
  await client.invalidateQueries(filter);
}
