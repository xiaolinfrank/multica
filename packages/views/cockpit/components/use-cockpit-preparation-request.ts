"use client";

import { useRef, useState } from "react";
import { ApiError } from "@multica/core/api";
import {
  isCockpitDefinitiveCommandRejection, prepareCockpitPreparationCommand, settleCockpitPreparationCommand,
  useCockpitMeetingPreparationDraftStore, type CockpitPreparationPendingCommand,
} from "@multica/core/cockpit";
import { useNavigation } from "../../navigation";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

/** A valid read found no fixed receipt yet; it permits only an explicit same-key retry. */
export class CockpitPreparationUnobservedError extends Error {}

/** Rejection ends the reviewed confirmation, while ambiguous writes keep their frozen command. */
export function useCockpitPreparationConfirmation(cause: unknown) {
  const [checked, setConfirmed] = useState(false);
  const [reviewedRejection, setReviewedRejection] = useState<unknown>(null);
  const rejected = isCockpitDefinitiveCommandRejection(cause);
  const reviewRequired = rejected && reviewedRejection !== cause;
  return {
    confirmed: checked && !reviewRequired, setConfirmed, reviewRequired,
    showError: !rejected || reviewRequired,
    previewAccepted() { setConfirmed(false); setReviewedRejection(() => cause); },
  };
}

/** A receipt may settle its original intent even after navigation, but cannot control a newer dialog. */
export function useCockpitPreparationRequest(draftKey: string) {
  const navigation = useNavigation(); const capture = useCockpitCommandContext(draftKey);
  const signature = JSON.stringify([draftKey, navigation.pathname, navigation.searchParams.toString()]);
  const generation = useRef({ signature, value: 0 });
  if (generation.current.signature !== signature) generation.current = { signature, value: generation.current.value + 1 };
  const identity = generation.current.value;
  const lock = useRef<{ identity: number; token: symbol } | null>(null);
  const observed = useRef<{ identity: number; command: CockpitPreparationPendingCommand } | null>(null);
  const [state, setState] = useState<{ identity: number; busy: boolean; error: string; missingKey: string | null; cause: unknown }>({ identity, busy: false, error: "", missingKey: null, cause: null });
  const pending = useCockpitMeetingPreparationDraftStore((store) => store.draft.commands[draftKey]);

  async function request<T>(command: CockpitPreparationPendingCommand, execute: (command: CockpitPreparationPendingCommand) => Promise<T>, lookup: boolean) {
    if (lock.current?.identity === identity) return null;
    const current = capture(); const token = Symbol("preparation-request"); const key = draftKey;
    observed.current = { identity, command };
    lock.current = { identity, token }; setState({ identity, busy: true, error: "", missingKey: null, cause: null });
    try {
      const result = await execute(command);
      settleCockpitPreparationCommand(key, command.body.command_key, command.kind === "effect" ? command.body : undefined);
      return { result, command, stillCurrent: current };
    } catch (cause) {
      // A failed GET, including 404, cannot prove that an earlier write will not commit.
      if (!lookup && isCockpitDefinitiveCommandRejection(cause)) settleCockpitPreparationCommand(key, command.body.command_key, command.kind === "effect" ? command.body : undefined);
      if (current()) setState({ identity, busy: true, error: cause instanceof Error ? cause.message : String(cause), missingKey: lookup && (cause instanceof ApiError && cause.status === 404 || cause instanceof CockpitPreparationUnobservedError) ? command.body.command_key : null, cause });
      return null;
    } finally {
      if (lock.current?.token === token) {
        lock.current = null;
        if (current()) setState((state) => state.identity === identity ? { ...state, busy: false } : state);
      }
    }
  }

  return {
    pending, busy: state.identity === identity && state.busy, error: state.identity === identity ? state.error : "",
    canRetry: state.identity === identity && state.missingKey === pending?.body.command_key,
    cause: state.identity === identity ? state.cause : null,
    observedCommand: observed.current?.identity === identity ? observed.current.command : null,
    async run<T>(candidate: CockpitPreparationPendingCommand, execute: (command: CockpitPreparationPendingCommand) => Promise<T>) {
      if (lock.current?.identity === identity) return null;
      const command = prepareCockpitPreparationCommand(draftKey, candidate);
      return request(command, execute, false);
    },
    async verify<T>(readAndCheck: (command: CockpitPreparationPendingCommand) => Promise<T>) {
      const command = useCockpitMeetingPreparationDraftStore.getState().draft.commands[draftKey];
      return command ? request(command, readAndCheck, true) : null;
    },
  };
}
