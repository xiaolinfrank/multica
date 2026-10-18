"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

export function CockpitDetailTitle({ children }: { children: string }) {
  const { t } = useT("cockpit");
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const measure = useCallback(() => {
    const title = titleRef.current;
    if (title && !expanded) setOverflowing(title.scrollHeight > title.clientHeight + 1);
  }, [expanded]);

  useLayoutEffect(() => {
    measure();
    const title = titleRef.current;
    if (!title || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    return () => observer.disconnect();
  }, [measure, children]);

  return <div className="min-w-0 flex-1">
    <h1 id={id} ref={titleRef} className={cn("break-words text-title-lg font-semibold", !expanded && "line-clamp-3")}>{children}</h1>
    {(overflowing || expanded) && <Button type="button" variant="ghost" size="sm" className="mt-1 px-0 text-muted-foreground"
      aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? t(($) => $.shell.collapse_title) : t(($) => $.shell.expand_title)}
    </Button>}
  </div>;
}
