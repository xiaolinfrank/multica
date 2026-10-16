"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function CockpitViewHeading({ title, icon: Icon, description, children }: {
  title: string; icon: LucideIcon; description?: ReactNode; children?: ReactNode;
}) {
  return <header className="cockpit-view-heading">
    <div className="cockpit-view-identity"><span className="cockpit-view-symbol" aria-hidden><Icon className="size-5" /></span>
      <div className="min-w-0"><h2>{title}</h2>{description && <div className="cockpit-view-description">{description}</div>}</div>
    </div>
    {children && <div className="cockpit-view-actions">{children}</div>}
  </header>;
}
