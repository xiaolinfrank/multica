import type { CockpitSnapshot } from "@multica/core/types/cockpit";

/** A run of two or more consecutive 'auto' snapshots by the same actor. */
export interface SnapshotRun {
  snapshots: CockpitSnapshot[];
  actor: string;
}

/**
 * One renderable row of the version history: a lone snapshot, or a collapsed
 * run of auto checkpoints.
 */
export type VersionHistoryEntry =
  | { kind: "single"; snapshot: CockpitSnapshot }
  | { kind: "run"; run: SnapshotRun };

/**
 * Folds dense auto-checkpoint noise out of the version history: two or more
 * consecutive 'auto' snapshots by the same actor collapse into one row.
 * Manual saves and pre-import/restore freezes are deliberate milestones and
 * always render alone — and one landing in the middle breaks the run, so each
 * actor's churn stays grouped on its own side of it.
 */
export function groupVersionHistory(snapshots: CockpitSnapshot[]): VersionHistoryEntry[] {
  const entries: VersionHistoryEntry[] = [];
  let chain: CockpitSnapshot[] = [];
  let chainActor = "";

  const flush = () => {
    if (chain.length === 0) return;
    if (chain.length === 1) {
      entries.push({ kind: "single", snapshot: chain[0]! });
    } else {
      entries.push({ kind: "run", run: { snapshots: chain, actor: chainActor } });
    }
    chain = [];
    chainActor = "";
  };

  for (const snapshot of snapshots) {
    if (snapshot.trigger_kind === "auto" && chain.length > 0 && snapshot.created_by_label === chainActor) {
      chain.push(snapshot);
      continue;
    }
    flush();
    if (snapshot.trigger_kind === "auto") {
      chain = [snapshot];
      chainActor = snapshot.created_by_label;
    } else {
      entries.push({ kind: "single", snapshot });
    }
  }
  flush();
  return entries;
}
