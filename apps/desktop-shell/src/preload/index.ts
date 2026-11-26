import { contextBridge, ipcRenderer } from "electron";
import type { OpenLocalPathResult, ShellInfo } from "../shared/types";

/**
 * The only bridge the remote web UI gets. Everything is a narrow invoke into a
 * main-process handler that re-validates the sender origin; no Node primitive,
 * no filesystem handle, and no Electron object crosses this boundary.
 */
const desktopAPI = {
  openLocalPath: (targetPath: string): Promise<OpenLocalPathResult> =>
    ipcRenderer.invoke("shell:open-local-path", targetPath),
  openExternal: (url: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("shell:open-external", url),
  getShellInfo: (): Promise<ShellInfo> => ipcRenderer.invoke("shell:get-info"),
};

contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
