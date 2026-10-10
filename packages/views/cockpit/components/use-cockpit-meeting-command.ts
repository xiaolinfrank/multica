"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  cockpitLifecycleCommandOptions, cockpitLifecycleAcknowledged, invalidateCockpitMeetingCommandFacts, CockpitUnconfirmedWriteError,
  isCockpitDefinitiveCommandRejection, prepareCockpitMeetingCommand, settleCockpitMeetingCommand,
  useCockpitMeetingAgendaDraftStore, useCockpitOccurrence, useCockpitMaterialsConfirmation,
  useCreateCockpitAgenda, useUpdateCockpitAgenda, useRemoveCockpitAgenda,
  useAttachCockpitAgendaReference, useRemoveCockpitAgendaReference, useCreateCockpitPreparationIssue,
  type CockpitMeetingPendingCommand,
} from "@multica/core/cockpit";
import { useNavigation } from "../../navigation";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

/** Commands keep their original body through ambiguous errors and dialog re-opening. */
export function useCockpitMeetingCommand(wsId: string, meetingId: string, key: string) {
  const client = useQueryClient();
  const occurrence = useCockpitOccurrence(wsId, meetingId);
  const materials = useCockpitMaterialsConfirmation(wsId, meetingId);
  const create = useCreateCockpitAgenda(wsId, meetingId);
  const update = useUpdateCockpitAgenda(wsId, meetingId);
  const remove = useRemoveCockpitAgenda(wsId, meetingId);
  const attach = useAttachCockpitAgendaReference(wsId, meetingId);
  const detach = useRemoveCockpitAgendaReference(wsId, meetingId);
  const preparation = useCreateCockpitPreparationIssue(wsId, meetingId);
  const pending = useCockpitMeetingAgendaDraftStore((state) => state.draft.commands[key]);
  const capture = useCockpitCommandContext(key); const navigation = useNavigation();
  const signature = JSON.stringify([key, navigation.pathname, navigation.searchParams.toString()]);
  const current = useRef<{ signature: string; generation: number; token: object | null }>({ signature, generation: 0, token: null });
  if (current.current.signature !== signature) current.current = { signature, generation: current.current.generation + 1, token: null };
  const generation = current.current.generation;
  const [activity, setActivity] = useState({ generation, busy: false, error: "" });
  const busy = activity.generation === generation && activity.busy;
  const error = activity.generation === generation ? activity.error : "";
  const begin = () => {
    if (current.current.token) return null;
    const token = {}; current.current.token = token; const observed = generation; const stillCurrent = capture();
    const ownsActivity = () => current.current.generation === observed && current.current.token === token;
    setActivity({ generation: observed, busy: true, error: "" });
    return { stillCurrent, fail: (cause: unknown) => { if (ownsActivity() && stillCurrent()) setActivity({ generation: observed, busy: true, error: cause instanceof Error ? cause.message : String(cause) }); },
      finish: () => { if (ownsActivity()) { current.current.token = null; setActivity((value) => value.generation === observed ? { ...value, busy: false } : value); } } };
  };
  const send = (command: CockpitMeetingPendingCommand) => {
    switch (command.kind) {
      case "occurrence": return occurrence.mutateAsync(command.body);
      case "materials": return materials.mutateAsync(command.body);
      case "agenda_create": return create.mutateAsync(command.body);
      case "agenda_update": return update.mutateAsync({ agendaId: command.agendaId, body: command.body });
      case "agenda_remove": return remove.mutateAsync({ agendaId: command.agendaId, body: command.body });
      case "reference_attach": return attach.mutateAsync({ agendaId: command.agendaId, body: command.body });
      case "reference_remove": return detach.mutateAsync({ agendaId: command.agendaId, referenceId: command.referenceId, body: command.body });
      case "preparation_issue_create": return preparation.mutateAsync({ agendaId: command.agendaId, body: command.body });
    }
  };
  const run = async (candidate: CockpitMeetingPendingCommand) => {
    const operation = begin(); if (!operation) return null;
    const command = prepareCockpitMeetingCommand(key, candidate); const { stillCurrent } = operation;
    try {
      const result = await send(command);
      settleCockpitMeetingCommand(key, command.body.command_key);
      return { result, stillCurrent };
    } catch (cause) {
      if (isCockpitDefinitiveCommandRejection(cause)) settleCockpitMeetingCommand(key, command.body.command_key);
      operation.fail(cause);
      return null;
    } finally { operation.finish(); }
  };
  const verify = async () => {
    if (!pending) return null;
    const operation = begin(); if (!operation) return null; const { stillCurrent } = operation;
    try {
      const result = await client.fetchQuery({ ...cockpitLifecycleCommandOptions(wsId, meetingId, pending.body.command_key), staleTime: 0 });
      const action = pending.kind === "occurrence" ? pending.body.transition : pending.kind;
      if (!cockpitLifecycleAcknowledged(result, action, pending.body, "agendaId" in pending ? pending.agendaId : undefined, "referenceId" in pending ? pending.referenceId : undefined)) throw new CockpitUnconfirmedWriteError();
      settleCockpitMeetingCommand(key, pending.body.command_key);
      invalidateCockpitMeetingCommandFacts(client, wsId, meetingId, action);
      return { result, stillCurrent };
    } catch (cause) {
      // A missing read is not proof that an in-flight command will never commit.
      operation.fail(cause);
      return null;
    } finally { operation.finish(); }
  };
  return { pending, busy, error, run, verify };
}
