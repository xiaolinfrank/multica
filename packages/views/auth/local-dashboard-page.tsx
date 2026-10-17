import { useState } from "react";
import { api } from "@multica/core/api";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@multica/ui/components/ui/card";
import { useT } from "../i18n";

export function LocalDashboardPage({ email, onOpen, onWorkspace }: { email: string; onOpen: (url: string) => void; onWorkspace: () => void }) {
  const { t } = useT("auth");
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    setFailed(false);
    try {
      const result = await api.openLocalDashboard();
      const url = new URL(result.browser_url);
      if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || !new URLSearchParams(url.hash.slice(1)).get("bootstrapToken")) throw new Error("invalid local handoff");
      onOpen(url.href);
    } catch {
      setFailed(true);
      setOpening(false);
    }
  };
  return <div className="flex min-h-svh items-center justify-center">
    <Card className="w-full max-w-sm">
      <CardHeader><CardTitle>{t(($) => $.local_dashboard.title)}</CardTitle><CardDescription>{email}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {failed && <p role="alert" className="text-body text-destructive">{t(($) => $.local_dashboard.failed)}</p>}
        <Button className="w-full" disabled={opening} aria-busy={opening} onClick={open}>{t(($) => opening ? $.local_dashboard.opening : $.local_dashboard.open)}</Button>
        <Button className="w-full" variant="outline" disabled={opening} onClick={onWorkspace}>{t(($) => $.local_dashboard.workspace)}</Button>
      </CardContent>
    </Card>
  </div>;
}
