import http from "node:http";
import https from "node:https";
import { isValidCollabHost } from "./config";

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 64 * 1024;

export interface ServerConfigResponse {
  status: number;
  body: string;
}

/** Transport injection point so tests never need a real network. */
export type ServerConfigFetcher = (url: string) => Promise<ServerConfigResponse>;

export interface FetchCollabSpaceHostOptions {
  /** Trust a self-signed certificate, scoped to `expectedHost` only. */
  allowSelfSignedCert: boolean;
  timeoutMs?: number;
  fetchImpl?: ServerConfigFetcher;
  /** Defaults to the host of `serverUrl`; kept injectable for tests. */
  expectedHost?: string;
}

/** Builds `${serverUrl}/api/config` without duplicating a trailing slash. */
export function buildServerConfigUrl(serverUrl: string): string | null {
  const base = serverUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const url = new URL(`${base}/api/config`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The self-signed opt-in is scoped to one request and one host. It never
 * mutates `NODE_TLS_REJECT_UNAUTHORIZED`, which would weaken every HTTPS
 * connection in the process.
 */
export function shouldScopeInsecureTls(
  targetUrl: string,
  expectedHost: string,
  allowSelfSignedCert: boolean,
): boolean {
  if (!allowSelfSignedCert) return false;
  try {
    return new URL(targetUrl).host === expectedHost;
  } catch {
    return false;
  }
}

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return "";
  }
}

function requestUrl(
  targetUrl: string,
  options: { allowSelfSignedCert: boolean; expectedHost: string; timeoutMs: number },
): Promise<ServerConfigResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const insecure = shouldScopeInsecureTls(
      targetUrl,
      options.expectedHost,
      options.allowSelfSignedCert,
    );
    const agent = insecure
      ? new https.Agent({ rejectUnauthorized: false, keepAlive: false })
      : undefined;

    const onResponse = (response: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          response.destroy();
          reject(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", reject);
    };

    const request =
      parsed.protocol === "https:"
        ? https.get(targetUrl, { agent, timeout: options.timeoutMs }, onResponse)
        : http.get(targetUrl, { timeout: options.timeoutMs }, onResponse);

    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

/**
 * Reads `collab_space_host` from `${serverUrl}/api/config`. Every failure —
 * network, status, JSON, or an invalid host value — degrades to "" so the
 * caller can fall back to manual configuration.
 */
export async function fetchCollabSpaceHost(
  serverUrl: string,
  options: FetchCollabSpaceHostOptions,
): Promise<string> {
  const targetUrl = buildServerConfigUrl(serverUrl);
  if (!targetUrl) return "";

  const expectedHost = options.expectedHost?.trim() || hostOf(serverUrl);
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  let response: ServerConfigResponse;
  try {
    response = options.fetchImpl
      ? await options.fetchImpl(targetUrl)
      : await requestUrl(targetUrl, {
          allowSelfSignedCert: options.allowSelfSignedCert,
          expectedHost,
          timeoutMs,
        });
  } catch {
    return "";
  }

  if (response.status < 200 || response.status >= 300) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";

  const raw = (parsed as Record<string, unknown>).collab_space_host;
  if (typeof raw !== "string") return "";

  const host = raw.trim();
  return host && isValidCollabHost(host) ? host : "";
}
