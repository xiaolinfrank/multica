import { contextBridge, ipcRenderer } from "electron";
import type { ShellConfig } from "../shared/types";

export interface SetupSaveResult {
  ok: boolean;
  error?: string;
}

/**
 * Attached ONLY to the local settings BrowserWindow. The remote web window
 * never receives `shellSetupAPI`, so a served page cannot rewrite the server
 * URL or enable certificate trust.
 */
const shellSetupAPI = {
  getConfig: (): Promise<ShellConfig | null> => ipcRenderer.invoke("shell:setup-get"),
  saveConfig: (config: Partial<ShellConfig>): Promise<SetupSaveResult> =>
    ipcRenderer.invoke("shell:setup-save", config),
};

contextBridge.exposeInMainWorld("shellSetupAPI", shellSetupAPI);
