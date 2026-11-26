/** The persisted runtime configuration of the desktop shell. */
export interface ShellConfig {
  /** https origin, or http only for loopback hosts; normalized without a trailing slash. */
  serverUrl: string;
  /**
   * Trust a self-signed certificate for this server. Scoped strictly to the
   * exact host of `serverUrl`; every other host is still rejected.
   */
  allowSelfSignedCert: boolean;
  /** Optional manual override; normally discovered from `${serverUrl}/api/config`. */
  collabSpaceHostOverride?: string;
}

export type OpenLocalPathResult =
  | { ok: true; action: "opened" | "revealed" }
  | {
      ok: false;
      reason:
        | "invalid"
        | "not_found"
        | "error"
        | "unsupported"
        | "untrusted_host"
        | "untrusted_origin";
      error?: string;
    };

export interface ShellInfo {
  name: "bayclaw-desktop-shell";
  version: string;
  platform: string;
  serverUrl: string;
  collabSpaceHost: string;
}

/** Where an open request originated: the trusted web UI or an external deep link. */
export type OpenPathSource = "ipc" | "protocol";
