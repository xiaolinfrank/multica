import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { CockpitScope } from "@multica/core/cockpit";
import { renderWithI18n } from "../../test/i18n";
import { CockpitChat } from "./cockpit-chat";

const chatSurface = vi.hoisted(() => vi.fn());

// Keep the production translations and Markdown pipeline; replace only the
// session shell so rendering the initial context cannot start a conversation.
vi.mock("../../chat", async () => {
  const { RichContent } = await import("../../rich-content");
  return {
    ChatPageSurface: (props: { initialContext?: string }) => {
      chatSurface(props);
      return <RichContent content={props.initialContext ?? ""} density="compact" />;
    },
  };
});

vi.mock("../../navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../navigation")>()),
  useNavigation: () => ({ pathname: "/acme/cockpit" }),
}));

vi.mock("../../editor/link-hover-card", () => ({
  useLinkHover: () => ({}),
  LinkHoverCard: () => null,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const moduleId = "22222222-2222-4222-8222-222222222222";
const scopes: { name: string; scope: CockpitScope; stars: number }[] = [
  {
    name: "shows both wildcard scope values when no scope is selected",
    scope: { projectId: null, moduleId: null },
    stars: 3,
  },
  {
    name: "preserves concrete project and module IDs",
    scope: { projectId, moduleId },
    stars: 1,
  },
  {
    name: "preserves the module wildcard when only a project is selected",
    scope: { projectId, moduleId: null },
    stars: 2,
  },
];

beforeEach(() => chatSurface.mockClear());
afterEach(cleanup);

describe.each(["en", "zh-Hans", "ja", "ko"] as const)(
  "CockpitChat scope context (%s)",
  (locale) => {
    it.each(scopes)("$name", ({ scope, stars }) => {
      const { container } = renderWithI18n(<CockpitChat scope={scope} />, { locale });
      const content = container.querySelector("[data-rich-content]");

      expect(content).toBeVisible();
      expect(content).toHaveTextContent(`project=${scope.projectId ?? "*"}`);
      expect(content).toHaveTextContent(`module=${scope.moduleId ?? "*"}`);
      // Include the legend's star as well as the scope values: none may turn
      // into Markdown emphasis delimiters, including in CJK translations.
      expect(content?.textContent?.match(/\*/g)).toHaveLength(stars);
      expect(content?.querySelector("em, strong")).toBeNull();
      expect(chatSurface.mock.lastCall?.[0]).toMatchObject({
        defaultAgentSystemKey: "mika",
        fixedAgentSystemKey: "mika",
        defaultProjectId: scope.projectId,
      });
    });
  },
);
