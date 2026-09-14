import { cn } from "@multica/ui/lib/utils";

export const githubUrl = "https://github.com/multica-ai/multica";
export const twitterUrl = "https://x.com/MulticaAI";
// Discord intentionally removed from the landing page (footer link/icon and
// changelog copy). Do NOT re-add `discordUrl` or `DiscordMark` when merging
// upstream changes — this product has no public Discord community.

export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2 .37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.84c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function XMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function ImageIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m20.5 16-4.8-4.8a1 1 0 0 0-1.4 0L8 17.5" />
      <path d="m11.5 14.5 1.8-1.8a1 1 0 0 1 1.4 0l2.8 2.8" />
    </svg>
  );
}

export function headerButtonClassName(
  tone: "ghost" | "solid",
  variant: "dark" | "light" = "dark",
) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-(--landing-radius-button) px-4 py-2.5 text-label font-semibold transition-colors",
    variant === "dark"
      ? tone === "solid"
        ? "bg-white text-[#0a0d12] hover:bg-white/92"
        : "border border-white/18 bg-black/16 text-white backdrop-blur-sm hover:bg-black/24"
      : tone === "solid"
        ? "bg-[#0a0d12] text-white hover:bg-[#0a0d12]/88"
        : "border border-[#0a0d12]/12 bg-white text-[#0a0d12] hover:bg-[#0a0d12]/5",
  );
}

export function heroButtonClassName(tone: "ghost" | "solid") {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-(--landing-radius-action) px-5 py-3 text-body font-semibold transition-colors",
    tone === "solid"
      ? "bg-white text-[#0a0d12] hover:bg-white/92"
      : "border border-white/18 bg-black/16 text-white backdrop-blur-sm hover:bg-black/24",
  );
}
