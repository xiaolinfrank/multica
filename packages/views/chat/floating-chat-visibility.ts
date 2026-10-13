import { cockpitShellDestination } from "@multica/core/cockpit";

/**
 * Route gate for the floating chat overlay, shared by the overlay itself and by
 * the `toggleChat` keyboard shortcut so the two can never disagree.
 *
 * On the Chat tab the full-page surface already owns the same `activeSessionId`,
 * so a floating copy would be pure duplication — `FloatingChat` renders nothing
 * there. The shortcut has to honour the same rule: flipping `isOpen` on a route
 * where the overlay cannot mount reads as a dead keypress, and then surprises
 * the user with a window that pops open (or vanishes) on the next navigation.
 */
export function isFloatingChatRouteSuppressed(
  pathname: string,
  chatPath: string,
  cockpit?: { pathname?: string; search?: { get: (key: string) => string | null } },
): boolean {
  if (pathname === chatPath || pathname.startsWith(`${chatPath}/`)) return true;
  // The cockpit hosts the full-page chat as its home surface. Other cockpit
  // pages keep the overlay; a caller without cockpit info (older mocks) never
  // suppresses here.
  if (!cockpit?.pathname || pathname !== cockpit.pathname) return false;
  return cockpitShellDestination(cockpit.search ?? { get: () => null }).surface === "chat";
}
