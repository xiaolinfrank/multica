"use client";

import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { CockpitFlowError } from "./cockpit-task-flow";

export function CockpitInputPageFailure({ onRetry, onFirstPage }: { onRetry: () => void; onFirstPage?: () => void }) {
  const { t } = useT("cockpit");
  return <div className="space-y-2"><CockpitFlowError onRetry={onRetry} />
    {onFirstPage && <Button type="button" variant="outline" size="sm" onClick={onFirstPage}>{t(($) => $.task_flow.first_page)}</Button>}
  </div>;
}
