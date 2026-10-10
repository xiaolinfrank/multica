import { useSyncExternalStore } from "react";

let locations = ["/ws/cockpit"];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => locations.at(-1) ?? "/ws/cockpit";
const emit = () => { for (const listener of listeners) listener(); };
export function resetCockpitTestNavigation(href = "/ws/cockpit") { locations = [href]; emit(); }
function push(href: string) { locations.push(href); emit(); }
function replace(href: string) { locations[locations.length - 1] = href; emit(); }
function back() { if (locations.length > 1) locations.pop(); emit(); }

export function useCockpitTestNavigation() {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = new URL(href, "https://example.test");
  return { pathname: url.pathname, searchParams: url.searchParams, push, replace, back };
}

export function CockpitTestLink({ href = "", target, children, newTabTitle: _title, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { newTabTitle?: string }) {
  return <a href={href} target={target} {...props} onClick={(event) => {
    onClick?.(event);
    if (!event.defaultPrevented && !target && href.startsWith("/ws/cockpit")) { event.preventDefault(); push(href); }
  }}>{children}</a>;
}
