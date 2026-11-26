import type { LocaleResources } from "@multica/core/i18n";
import koAgents from "./ko/agents.json";
import koAuth from "./ko/auth.json";
import koAutopilots from "./ko/autopilots.json";
import koBilling from "./ko/billing.json";
import koChat from "./ko/chat.json";
import koCockpit from "./ko/cockpit.json";
import koCommon from "./ko/common.json";
import koDocs from "./ko/docs.json";
import koEditor from "./ko/editor.json";
import koEnv from "./ko/env.json";
import koFleet from "./ko/fleet.json";
import koGallery from "./ko/gallery.json";
import koGraph from "./ko/graph.json";
import koInbox from "./ko/inbox.json";
import koInvite from "./ko/invite.json";
import koIssues from "./ko/issues.json";
import koLabels from "./ko/labels.json";
import koLayout from "./ko/layout.json";
import koMembers from "./ko/members.json";
import koModals from "./ko/modals.json";
import koMyIssues from "./ko/my-issues.json";
import koOffice from "./ko/office.json";
import koOnboarding from "./ko/onboarding.json";
import koProjects from "./ko/projects.json";
import koRuntimes from "./ko/runtimes.json";
import koSearch from "./ko/search.json";
import koSettings from "./ko/settings.json";
import koSkills from "./ko/skills.json";
import koSquads from "./ko/squads.json";
import koUi from "./ko/ui.json";
import koUsage from "./ko/usage.json";
import koWorkspace from "./ko/workspace.json";
import koWorkspaces from "./ko/workspaces.json";

const resources: LocaleResources = {
  agents: koAgents,
  auth: koAuth,
  autopilots: koAutopilots,
  billing: koBilling,
  chat: koChat,
  cockpit: koCockpit,
  common: koCommon,
  docs: koDocs,
  editor: koEditor,
  env: koEnv,
  fleet: koFleet,
  gallery: koGallery,
  graph: koGraph,
  inbox: koInbox,
  invite: koInvite,
  issues: koIssues,
  labels: koLabels,
  layout: koLayout,
  members: koMembers,
  modals: koModals,
  "my-issues": koMyIssues,
  office: koOffice,
  onboarding: koOnboarding,
  projects: koProjects,
  runtimes: koRuntimes,
  search: koSearch,
  settings: koSettings,
  skills: koSkills,
  squads: koSquads,
  ui: koUi,
  usage: koUsage,
  workspace: koWorkspace,
  workspaces: koWorkspaces,
};

export default resources;
