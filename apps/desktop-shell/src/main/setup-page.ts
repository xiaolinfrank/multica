import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE_NAME = "bayclaw-shell-setup.html";

/**
 * A self-contained settings screen. It never loads remote assets: the CSP
 * allows inline styles and the inline script only, so the page works offline
 * and the setup preload is the only bridge attached to it.
 */
export function renderSetupPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BayClaw — Server Settings</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0f14;
        --panel: #131a23;
        --border: #253141;
        --text: #e6edf5;
        --muted: #93a3b8;
        --accent: #4c9aff;
        --danger: #ff7a7a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: 100%;
        max-width: 460px;
        padding: 28px;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--panel);
      }
      h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
      p.lead { margin: 0 0 24px; color: var(--muted); }
      label { display: block; margin-bottom: 18px; }
      .label-text { display: block; margin-bottom: 6px; font-weight: 600; }
      .label-hint { display: block; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
      input[type="url"], input[type="text"] {
        width: 100%;
        padding: 9px 11px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #0d131a;
        color: var(--text);
        font: inherit;
      }
      input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
      .checkbox { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 18px; }
      .checkbox input { margin-top: 3px; }
      .checkbox span { color: var(--muted); }
      button {
        width: 100%;
        padding: 10px 14px;
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: #06101c;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      button:disabled { opacity: 0.6; cursor: default; }
      .error {
        margin: 0 0 16px;
        padding: 10px 12px;
        border: 1px solid #5c2a2a;
        border-radius: 8px;
        background: #2a1414;
        color: var(--danger);
      }
      .footer { margin: 18px 0 0; color: var(--muted); font-size: 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>BayClaw</h1>
      <p class="lead">
        Point the desktop shell at your BayClaw server.
        <span lang="zh-Hans">请填写 BayClaw 服务器地址。</span>
      </p>

      <form id="setup-form" novalidate>
        <p id="error" class="error" hidden></p>

        <label for="server-url">
          <span class="label-text">Server URL · 服务器地址</span>
          <span class="label-hint">
            Use https:// for a remote server. http:// is accepted only for localhost.
          </span>
          <input
            id="server-url"
            name="serverUrl"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://bayclaw.example.com"
            required
          />
        </label>

        <div class="checkbox">
          <input id="allow-self-signed" name="allowSelfSignedCert" type="checkbox" />
          <label for="allow-self-signed">
            <span class="label-text">Trust a self-signed HTTPS certificate</span>
            <span>
              Only for this server's host. 仅信任此主机的自签名证书。
            </span>
          </label>
        </div>

        <label for="collab-host">
          <span class="label-text">NAS host override · NAS 主机（可选）</span>
          <span class="label-hint">
            Optional. Normally discovered from the server automatically.
          </span>
          <input
            id="collab-host"
            name="collabSpaceHostOverride"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="nas.example.internal"
          />
        </label>

        <button id="submit" type="submit">Save &amp; Connect</button>
      </form>

      <p class="footer">
        Settings are stored locally for your user account.
      </p>
    </main>

    <script>
      (function () {
        var form = document.getElementById("setup-form");
        var urlInput = document.getElementById("server-url");
        var certInput = document.getElementById("allow-self-signed");
        var hostInput = document.getElementById("collab-host");
        var errorBox = document.getElementById("error");
        var submit = document.getElementById("submit");

        function showError(message) {
          errorBox.textContent = message || "";
          errorBox.hidden = !message;
        }

        function setBusy(busy) {
          submit.disabled = busy;
          submit.textContent = busy ? "Connecting…" : "Save & Connect";
        }

        async function loadConfig() {
          if (!window.shellSetupAPI) {
            showError("The setup bridge is unavailable. Reinstall BayClaw.");
            return;
          }
          try {
            var config = await window.shellSetupAPI.getConfig();
            if (config) {
              urlInput.value = config.serverUrl || "";
              certInput.checked = config.allowSelfSignedCert === true;
              hostInput.value = config.collabSpaceHostOverride || "";
            }
          } catch (error) {
            showError(String(error));
          }
        }

        form.addEventListener("submit", async function (event) {
          event.preventDefault();
          showError("");
          setBusy(true);
          try {
            var result = await window.shellSetupAPI.saveConfig({
              serverUrl: urlInput.value,
              allowSelfSignedCert: certInput.checked,
              collabSpaceHostOverride: hostInput.value
            });
            if (!result || !result.ok) {
              showError((result && result.error) || "Could not save the configuration.");
              setBusy(false);
            }
          } catch (error) {
            showError(String(error));
            setBusy(false);
          }
        });

        loadConfig();
      })();
    </script>
  </body>
</html>
`;
}

/** Writes the settings page to a private file and returns its absolute path. */
export async function writeSetupPageFile(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = join(directory, FILE_NAME);
  await writeFile(filePath, renderSetupPageHtml(), { encoding: "utf8", mode: 0o600 });
  return filePath;
}
