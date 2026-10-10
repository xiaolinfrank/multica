"use client";

/** The shell every bottom card shares: title, window hint, and the gradient
 * cap that tells the four apart at a glance. */
export function CockpitNarrativeCard({
  title,
  icon,
  hint,
  cap,
  badge,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  hint?: string;
  cap?: "next" | "meetings" | "support";
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="cockpit-card-top cockpit-card p-4" data-cap={cap}>
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span aria-hidden className="inline-flex self-center" style={{ color: "var(--top-from)" }}>
          {icon}
        </span>
        <h2 className="text-title-sm font-semibold">{title}</h2>
        {hint && <span className="text-micro text-muted-foreground">{hint}</span>}
        <span className="flex-1" />
        {badge}
        {action}
      </header>
      {children}
    </section>
  );
}
