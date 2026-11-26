import type { LocaleResources } from "@multica/core/i18n";
import esAgents from "./es/agents.json";
import esAuth from "./es/auth.json";
import esAutopilots from "./es/autopilots.json";
import esBilling from "./es/billing.json";
import esChat from "./es/chat.json";
import esCommon from "./es/common.json";
import esDocs from "./es/docs.json";
import esEditor from "./es/editor.json";
import esInbox from "./es/inbox.json";
import esInvite from "./es/invite.json";
import esIssues from "./es/issues.json";
import esLabels from "./es/labels.json";
import esLayout from "./es/layout.json";
import esMembers from "./es/members.json";
import esModals from "./es/modals.json";
import esMyIssues from "./es/my-issues.json";
import esOnboarding from "./es/onboarding.json";
import esProjects from "./es/projects.json";
import esRuntimes from "./es/runtimes.json";
import esSearch from "./es/search.json";
import esSettings from "./es/settings.json";
import esSkills from "./es/skills.json";
import esSquads from "./es/squads.json";
import esUi from "./es/ui.json";
import esUsage from "./es/usage.json";
import esWorkspace from "./es/workspace.json";

const resources: LocaleResources = {
  agents: esAgents,
  auth: esAuth,
  autopilots: esAutopilots,
  billing: esBilling,
  chat: esChat,
  common: esCommon,
  docs: esDocs,
  editor: esEditor,
  inbox: esInbox,
  invite: esInvite,
  issues: esIssues,
  labels: esLabels,
  layout: esLayout,
  members: esMembers,
  modals: esModals,
  "my-issues": esMyIssues,
  onboarding: esOnboarding,
  projects: esProjects,
  runtimes: esRuntimes,
  search: esSearch,
  settings: esSettings,
  skills: esSkills,
  squads: esSquads,
  ui: esUi,
  usage: esUsage,
  workspace: esWorkspace,
};

export default resources;
