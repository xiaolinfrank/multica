"use client";

import { useCallback, useState } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
  Trash2,
  Users,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { workspaceKeys } from "@multica/core/workspace/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { toast } from "sonner";
import { useT } from "../../i18n";

// Fixed cosmetic mask for the pre-reveal key list. Real values arrive only
// after the user clicks "Reveal & edit" (an audited server call).
const MASK = "••••••••";

let nextEntryId = 0;

interface EnvEntry {
  id: number;
  key: string;
  value: string;
  visible: boolean;
}

function mapToEntries(env: Record<string, string>): EnvEntry[] {
  return Object.entries(env).map(([key, value]) => ({
    id: nextEntryId++,
    key,
    value,
    visible: false,
  }));
}

function entriesToMap(entries: EnvEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (key) {
      map[key] = entry.value;
    }
  }
  return map;
}

/**
 * Editable card for the workspace-level shared env, injected into every agent
 * beneath its own custom_env. Mirrors the per-agent Environment tab's
 * reveal-then-edit flow: pre-reveal shows only key NAMES (from the overview
 * payload, masked); clicking "Reveal & edit" fetches plaintext via the
 * audited GET /api/env/shared, and Save writes it back with PUT. On success
 * the workspace env overview query is invalidated so the names refresh.
 *
 * keyNames comes from the overview so the count/names render without a reveal.
 */
export function SharedEnvCard({
  wsId,
  keyNames,
}: {
  wsId: string;
  keyNames: string[];
}) {
  const { t } = useT("env");
  const queryClient = useQueryClient();

  // revealed === null means "not yet revealed"; [] is a legitimate empty map
  // after a successful reveal. We never auto-fetch — the reveal writes an
  // audit row, so it must be an intentional click.
  const [revealed, setRevealed] = useState<EnvEntry[] | null>(null);
  const [originalMap, setOriginalMap] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentMap = revealed ? entriesToMap(revealed) : originalMap;
  const dirty =
    revealed !== null &&
    JSON.stringify(currentMap) !== JSON.stringify(originalMap);

  const handleReveal = useCallback(async () => {
    setRevealing(true);
    try {
      const resp = await api.getWorkspaceSharedEnv();
      const env = resp.shared_env ?? {};
      setOriginalMap(env);
      setRevealed(mapToEntries(env));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.shared.reveal_failed_toast),
      );
    } finally {
      setRevealing(false);
    }
  }, [t]);

  const addEntry = () =>
    setRevealed((prev) => [
      ...(prev ?? []),
      { id: nextEntryId++, key: "", value: "", visible: true },
    ]);

  const removeEntry = (index: number) =>
    setRevealed((prev) => (prev ?? []).filter((_, i) => i !== index));

  const updateEntry = (index: number, field: "key" | "value", val: string) =>
    setRevealed((prev) =>
      (prev ?? []).map((entry, i) =>
        i === index ? { ...entry, [field]: val } : entry,
      ),
    );

  const toggleVisibility = (index: number) =>
    setRevealed((prev) =>
      (prev ?? []).map((entry, i) =>
        i === index ? { ...entry, visible: !entry.visible } : entry,
      ),
    );

  const handleCancel = () => setRevealed(null);

  const handleSave = async () => {
    if (revealed === null) return;
    const keys = revealed.filter((e) => e.key.trim()).map((e) => e.key.trim());
    if (new Set(keys).size < keys.length) {
      toast.error(t(($) => $.shared.duplicate_keys_toast));
      return;
    }

    setSaving(true);
    try {
      const resp = await api.updateWorkspaceSharedEnv({ shared_env: currentMap });
      const env = resp.shared_env ?? {};
      setOriginalMap(env);
      setRevealed(mapToEntries(env));
      toast.success(t(($) => $.shared.saved_toast));
      // Refresh the overview so the shared key names (and any agent override
      // badges) reflect the new set.
      queryClient.invalidateQueries({ queryKey: workspaceKeys.env(wsId) });
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.shared.save_failed_toast),
      );
    } finally {
      setSaving(false);
    }
  };

  const keyCount = revealed ? entriesToMap(revealed) : null;
  const count = keyCount ? Object.keys(keyCount).length : keyNames.length;

  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t(($) => $.shared.title)}
        </span>
        <Badge variant="secondary" className="shrink-0 font-mono">
          {t(($) => $.page.variable_count, { count })}
        </Badge>
        {revealed === null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={revealing}
            onClick={handleReveal}
            className="shrink-0"
          >
            {revealing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {revealing
              ? t(($) => $.shared.revealing)
              : t(($) => $.shared.reveal_edit)}
          </Button>
        )}
      </div>

      <div className="border-t px-4 py-2.5">
        <p className="mb-2 text-xs text-muted-foreground">
          {t(($) => $.shared.hint)}
        </p>

        {revealed === null ? (
          // Pre-reveal: masked key names from the overview payload.
          keyNames.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {keyNames.map((name) => (
                <li
                  key={name}
                  className="flex items-center gap-3 px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {name}
                  </span>
                  <span
                    className="shrink-0 font-mono text-xs tracking-widest text-muted-foreground/60 select-none"
                    aria-label={t(($) => $.page.value_hidden)}
                  >
                    {MASK}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs italic text-muted-foreground">
              {t(($) => $.shared.empty)}
            </p>
          )
        ) : (
          // Edit mode.
          <div className="space-y-2">
            {revealed.map((entry, index) => (
              <div key={entry.id} className="flex items-center gap-2">
                <Input
                  value={entry.key}
                  onChange={(e) => updateEntry(index, "key", e.target.value)}
                  placeholder={t(($) => $.shared.key_placeholder)}
                  className="w-[40%] font-mono text-xs"
                />
                <div className="relative flex-1">
                  <Input
                    type={entry.visible ? "text" : "password"}
                    value={entry.value}
                    onChange={(e) => updateEntry(index, "value", e.target.value)}
                    placeholder={t(($) => $.shared.value_placeholder)}
                    className="pr-8 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => toggleVisibility(index)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={
                      entry.visible
                        ? t(($) => $.shared.hide_value_aria)
                        : t(($) => $.shared.show_value_aria)
                    }
                  >
                    {entry.visible ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeEntry(index)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t(($) => $.shared.remove_aria)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}

            <div className="flex items-center justify-between gap-3 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addEntry}
              >
                <Plus className="h-3 w-3" />
                {t(($) => $.shared.add)}
              </Button>
              <div className="flex items-center gap-3">
                {dirty && (
                  <span className="text-xs text-muted-foreground">
                    {t(($) => $.shared.unsaved_changes)}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCancel}
                  disabled={saving}
                >
                  {t(($) => $.shared.cancel)}
                </Button>
                <Button onClick={handleSave} disabled={!dirty || saving} size="sm">
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {saving ? t(($) => $.shared.saving) : t(($) => $.shared.save)}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
