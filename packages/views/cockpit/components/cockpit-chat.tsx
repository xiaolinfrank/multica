"use client";

import { cockpitSurfacePath, type CockpitScope } from "@multica/core/cockpit";
import { ChatPageSurface } from "../../chat";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";

export function CockpitChat({ scope }: { scope: CockpitScope }) {
  const { t } = useT("cockpit");
  const { pathname } = useNavigation();
  return <ChatPageSurface routeHref={cockpitSurfacePath(pathname, "chat", scope)}
    defaultAgentSystemKey="mika" defaultProjectId={scope.projectId} title={t(($) => $.shell.chat)}
    initialContext={t(($) => $.chat.context, { project: scope.projectId ?? "*", module: scope.moduleId ?? "*" })}
    conversationStarters={[
      { label: t(($) => $.chat.overview_label), prompt: t(($) => $.chat.overview_prompt) },
      { label: t(($) => $.chat.plan_label), prompt: t(($) => $.chat.plan_prompt) },
      { label: t(($) => $.chat.meeting_label), prompt: t(($) => $.chat.meeting_prompt) },
    ]} />;
}
