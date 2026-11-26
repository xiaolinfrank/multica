"use client";

import { createStore, type StoreApi } from "zustand/vanilla";
import { persist } from "zustand/middleware";
import {
  type IssueViewState,
  viewStoreSlice,
  viewStorePersistOptions,
  mergeViewStatePersisted,
} from "./view-store";
import { registerForWorkspaceRehydration } from "../../platform/workspace-storage";

export type ActorIssuesScope = "assigned" | "created";

export interface ActorIssuesViewState extends IssueViewState {
  scope: ActorIssuesScope;
  setScope: (scope: ActorIssuesScope) => void;
}

const basePersist = viewStorePersistOptions("multica_actor_issues_view");

const _actorIssuesViewStore = createStore<ActorIssuesViewState>()(
  persist(
    (set) => ({
      ...viewStoreSlice(set as unknown as StoreApi<IssueViewState>["setState"]),
      // Actor tasks panel is list-only; override the slice's "table" default.
      viewMode: "list",
      scope: "assigned" as ActorIssuesScope,
      setScope: (scope: ActorIssuesScope) => set({ scope }),
    }),
    {
      name: basePersist.name,
      version: basePersist.version,
      storage: basePersist.storage,
      partialize: (state: ActorIssuesViewState) => ({
        ...basePersist.partialize(state),
        scope: state.scope,
      }),
      // Same shared table-column migration as the my-issues store; its own
      // `scope` field is preserved by the spread.
      migrate: (persisted, version) =>
        basePersist.migrate(persisted, version) as ActorIssuesViewState,
      merge: mergeViewStatePersisted<ActorIssuesViewState>,
    },
  ),
);

export const actorIssuesViewStore: StoreApi<ActorIssuesViewState> =
  _actorIssuesViewStore;

registerForWorkspaceRehydration(() =>
  _actorIssuesViewStore.persist.rehydrate(),
);
