import { z } from "zod";
import { CockpitIssueLinkSchema, CockpitMeetingIssueLinkSchema, CockpitMeetingNodeLinkSchema } from "./schemas";

const issueFacts = { issue_id: z.string().min(1), issue_number: z.number().int().positive(), issue_identifier: z.string().min(1),
  issue_title: z.string(), issue_status: z.string(), position: z.number() };
export const CockpitNodeIssueLinkReceiptSchema = z.object({
  workspace_id: z.string().min(1), node_id: z.string().min(1),
  link: CockpitIssueLinkSchema.extend({ ...issueFacts, id: z.string().min(1), node_id: z.string().min(1) }),
});
export const CockpitMeetingIssueLinkReceiptSchema = z.object({
  workspace_id: z.string().min(1), meeting_id: z.string().min(1),
  link: CockpitMeetingIssueLinkSchema.extend({ ...issueFacts, meeting_id: z.string().min(1), role: z.string(), roles: z.array(z.string()), required_roles: z.array(z.string()) }),
});
export const CockpitMeetingNodeLinkReceiptSchema = z.object({
  workspace_id: z.string().min(1), meeting_id: z.string().min(1),
  link: CockpitMeetingNodeLinkSchema.extend({ meeting_id: z.string().min(1), node_id: z.string().min(1), position: z.number() }),
});
