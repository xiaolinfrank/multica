"use client";

import { useRef, useState } from "react";
import { ApiError } from "@multica/core/api";
import {
  isCockpitDefinitiveCommandRejection, prepareCockpitInputCommand, settleCockpitInputCommand,
  useCockpitInputCommand, useCockpitInputDraftStore, type CockpitInputPendingCommand,
} from "@multica/core/cockpit";
import { useNavigation } from "../../navigation";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

export function useCockpitInputRequest(wsId: string, draftKey: string) {
  const mutation = useCockpitInputCommand(wsId);
  const capture = useCockpitCommandContext(draftKey);
  const navigation = useNavigation();
  const signature = JSON.stringify([wsId, draftKey, navigation.pathname, navigation.searchParams.toString()]);
  const scope = useRef({ signature, generation: 0 });
  if (scope.current.signature !== signature) scope.current = { signature, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const lock = useRef<{ generation: number; token: symbol } | null>(null);
  const [state, setState] = useState<{ generation: number; busy: boolean; error: string; cause: unknown; missingKey: string | null }>({ generation, busy: false, error: "", cause: null, missingKey: null });
  const pending = useCockpitInputDraftStore((store) => store.draft.commands[draftKey]);

  const execute = async (candidate: CockpitInputPendingCommand, mode: "submit" | "lookup") => {
    if (lock.current?.generation === generation) return null;
    const current = capture();
    const token = Symbol("input-command");
    lock.current = { generation, token };
    setState({ generation, busy: true, error: "", cause: null, missingKey: null });
    let command = candidate;
    try {
      command = mode === "submit" ? prepareCockpitInputCommand(draftKey, candidate) : candidate;
      const acknowledged = await mutation.mutateAsync({ command, mode });
      if (current()) settleCockpitInputCommand(draftKey, command.body.commandKey);
      return { acknowledged, command, stillCurrent: current };
    } catch (cause) {
      if (current() && mode === "submit" && isCockpitDefinitiveCommandRejection(cause)) settleCockpitInputCommand(draftKey, command.body.commandKey);
      if (current()) setState({ generation, busy: true, error: cause instanceof Error ? cause.message : String(cause), cause,
        missingKey: mode === "lookup" && cause instanceof ApiError && cause.status === 404 ? command.body.commandKey : null });
      return null;
    } finally {
      if (lock.current?.token === token) {
        lock.current = null;
        if (current()) setState((value) => value.generation === generation ? { ...value, busy: false } : value);
      }
    }
  };
  return {
    pending,
    busy: state.generation === generation && state.busy,
    error: state.generation === generation ? state.error : "",
    cause: state.generation === generation ? state.cause : null,
    canRetry: state.generation === generation && Boolean(state.missingKey && state.missingKey === pending?.body.commandKey),
    run: (candidate: CockpitInputPendingCommand) => execute(candidate, "submit"),
    verify() {
      const original = useCockpitInputDraftStore.getState().draft.commands[draftKey];
      return original ? execute(original, "lookup") : Promise.resolve(null);
    },
  };
}

export type CockpitInputAcknowledgement = NonNullable<Awaited<ReturnType<ReturnType<typeof useCockpitInputRequest>["run"]>>>;
