"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { workspaceListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@multica/ui/components/ui/card";
import { useT } from "../i18n";

export function LocalAccountPage({ onSuccess, onTokenObtained, cliCallback }: {
  onSuccess: () => void;
  onTokenObtained?: () => void;
  cliCallback?: { url: string; state: string };
}) {
  const { t } = useT("auth");
  const qc = useQueryClient();
  const [adopting,setAdopting] = useState(false);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const [login, setLogin] = useState("");
  const [display, setDisplay] = useState("");
  const [password, setPassword] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [session, setSession] = useState<{ token: string; recovery_code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const refresh = () => api.localAccountStatus().then((v) => {setInitialized(v.initialized);setAdopting(v.adopting);if(v.display_name)setDisplay(v.display_name);}).catch(() => setError(true));
  useEffect(() => {
    const token=new URLSearchParams(window.location.hash.slice(1)).get("setupToken");
    if(token)setSetupToken(token);
    if (window.location.hash.includes("setupToken=")) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    void refresh();
  }, []);
  const finish = async (token: string) => {
    setBusy(true);
    try {
      await useAuthStore.getState().loginWithLocalSession(token);
      onTokenObtained?.();
      await qc.ensureQueryData(workspaceListOptions());
      if (cliCallback) {
        const target = new URL(cliCallback.url);
        target.searchParams.set("token", token); target.searchParams.set("state", cliCallback.state);
        window.location.assign(target.href);
      } else onSuccess();
    } catch { setError(true); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (busy || initialized === null) return;
    setBusy(true); setError(false);
    try {
      const result = await api.localAccount(!initialized ? "setup" : recovering ? "recover" : "login", {
        login_name: login, display_name: display, password, recovery_code: recoveryInput,
      }, setupToken);
      setPassword(""); setRecoveryInput("");
      if (result.recovery_code) setSession(result);
      else await finish(result.token);
    } catch { setError(true); } finally { setBusy(false); }
  };
  return <div className="flex min-h-svh items-center justify-center p-6"><Card className="w-full max-w-md">
    <CardHeader><CardTitle>{t(($) => session ? $.local_account.save_recovery : initialized === false ? adopting ? $.local_account.adopt : $.local_account.create : recovering ? $.local_account.recover : $.local_account.signin)}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-destructive">{t(($) => $.local_account.failed)}</p>}
      {session ? <>
        <p>{t(($) => $.local_account.recovery_help)}</p>
        <code className="block break-all rounded bg-muted p-4 select-all">{session.recovery_code}</code>
        <Button className="w-full" disabled={busy} onClick={() => void finish(session.token)}>{t(($) => $.local_account.saved)}</Button>
      </> : initialized === null ? <Button onClick={() => void refresh()}>{t(($) => $.local_account.retry)}</Button> : <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {!recovering && <div><Label htmlFor="local-login">{t(($) => $.local_account.login)}</Label><Input id="local-login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} pattern="[a-z0-9][a-z0-9_.-]{0,63}" required /></div>}
        {initialized === false && <div><Label htmlFor="local-name">{t(($) => $.local_account.name)}</Label><Input id="local-name" autoComplete="name" value={display} onChange={(e) => setDisplay(e.target.value)} required maxLength={100} /></div>}
        {recovering && <div><Label htmlFor="local-recovery">{t(($) => $.local_account.recovery)}</Label><Input id="local-recovery" value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)} required autoComplete="off" /></div>}
        <div><Label htmlFor="local-password">{t(($) => $.local_account.password)}</Label><Input id="local-password" type="password" autoComplete={!initialized || recovering ? "new-password" : "current-password"} minLength={12} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {initialized === false && !setupToken && <p role="alert">{t(($) => $.local_account.setup_help)}</p>}
        <Button type="submit" className="w-full" disabled={busy || (initialized === false && !setupToken)} aria-busy={busy}>{t(($) => initialized === false ? adopting ? $.local_account.adopt : $.local_account.create : recovering ? $.local_account.recover : $.local_account.signin)}</Button>
        {initialized && <Button type="button" variant="ghost" onClick={() => setRecovering(!recovering)}>{t(($) => recovering ? $.local_account.signin : $.local_account.recover)}</Button>}
      </form>}
    </CardContent>
  </Card></div>;
}
