"use client";

import { useId } from "react";
import { Input } from "@multica/ui/components/ui/input";
import { formatBytes } from "../../common/format-bytes";
import { useT } from "../../i18n";

/** A browser File stays in the caller's memory, never in the persisted draft. */
export function CockpitInputFileField({ file, retainedFile, maxBytes, intent = "upload", disabled, onSelect }: {
  file: File | null;
  retainedFile?: { name: string; size: number } | null;
  maxBytes: number;
  intent?: "upload" | "recover";
  disabled?: boolean;
  onSelect: (file: File) => void;
}) {
  const { t } = useT("cockpit");
  const id = useId();
  const needsReselection = intent === "upload" && !file && Boolean(retainedFile);
  const tooLarge = Boolean(file && file.size > maxBytes);
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="text-caption font-medium">{intent === "recover" ? t(($) => $.input_materials.choose_recovery_file) : needsReselection ? t(($) => $.input_materials.reselect_file) : t(($) => $.input_materials.choose_file)}</label>
    <Input id={id} name="original_file" type="file" disabled={disabled} aria-describedby={`${id}-help${tooLarge ? ` ${id}-error` : ""}`} aria-invalid={tooLarge || undefined}
      className="min-w-0 max-w-full text-caption file:mr-3"
      onChange={(event) => {
        const selected = event.target.files?.[0];
        if (selected) onSelect(selected);
        event.target.value = "";
      }} />
    <div id={`${id}-help`} className="space-y-1 text-caption text-muted-foreground">
      <p>{t(($) => $.input_materials.file_limit, { size: formatBytes(maxBytes) })}</p>
      {needsReselection && <p>{t(($) => $.input_materials.reselect_hint)}</p>}
    </div>
    {(file || retainedFile) && <div className="min-w-0 rounded-md bg-muted/50 p-3 text-caption">
      <p className="break-words [overflow-wrap:anywhere]">{file?.name ?? retainedFile?.name}</p>
      <p className="mt-1 text-muted-foreground">{formatBytes(file?.size ?? retainedFile!.size)}</p>
    </div>}
    {tooLarge && <p id={`${id}-error`} role="alert" className="text-caption text-destructive">{t(($) => $.input_materials.file_too_large, { size: formatBytes(maxBytes) })}</p>}
  </div>;
}
