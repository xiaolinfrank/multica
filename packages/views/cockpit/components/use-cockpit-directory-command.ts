"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import {
  cockpitDirectoryCommandAcknowledged, cockpitLifecycleCommandOptions, invalidateCockpitMeetingDirectoryFacts,
  isCockpitDefinitiveCommandRejection, prepareCockpitDirectoryCommand, settleCockpitDirectoryCommand, useCockpitMeetingDirectoryDraftStore,
  useCreateCockpitMeetingDirectory, useRetryCockpitDirectory, useControlCockpitDirectory, type CockpitDirectoryPendingCommand,
} from "@multica/core/cockpit";
import { useNavigation } from "../../navigation";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

function actionOf(command: CockpitDirectoryPendingCommand) {
  return command.kind === "prepare" ? "directory_prepare" : command.kind === "retry" ? "directory_retry" : `directory_${command.body.transition}`;
}

/** Background directory work continues independently; this guard protects only the reader's current form. */
export function useCockpitDirectoryCommand(wsId: string, meetingId: string, draftKey: string, operationId = "") {
  const client = useQueryClient(); const navigation = useNavigation(); const capture = useCockpitCommandContext(draftKey);
  const create = useCreateCockpitMeetingDirectory(wsId, meetingId), retry = useRetryCockpitDirectory(wsId, meetingId, operationId), control = useControlCockpitDirectory(wsId, meetingId, operationId);
  const signature = JSON.stringify([wsId, meetingId, operationId, draftKey, navigation.pathname, navigation.searchParams.toString()]);
  const scope = useRef({ signature, generation: 0 });
  if (scope.current.signature !== signature) scope.current = { signature, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const lock = useRef<{ generation: number; token: symbol } | null>(null);
  const observed = useRef<{ generation: number; command: CockpitDirectoryPendingCommand } | null>(null);
  const [state, setState] = useState<{ generation: number; busy: boolean; error: string; cause: unknown; missingKey: string | null }>({ generation, busy: false, error: "", cause: null, missingKey: null });
  const pending = useCockpitMeetingDirectoryDraftStore((store) => store.draft.commands[draftKey]);

  const execute = async (command: CockpitDirectoryPendingCommand, lookup: boolean) => {
    if (lock.current?.generation === generation) return null;
    const current = capture(), token = Symbol("directory-command"); observed.current = { generation, command };
    lock.current = { generation, token }; setState({ generation, busy: true, error: "", cause: null, missingKey: null });
    try {
      if (command.meetingId !== meetingId || "operationId" in command && command.operationId !== operationId) throw new Error("directory_command_scope_changed");
      const result = lookup
        ? await client.fetchQuery({ ...cockpitLifecycleCommandOptions(wsId, meetingId, command.body.command_key), staleTime: 0 })
        : command.kind === "prepare" ? await create.mutateAsync(command.body)
          : command.kind === "retry" ? await retry.mutateAsync(command.body) : await control.mutateAsync(command.body);
      if (!result || !cockpitDirectoryCommandAcknowledged(result, actionOf(command), command.body, "operationId" in command ? command.operationId : undefined)) throw new Error("directory_command_unconfirmed");
      const receipt = "directory_operation_id" in result.receipt ? result.receipt : result.receipt.directory;
      if (!receipt) throw new Error("directory_command_unconfirmed");
      settleCockpitDirectoryCommand(draftKey, command.body.command_key);
      if (lookup) await invalidateCockpitMeetingDirectoryFacts(client, wsId, meetingId);
      return { receipt, command, stillCurrent: current };
    } catch (cause) {
      if (!lookup && isCockpitDefinitiveCommandRejection(cause)) settleCockpitDirectoryCommand(draftKey, command.body.command_key);
      if (current()) setState({ generation, busy: true, error: cause instanceof Error ? cause.message : String(cause), cause,
        missingKey: lookup && cause instanceof ApiError && cause.status === 404 ? command.body.command_key : null });
      return null;
    } finally {
      if (lock.current?.token === token) { lock.current = null; if (current()) setState((value) => value.generation === generation ? { ...value, busy: false } : value); }
    }
  };

  return {
    pending, busy: state.generation === generation && state.busy, error: state.generation === generation ? state.error : "",
    cause: state.generation === generation ? state.cause : null,
    observedCommand: observed.current?.generation === generation ? observed.current.command : null,
    canRetry: state.generation === generation && state.missingKey === pending?.body.command_key,
    run(candidate: CockpitDirectoryPendingCommand) {
      if (lock.current?.generation === generation) return Promise.resolve(null);
      return execute(prepareCockpitDirectoryCommand(draftKey, candidate), false);
    },
    verify() {
      const original = useCockpitMeetingDirectoryDraftStore.getState().draft.commands[draftKey];
      return original ? execute(original, true) : Promise.resolve(null);
    },
  };
}
