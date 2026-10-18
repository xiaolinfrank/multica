import type { MetadataRoute } from "next";

/**
 * Web app manifest — what makes the mobile web app installable and lets it run
 * in its own window instead of a browser tab.
 *
 * `start_url` is deliberately NOT "/". The official marketing hosts keep the
 * root path on the public site even for a signed-in session (see
 * `isOfficialMarketingHost` in proxy.ts), so an installed app pointed at "/"
 * would open the landing page. "/inbox" is one of `LEGACY_ROUTE_SEGMENTS`,
 * which proxy.ts resolves per session: signed in with a known workspace it
 * lands on that workspace's inbox, signed in without one it lands on /login
 * (which resolves against the workspace list), and signed out it lands on
 * /login too. All three are pinned in manifest.test.ts, because a launcher
 * icon has no URL bar to recover from a wrong destination.
 *
 * Brand icons preserve the original approved PNG bytes and declare their actual
 * dimensions. The square SVG wrapper embeds the original PNG without editing
 * its pixels. No maskable safe zone is claimed.
 */

/** Launch path. Exported so manifest.test.ts can run it through the proxy. */
export const PWA_START_URL = "/inbox";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "BayClaw",
    short_name: "BayClaw",
    description:
      "由星舵个人分身统筹的项目与任务执行工作台。",
    start_url: PWA_START_URL,
    scope: "/",
    display: "standalone",
    // Splash-screen colours. The runtime status bar is driven by the
    // per-scheme `<meta name="theme-color">` pair in app/layout.tsx, which the
    // manifest cannot express — these are the pre-launch fallback only.
    background_color: "#ffffff",
    theme_color: "#ffffff",
    categories: ["productivity"],
    icons: [
      {
        src: "/brand/xingduo-app-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/brand/xingduo-mark-light.png",
        sizes: "846x838",
        type: "image/png",
        purpose: "any",
      },
    ],
    // Long-press actions on the installed launcher icon. Both are legacy
    // segments, so they resolve to the last workspace the same way start_url
    // does instead of needing a slug the manifest cannot know.
    shortcuts: [
      { name: "Inbox", url: "/inbox" },
      { name: "My Issues", url: "/my-issues" },
    ],
  };
}
