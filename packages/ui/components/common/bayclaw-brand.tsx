import { cn } from "../../lib/utils";
import { MulticaIcon } from "./multica-icon";

/** Shared wordmark, with no dependency on a web public path or app framework. */
export function BayClawBrand({ className }: { className?: string }) {
  return <span className={cn("inline-flex items-center gap-2 font-medium", className)} title="BayClaw">
    <MulticaIcon className="size-6 shrink-0" noSpin />
    <span>BayClaw</span>
  </span>;
}
