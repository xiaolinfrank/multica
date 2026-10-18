"use client";
import { issueKeys } from "../issues/queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type * as Input from "../types/cockpit-input";
import type { CockpitInputPendingCommand } from "./input-draft-store";
import {
  cockpitInputCreateAcknowledged, cockpitInputVersionAcknowledged, cockpitInputTransferAcknowledged,
  cockpitInputManifestAcknowledged,
} from "./input-commands";
import { CockpitUnconfirmedWriteError } from "./errors";
import { invalidateCockpitInputs } from "./input-queries";

/** Lookup never falls through to a POST, including a 404 or malformed receipt. */
export async function executeCockpitInputCommand(wsId: string, command: CockpitInputPendingCommand, mode: "submit" | "lookup" = "submit") {
  const lookup = mode === "lookup";
  switch (command.kind) {
    case "create": {
      const result = lookup ? await api.getCockpitInputCreateCommand(wsId, command.body.commandKey) : await api.createCockpitInput(wsId, command.body);
      if (!result || !cockpitInputCreateAcknowledged(result, command.body)) throw new CockpitUnconfirmedWriteError();
      return { kind: command.kind, result };
    }
    case "version": {
      const result = lookup ? await api.getCockpitInputVersionCommand(wsId, command.inputId, command.body.commandKey) : await api.submitCockpitInputVersion(wsId, command.inputId, command.body);
      if (!result || !cockpitInputVersionAcknowledged(result, command.inputId, command.body)) throw new CockpitUnconfirmedWriteError();
      return { kind: command.kind, result };
    }
    case "restart": {
      const result = lookup ? await api.getCockpitInputRestartCommand(wsId, command.inputId, command.versionId, command.body.commandKey) : await api.restartCockpitInputTransfer(wsId, command.inputId, command.versionId, command.body);
      if (!result || !cockpitInputTransferAcknowledged(result, command.inputId, command.versionId, command.body)) throw new CockpitUnconfirmedWriteError();
      return { kind: command.kind, result };
    }
    case "finalize":
    case "abandon": {
      const result = lookup ? await api.getCockpitInputTransferCommand(wsId, command.inputId, command.versionId, command.transferId, command.body.commandKey)
        : command.kind === "finalize" ? await api.finalizeCockpitInputTransfer(wsId, command.inputId, command.versionId, command.transferId, command.body)
          : await api.abandonCockpitInputTransfer(wsId, command.inputId, command.versionId, command.transferId, command.body);
      if (!result || !cockpitInputTransferAcknowledged(result, command.inputId, command.versionId, command.body, command.transferId)) throw new CockpitUnconfirmedWriteError();
      return { kind: command.kind, result };
    }
    case "manifest": {
      const result = lookup ? await api.getCockpitInputManifestCommand(wsId, command.issueId, command.body.commandKey) : await api.saveCockpitIssueInputManifest(wsId, command.issueId, command.body);
      if (!result || !cockpitInputManifestAcknowledged(result, command.issueId, command.body)) throw new CockpitUnconfirmedWriteError();
      return { kind: command.kind, result };
    }
  }
}

export function useCockpitInputCommand(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-input-command", wsId], retry: false,
    mutationFn: ({ command, mode }: { command: CockpitInputPendingCommand; mode?: "submit" | "lookup" }) => executeCockpitInputCommand(wsId, command, mode),
    onSettled: async (_data, _error) => {
      await invalidateCockpitInputs(client, wsId);
    },
  });
}

export function useUploadCockpitInputBytes(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-input-bytes", wsId], retry: false,
    mutationFn: async (body: { inputId: string; versionId: string; transferId: string; revision: number; file: Blob; signal?: AbortSignal }) => {
      const result = await api.uploadCockpitInputBytes(wsId, body.inputId, body.versionId, body.transferId, body.revision, body.file, body.signal);
      if (!result) throw new CockpitUnconfirmedWriteError();
      return result;
    }, onSettled: () => invalidateCockpitInputs(client, wsId),
  });
}

function useInputEdit<Body>(wsId: string, inputId: string, kind: string, mutationFn: (body: Body) => Promise<Input.CockpitInputHeader | null>) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-input-edit", wsId, inputId, kind], retry: false,
    mutationFn: async (body: Body) => {
      const result = await mutationFn(body);
      if (!result) throw new CockpitUnconfirmedWriteError();
      return result;
    },
    onSettled: () => invalidateCockpitInputs(client, wsId) });
}
export function useEditCockpitInput(wsId: string, inputId: string) {
  return useInputEdit(wsId, inputId, "metadata", async (body: Input.CockpitInputEditInput) => {
    const result = await api.editCockpitInput(wsId, inputId, body);
    if (result && (result.title !== body.title.trim() || result.description !== body.description || result.revision <= body.expectedRevision)) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useArchiveCockpitInput(wsId: string, inputId: string) {
  return useInputEdit(wsId, inputId, "archive", async (body: Input.CockpitInputArchiveInput) => {
    const result = await api.archiveCockpitInput(wsId, inputId, body);
    if (result && (Boolean(result.archivedAt) !== body.archived || result.revision <= body.expectedRevision)) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useVerifyCockpitInputVersion(wsId: string, inputId: string, versionId: string) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-input-verify", wsId, inputId, versionId], mutationFn: async () => {
      const result = await api.verifyCockpitInputVersion(wsId, inputId, versionId);
      if (!result) throw new CockpitUnconfirmedWriteError();
      return result;
    }, retry: false,
    onSettled: () => invalidateCockpitInputs(client, wsId) });
}


/** An explicit new Run uses the observed saved manifest; it never retries itself. */
export function useRerunIssueWithInputs(wsId: string, issueId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["cockpit-input-new-run", wsId, issueId], retry: false,
    mutationFn: (manifestVersionId: string) => api.rerunIssue(issueId, undefined, {
      expectedInputManifestVersionId: manifestVersionId, workspaceId: wsId,
    }),
    onSettled: async () => {
      await Promise.all([
        invalidateCockpitInputs(client, wsId),
        client.invalidateQueries({ queryKey: issueKeys.tasks(issueId) }),
        client.invalidateQueries({ queryKey: issueKeys.timeline(issueId) }),
      ]);
    },
  });
}
