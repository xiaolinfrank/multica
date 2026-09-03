import { CockpitPage } from "@multica/views/cockpit";

// The cockpit is a shared view; web adds no platform-specific wiring.
export default function CockpitRoute() {
  return <CockpitPage />;
}
