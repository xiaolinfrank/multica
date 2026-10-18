import { resolveDevRemoteApiUrl, resolveRemoteApiUrl } from "../config/runtime-urls";

const MAX_BYTES = 500 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ACTIVE = 2;
const REQUEST_MS = 8 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let active = 0;

export interface InputUploadRouteParams {
  inputId: string;
  versionId: string;
  transferId: string;
}

function failure(status: number, code: string): Response {
  return Response.json({ error: code, code }, { status, headers: { "Cache-Control": "no-store" } });
}

// This exact route bypasses Next's cloning proxy. Keep the stream bounded here
// and let Go authorize the immutable session, revision, size, and task identity.
export async function streamInputUpload(request: Request, params: InputUploadRouteParams): Promise<Response> {
  if (Object.values(params).some((id) => !UUID.test(id) || id === "00000000-0000-0000-0000-000000000000")) {
    return failure(400, "invalid_input_identity");
  }
  const revision = request.headers.get("x-input-transfer-revision") ?? "";
  if (!/^[1-9][0-9]{0,18}$/.test(revision) || BigInt(revision) > 9223372036854775807n) {
    return failure(400, "invalid_transfer_revision");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    return failure(400, "invalid_content_length");
  }
  if (length !== null && Number(length) > MAX_BYTES) return failure(413, "input_too_large");
  if (!request.body && length !== "0") return failure(400, "input_body_required");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
    return failure(415, "input_stream_required");
  }
  const base = process.env.NODE_ENV === "development" ? resolveDevRemoteApiUrl(process.env) : resolveRemoteApiUrl(process.env);
  if (!base) return failure(503, "input_upload_backend_unconfigured");
  if (new URL(base).origin === new URL(request.url).origin) return failure(503, "input_upload_backend_loop");
  if (active >= MAX_ACTIVE) return failure(503, "input_upload_busy");
  active++;
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("input upload deadline")), REQUEST_MS);
  let oversized = false;
  let received = 0;
  try {
    if (request.signal.aborted) onAbort();
    const headers = new Headers();
    for (const name of ["authorization", "cookie", "x-csrf-token", "origin", "x-workspace-id", "x-workspace-slug", "content-length", "x-input-transfer-revision", "x-client-platform", "x-client-version", "x-client-os"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("content-type", "application/octet-stream");
    const body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, stream) {
        received += chunk.byteLength;
        if (received > MAX_BYTES) {
          oversized = true;
          stream.error(new Error("input body exceeds limit"));
          controller.abort();
          return;
        }
        stream.enqueue(chunk);
      },
    }));
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT", headers, body: body ?? new Uint8Array(), duplex: "half",
      signal: controller.signal, redirect: "manual", cache: "no-store",
    };
    const upstream = await fetch(`${base}/api/cockpit/inputs/${params.inputId}/versions/${params.versionId}/transfers/${params.transferId}/bytes`, init);
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return failure(502, "input_upload_unexpected_redirect");
    }
    // A byte upload returns only a small JSON acknowledgement. Bound even an
    // erroneous upstream response and release the upload slot after its read.
    const reader = upstream.body?.getReader();
    const chunks: Uint8Array[] = [];
    let responseBytes = 0;
    if (reader) {
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          responseBytes += item.value.byteLength;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return failure(502, "input_upload_response_invalid");
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(responseBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const responseHeaders = new Headers({ "Content-Type": upstream.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
    for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie);
    return new Response([204, 205, 304].includes(upstream.status) ? null : bytes, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return failure(oversized ? 413 : request.signal.aborted ? 499 : controller.signal.aborted ? 504 : 502,
      oversized ? "input_too_large" : "input_upload_result_unknown");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onAbort);
    controller.abort();
    active--;
  }
}
