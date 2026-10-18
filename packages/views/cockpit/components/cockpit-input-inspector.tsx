"use client";

import { cockpitInputContextPath } from "@multica/core/cockpit";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitInputDetail } from "./cockpit-input-detail";

/** Inspect the exact input version linked by an issue or run manifest. */
export function CockpitInputInspector({ wsId, accountId }: { wsId: string; accountId: string }) {
  const { t } = useT("cockpit");
  const navigation = useNavigation();
  const inputId = navigation.searchParams.get("input");
  const versionId = navigation.searchParams.get("input_version");
  const close = () => navigation.push(cockpitInputContextPath(navigation.pathname, navigation.searchParams, null));

  if (!inputId) return null;

  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader><DialogTitle>{t(($) => $.input_materials.material_detail)}</DialogTitle></DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
        <CockpitInputDetail key={`${wsId}:${accountId}:${inputId}`} wsId={wsId} accountId={accountId} inputId={inputId} versionId={versionId}
          onVersionChange={(id) => navigation.push(cockpitInputContextPath(navigation.pathname, navigation.searchParams, inputId, id))} />
      </div>
    </DialogContent>
  </Dialog>;
}
