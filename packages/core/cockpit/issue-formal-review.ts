"use client";

import { useQuery } from "@tanstack/react-query";
import type { CockpitIssueFormalReview } from "../types";
import { cockpitContextOptions } from "./read-queries";
import { cockpitIssueArtifactsOptions } from "./artifact-responsibility-queries";
import { EMPTY_COCKPIT_SCOPE } from "./navigation";

/** The page header is authoritative across every page; rows are never used as a permission summary. */
export function useCockpitIssueFormalReview(wsId: string, issueId: string) {
  const active = Boolean(wsId && issueId);
  const context = useQuery({ ...cockpitContextOptions(wsId, EMPTY_COCKPIT_SCOPE), enabled: active });
  const enabled = active && context.data?.capabilities?.artifacts === true;
  const facts = useQuery({ ...cockpitIssueArtifactsOptions(wsId, issueId), enabled });
  return {
    review: enabled ? facts.data?.formal_review ?? null : null,
    isPending: active && (context.isPending || (enabled && facts.isPending)),
    isError: active && (context.isError || (enabled && facts.isError)),
    refetch: async () => {
      const fresh = await context.refetch();
      return fresh.isSuccess && fresh.data.capabilities?.artifacts === true ? facts.refetch() : fresh;
    },
  };
}

export function cockpitFormalReviewAllowsStatus(review: CockpitIssueFormalReview | null | undefined, category: string): boolean {
  if (!review) return true;
  if (review.stage === "pending") return ["triage", "backlog", "unstarted", "started"].includes(category);
  return (review.stage === "done" || review.stage === "closed") && category === review.stage;
}
