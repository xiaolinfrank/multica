import type { LocaleResources } from "@multica/core/i18n";
import ruAgents from "./ru/agents.json";
import ruAuth from "./ru/auth.json";
import ruAutopilots from "./ru/autopilots.json";
import ruBilling from "./ru/billing.json";
import ruChat from "./ru/chat.json";
import ruCommon from "./ru/common.json";
import ruDocs from "./ru/docs.json";
import ruEditor from "./ru/editor.json";
import ruInbox from "./ru/inbox.json";
import ruInvite from "./ru/invite.json";
import ruIssues from "./ru/issues.json";
import ruLabels from "./ru/labels.json";
import ruLayout from "./ru/layout.json";
import ruMembers from "./ru/members.json";
import ruModals from "./ru/modals.json";
import ruMyIssues from "./ru/my-issues.json";
import ruOnboarding from "./ru/onboarding.json";
import ruProjects from "./ru/projects.json";
import ruRuntimes from "./ru/runtimes.json";
import ruSearch from "./ru/search.json";
import ruSettings from "./ru/settings.json";
import ruSkills from "./ru/skills.json";
import ruSquads from "./ru/squads.json";
import ruUi from "./ru/ui.json";
import ruUsage from "./ru/usage.json";
import ruWorkspace from "./ru/workspace.json";

const resources: LocaleResources = {
  agents: ruAgents,
  auth: ruAuth,
  autopilots: ruAutopilots,
  billing: ruBilling,
  chat: ruChat,
  common: ruCommon,
  docs: ruDocs,
  editor: ruEditor,
  inbox: ruInbox,
  invite: ruInvite,
  issues: ruIssues,
  labels: ruLabels,
  layout: ruLayout,
  members: ruMembers,
  modals: ruModals,
  "my-issues": ruMyIssues,
  onboarding: ruOnboarding,
  projects: ruProjects,
  runtimes: ruRuntimes,
  search: ruSearch,
  settings: ruSettings,
  skills: ruSkills,
  squads: ruSquads,
  ui: ruUi,
  usage: ruUsage,
  workspace: ruWorkspace,
};

export default resources;
