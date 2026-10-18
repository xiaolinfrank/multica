import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, lstat, readFile, realpath, statfs, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { TestApiClient } from "./fixtures";

const SIZE = 500 * 1024 * 1024;
const SHARE = "/Volumes/人机协作空间";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK = 1024 * 1024;

function identity(value: BigIntStats) {
  return { dev: value.dev.toString(), ino: value.ino.toString(), size: value.size.toString(), mtime_ns: value.mtimeNs.toString(), ctime_ns: value.ctimeNs.toString() };
}
function sameFile(left: BigIntStats, right: BigIntStats) {
  expect(identity(right)).toEqual(identity(left));
  expect(right.isFile() && !right.isSymbolicLink()).toBe(true);
}
async function hashFile(path: string, expected: BigIntStats) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    sameFile(expected, await handle.stat({ bigint: true }));
    const hash = createHash("sha256"), chunk = Buffer.alloc(CHUNK);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead; expect(bytes).toBeLessThanOrEqual(SIZE);
      hash.update(chunk.subarray(0, bytesRead));
    }
    sameFile(expected, await handle.stat({ bigint: true }));
    sameFile(expected, await lstat(path, { bigint: true }));
    expect(bytes).toBe(SIZE);
    return { bytes, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
async function writeOwnedSource(path: string) {
  // Never adopt, replace, truncate, rename or remove an existing NAS file.
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let writtenSource: { bytes: number; sha256: string; info: BigIntStats } | null = null;
  try {
    const chunk = Buffer.alloc(CHUNK), pattern = Buffer.from("Owned N2 fixed input evidence. Preserve this source.\x00\xff\n");
    for (let offset = 0; offset < chunk.length; offset += pattern.length) chunk.set(pattern.subarray(0, Math.min(pattern.length, chunk.length - offset)), offset);
    const hash = createHash("sha256"); let bytes = 0;
    while (bytes < SIZE) {
      const length = Math.min(chunk.length, SIZE - bytes);
      let written = 0;
      while (written < length) {
        const result = await handle.write(chunk, written, length - written, null);
        if (result.bytesWritten <= 0) throw new Error("Owned NAS file write made no progress");
        hash.update(chunk.subarray(written, written + result.bytesWritten));
        written += result.bytesWritten; bytes += result.bytesWritten;
      }
    }
    await handle.sync();
    const info = await handle.stat({ bigint: true });
    expect(info.isFile()).toBe(true); expect(info.size).toBe(BigInt(SIZE));
    sameFile(info, await lstat(path, { bigint: true }));
    writtenSource = { bytes, sha256: hash.digest("hex"), info };
  } finally { await handle.close(); }
  const closed = await lstat(path, { bigint: true });
  if (!writtenSource) throw new Error("Owned source write did not complete");
  expect([closed.dev, closed.ino, closed.size]).toEqual([writtenSource.info.dev, writtenSource.info.ino, writtenSource.info.size]);
  expect(closed.isFile() && !closed.isSymbolicLink()).toBe(true);
  return { ...writtenSource, info: closed };
}

/** Explicit real-SMB and large-I/O gates. Configuration and source files are
 * supplied/retained by the agent3 owner; this test never changes root config. */
test("streams 500 MiB through Next and captures the same retained real SMB source as fixed input", async ({}, info) => {
  test.setTimeout(22 * 60_000);
  test.skip(process.env.MULTICA_E2E_REAL_NAS !== "1" || process.env.MULTICA_E2E_INPUT_LARGE_FILE !== "1", "Requires explicit agent3 real SMB and 500 MiB acceptance authorization");
  expect(process.platform).toBe("darwin"); expect(basename(homedir())).toBe("fosun_agent_3");
  const dbURL = process.env.DATABASE_URL || "invalid://missing";
  const database = new URL(dbURL);
  expect(["localhost", "127.0.0.1"]).toContain(database.hostname);
  expect(decodeURIComponent(database.pathname)).toMatch(/_test$/);
  const apiURL = new URL(process.env.NEXT_PUBLIC_API_URL || "invalid://missing");
  const webURL = new URL(process.env.PLAYWRIGHT_BASE_URL || process.env.FRONTEND_ORIGIN || "invalid://missing");
  for (const url of [apiURL, webURL]) { expect(url.protocol).toBe("http:"); expect(["127.0.0.1", "localhost"]).toContain(url.hostname); }
  expect(apiURL.port).toBe("18880"); expect(webURL.port).toBe("13800"); expect(webURL.origin).not.toBe(apiURL.origin);
  const root = process.env.MULTICA_E2E_NAS_ROOT_PATH || "", rootId = process.env.MULTICA_E2E_NAS_ROOT_ID || "";
  const scope = process.env.MULTICA_E2E_NAS_INPUT_SCOPE || "";
  expect(rootId).toMatch(UUID); expect(process.env.MULTICA_E2E_NAS_WORKSPACE_ID).toMatch(UUID);
  expect(scope).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/);
  expect(root).toBe(join(SHARE, `.multica-validation-${rootId}`)); expect(await realpath(root)).toBe(root);
  const rootInfo = await lstat(root, { bigint: true }); expect(rootInfo.isDirectory() && !rootInfo.isSymbolicLink()).toBe(true);
  const marker = join(root, ".multica-root-id"), markerInfo = await lstat(marker, { bigint: true });
  expect(markerInfo.isFile() && !markerInfo.isSymbolicLink()).toBe(true); expect((await readFile(marker, "utf8")).trim()).toBe(rootId);
  // Inspect mount output without storing it: it may contain a share username.
  expect(execFileSync("/sbin/mount", ["-t", "smbfs"], { encoding: "utf8" }).split("\n").some((line) => line.includes(` on ${SHARE} (smbfs,`))).toBe(true);
  const boundary = join(root, scope), boundaryInfo = await lstat(boundary, { bigint: true });
  expect(await realpath(boundary)).toBe(boundary); expect(boundaryInfo.isDirectory() && !boundaryInfo.isSymbolicLink()).toBe(true);
  expect(boundaryInfo.dev).toBe(rootInfo.dev); expect((await statfs(root)).type).toBe((await statfs(SHARE)).type);
  const privateRoot = process.env.MULTICA_E2E_INPUT_STORAGE_PATH || "";
  const fixtureBase = await realpath(join(homedir(), "var/multica-dev-test"));
  expect(resolve(privateRoot)).toBe(privateRoot); expect(await realpath(privateRoot)).toBe(privateRoot);
  const privateRelative = relative(fixtureBase, privateRoot);
  expect(privateRelative && !privateRelative.startsWith(`..${sep}`) && privateRelative !== ".." && !privateRelative.startsWith(sep)).toBeTruthy();
  const privateInfo = await lstat(privateRoot, { bigint: true }); expect(privateInfo.isDirectory() && !privateInfo.isSymbolicLink()).toBe(true);
  for (const directory of [boundary, privateRoot]) { const free = await statfs(directory); expect(free.bavail * free.bsize).toBeGreaterThan(4 * 1024 ** 3); }

  const api = new TestApiClient(), db = new pg.Client(dbURL);
  let workspaceId: string | null = null, sourcePath: string | null = null;
  let sourceInfo: BigIntStats | null = null, sourceHash: string | null = null;
  const evidence: Record<string, unknown> = { host: "fosun_agent_3", layer: "Next HTTP + Go + real SMB (browser UI tested separately)", size_bytes: SIZE,
    api_origin: apiURL.origin, web_origin: webURL.origin, physical_root: root, root_id: rootId, input_scope: scope,
    source_cleanup: "retained; never removed, renamed or overwritten", api_sha256: process.env.MULTICA_E2E_API_SHA256 || null, web_build_id: process.env.MULTICA_E2E_WEB_BUILD_ID || null };
  await db.connect();
  try {
    const suffix = randomUUID();
    await api.login(`n2-realnas-${suffix}@multica.ai`, "Owned fixed input verifier");
    const ws = await api.createNASFixtureWorkspace(`Owned input evidence ${suffix}`, `n2-input-${suffix.slice(0, 8)}`); workspaceId = ws.id;
    await api.updateCockpitBoard({ title: "Owned real NAS and Next input acceptance" });
    const meeting = await api.createCockpitMeeting({ title: "Raw fixed input verification", meet_date: new Date().toISOString().slice(0, 10) });
    const headers = { Authorization: `Bearer ${api.getToken()}`, "X-Workspace-ID": ws.id, "Content-Type": "application/json" };
    const request = async (path: string, body?: unknown) => {
      expect(path.startsWith("/api/cockpit/")).toBe(true);
      const response = await fetch(`${apiURL.origin}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: "error" });
      expect(response.status, `${path}: ${response.status}`).toBe(200);
      const value = await response.json(); expect(value.workspace_id).toBe(ws.id); return value;
    };
    const capabilities = await request("/api/cockpit/inputs/capabilities");
    expect(capabilities).toMatchObject({ can_create: true, can_browse_nas: true, direct_upload_available: true, max_file_bytes: SIZE });
    const roots = await request("/api/cockpit/input-spaces"); expect(roots.total).toBe(1);
    expect(roots.items[0]).toMatchObject({ root_id: rootId, root_path: root, can_browse: true });
    expect(roots.items[0].input_subpaths).toContain(scope);
    const filename = `input-n2-${suffix}.bin`, relativePath = `${scope}/${filename}`;
    sourcePath = join(boundary, filename);
    evidence.source_path = sourcePath;
    // Configuration has been verified before any real-share content is created.
    const source = await writeOwnedSource(sourcePath); sourceInfo = source.info; sourceHash = source.sha256;
    evidence.source_before = identity(source.info); evidence.source_sha256 = source.sha256;
    expect(await hashFile(sourcePath, source.info)).toEqual({ bytes: SIZE, sha256: source.sha256 });
    const createInput = async (title: string) => {
      const commandKey = randomUUID();
      const created = await request("/api/cockpit/inputs", { command_key: commandKey, title, description: "Owned source retained as acceptance evidence" });
      expect(created.receipt.command_key).toBe(commandKey); expect(created.receipt.input_revision).toBe(1); expect(created.receipt.input_id).toMatch(UUID);
      return created.receipt.input_id as string;
    };
    const uploadedInput = await createInput("500 MiB Next streaming transport source"), uploadKey = randomUUID();
    const submitted = await request(`/api/cockpit/inputs/${uploadedInput}/versions`, { command_key: uploadKey, expected_revision: 1,
      source: { kind: "upload", upload: { filename, content_type: "application/octet-stream", size_bytes: SIZE, client_sha256: source.sha256 } } });
    expect(submitted.receipt).toMatchObject({ command_key: uploadKey, input_id: uploadedInput, transfer_revision: 1 });
    const uploadedVersion: string = submitted.receipt.version_id, uploadedTransfer: string = submitted.receipt.transfer_id;
    expect(uploadedVersion).toMatch(UUID); expect(uploadedTransfer).toMatch(UUID);
    const bytePath = `/api/cockpit/inputs/${uploadedInput}/versions/${uploadedVersion}/transfers/${uploadedTransfer}/bytes`;
    const uploadHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let transmitted = 0; const transmittedHash = createHash("sha256"), uploadStarted = Date.now();
    try {
      sameFile(source.info, await uploadHandle.stat({ bigint: true }));
      const body = new ReadableStream<Uint8Array>({ async pull(controller) {
        try {
          const chunk = Buffer.alloc(CHUNK), result = await uploadHandle.read(chunk, 0, chunk.length, null);
          if (!result.bytesRead) { controller.close(); return; }
          const bytes = chunk.subarray(0, result.bytesRead); transmitted += bytes.length; transmittedHash.update(bytes); controller.enqueue(bytes);
        } catch (error) { controller.error(error); }
      } }, { highWaterMark: 1 });
      const init: RequestInit & { duplex: "half" } = { method: "PUT", headers: { Authorization: headers.Authorization, "X-Workspace-ID": ws.id,
        "Content-Type": "application/octet-stream", "Content-Length": String(SIZE), "X-Input-Transfer-Revision": "1" }, body, duplex: "half", redirect: "error", signal: AbortSignal.timeout(8 * 60_000) };
      const response = await fetch(`${webURL.origin}${bytePath}`, init); expect(response.status).toBe(200);
      const accepted = await response.json(); expect(accepted).toMatchObject({ workspace_id: ws.id, input_id: uploadedInput, version_id: uploadedVersion, transfer_id: uploadedTransfer,
        current: { id: uploadedTransfer, state: "awaiting_finalize", received_bytes: SIZE, pinned_size_bytes: SIZE, content_hash: source.sha256, can_finalize: true } });
      expect(transmitted).toBe(SIZE); expect(transmittedHash.digest("hex")).toBe(source.sha256);
      sameFile(source.info, await uploadHandle.stat({ bigint: true }));
      const finalizeKey = randomUUID();
      const finalized = await request(`/api/cockpit/inputs/${uploadedInput}/versions/${uploadedVersion}/transfers/${uploadedTransfer}/finalize`, { command_key: finalizeKey, expected_revision: accepted.current.revision, expected_content_hash: source.sha256 });
      expect(finalized.receipt).toMatchObject({ command_key: finalizeKey, transfer_id: uploadedTransfer, state: "verified", size_bytes: SIZE, content_hash: source.sha256 });
      const recovered = await request(`/api/cockpit/inputs/${uploadedInput}/versions/${uploadedVersion}/transfers/${uploadedTransfer}/commands/${finalizeKey}`);
      expect(recovered.receipt).toEqual(finalized.receipt);
      evidence.next_upload = { request_origin: webURL.origin, bytes: transmitted, sha256: source.sha256, elapsed_ms: Date.now() - uploadStarted, input_id: uploadedInput, version_id: uploadedVersion, transfer_id: uploadedTransfer };
    } finally { await uploadHandle.close(); }
    const download = async (inputId: string, versionId: string) => {
      const link = await request(`/api/cockpit/inputs/${inputId}/versions/${versionId}/download-link`, {});
      expect(link).toMatchObject({ input_id: inputId, version_id: versionId, size_bytes: SIZE, content_hash: source.sha256 });
      expect(link.url).toMatch(new RegExp(`^/api/cockpit/input-files/${versionId}/download\\?token=[^&]+$`));
      const remaining = Date.parse(link.expires_at) - Date.now(); expect(remaining).toBeGreaterThan(0); expect(remaining).toBeLessThanOrEqual(60_000);
      // Node fetch has no cookie jar. Deliberately send no session or authorization.
      const response = await fetch(new URL(link.url, apiURL.origin), { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8 * 60_000) });
      expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBe(String(SIZE)); expect(response.headers.get("etag")).toBe(`"${source.sha256}"`);
      expect(response.headers.get("referrer-policy")).toBe("no-referrer"); expect(response.body).not.toBeNull();
      const reader = response.body!.getReader(), hash = createHash("sha256"); let bytes = 0;
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; expect(bytes).toBeLessThanOrEqual(SIZE); hash.update(chunk.value); } }
      finally { reader.releaseLock(); }
      expect(bytes).toBe(SIZE); const digest = hash.digest("hex"); expect(digest).toBe(source.sha256);
      return { bytes, sha256: digest, origin: apiURL.origin, credential_headers: 0 };
    };
    evidence.next_fixed_download = await download(uploadedInput, uploadedVersion);

    // Observe after the large upload, so the source confirmation token is fresh.
    let cursor = "", observed: { relative_path: string; observation_token: string } | null = null;
    for (let page = 0; page < 100; page++) {
      const entries = await request(`/api/cockpit/input-spaces/${rootId}/entries`, { relative_directory: scope, q: filename, cursor, page_size: 25 });
      expect(entries).toMatchObject({ root_id: rootId, relative_directory: scope, q: filename, page_size: 25 });
      expect(entries.items.length).toBeLessThanOrEqual(25);
      const found = entries.items.find((entry: { relative_path: string }) => entry.relative_path === relativePath);
      if (found) { expect(found).toMatchObject({ kind: "file", size_bytes: SIZE, can_select: true }); expect(found.observation_token).not.toBe(""); observed = found; break; }
      if (!entries.has_more) break;
      expect(entries.next_cursor).toEqual(expect.any(String)); expect(entries.next_cursor).not.toBe(cursor); cursor = entries.next_cursor;
    }
    expect(observed).not.toBeNull();
    const capturedInput = await createInput("Real SMB fixed capture source");
    const captured = await request(`/api/cockpit/inputs/${capturedInput}/versions`, { command_key: randomUUID(), expected_revision: 1,
      source: { kind: "nas_file", nas_file: { root_id: rootId, relative_path: observed!.relative_path, observation_token: observed!.observation_token } } });
    const capturedVersion: string = captured.receipt.version_id, capturedTransfer: string = captured.receipt.transfer_id;
    expect(capturedVersion).toMatch(UUID); expect(capturedTransfer).toMatch(UUID);
    await expect.poll(async () => (await request(`/api/cockpit/inputs/${capturedInput}/versions/${capturedVersion}`)).version.capture_state, { timeout: 8 * 60_000, intervals: [500, 1000, 2000] }).toBe("ready");
    const capturedDetail = await request(`/api/cockpit/inputs/${capturedInput}/versions/${capturedVersion}`);
    expect(capturedDetail.version).toMatchObject({ source: { kind: "nas_file" }, size_bytes: SIZE, content_hash: source.sha256, capture_state: "ready" });
    const fixedFacts = await db.query("SELECT source_before_file_identity,source_after_file_identity,source_before_size::text,source_after_size::text,source_before_mtime_ns::text,source_after_mtime_ns::text,io_outcome FROM cockpit_input_transfer WHERE workspace_id=$1 AND id=$2", [ws.id, capturedTransfer]);
    expect(fixedFacts.rows).toHaveLength(1); const fact = fixedFacts.rows[0];
    expect(fact.source_before_file_identity).toMatch(/^[0-9a-f]{64}$/); expect(fact.source_after_file_identity).toBe(fact.source_before_file_identity);
    expect(fact.source_before_size).toBe(String(SIZE)); expect(fact.source_after_size).toBe(String(SIZE)); expect(fact.source_before_mtime_ns).toBe(source.info.mtimeNs.toString()); expect(fact.source_after_mtime_ns).toBe(fact.source_before_mtime_ns); expect(fact.io_outcome).toBe("verified");
    evidence.nas_capture = { input_id: capturedInput, version_id: capturedVersion, transfer_id: capturedTransfer, persisted_observation: fact, fixed_download: await download(capturedInput, capturedVersion) };
    // File capture and run inputs are shared capabilities; retiring the
    // meeting collection UI does not remove their fixed bytes or proofs.
    expect(uploadedVersion).not.toBe(capturedVersion);
    expect(await api.getWorkspaceAgentRunCount()).toBe(0); expect((await api.getOwnedMeetingLifecycle(meeting.id)).materials).toBeNull();
    evidence.agent_runs = 0; evidence.materials_not_implicitly_confirmed = true; evidence.workspace_id = ws.id; evidence.meeting_id = meeting.id;
    // Private storage keys are never requested through the public capability.
    for (const [versionId, transferId] of [[uploadedVersion, uploadedTransfer], [capturedVersion, capturedTransfer]]) {
      const anonymous = await fetch(`${apiURL.origin}/uploads/workspaces/${ws.id}/input-versions/${versionId}/${transferId}`, { redirect: "error" });
      expect(anonymous.status).toBe(404); await anonymous.body?.cancel();
    }
    sameFile(source.info, await lstat(sourcePath, { bigint: true })); expect(await hashFile(sourcePath, source.info)).toEqual({ bytes: SIZE, sha256: source.sha256 });
    evidence.source_after = identity(await lstat(sourcePath, { bigint: true })); evidence.source_after_sha256 = source.sha256;
  } finally {
    try {
      if (workspaceId) {
        const transfers = await db.query<{ id: string; version_id: string; owned_storage_key: string }>("SELECT id,version_id,owned_storage_key FROM cockpit_input_transfer WHERE workspace_id=$1 ORDER BY id", [workspaceId]);
        expect(transfers.rows.length).toBeLessThanOrEqual(2);
        for (const transfer of transfers.rows) expect(transfer.owned_storage_key).toBe(`workspaces/${workspaceId}/input-versions/${transfer.version_id}/${transfer.id}`);
        await api.cleanupCreatedWorkspace();
        expect((await db.query("SELECT id FROM workspace WHERE id=$1", [workspaceId])).rows).toHaveLength(0);
        expect((await db.query("SELECT id FROM cockpit_input_version WHERE workspace_id=$1", [workspaceId])).rows).toHaveLength(0);
        // Advance only these owned, now-sanitized cleanup intents. Deletion is
        // performed by the running production worker with its exact-key checks.
        await db.query("UPDATE cockpit_input_transfer SET cleanup_due_at=now() WHERE workspace_id=$1 AND workspace_deleted_at IS NOT NULL AND id=ANY($2::uuid[]) AND cleanup_state IN ('pending','retry_wait')", [workspaceId, transfers.rows.map((row) => row.id)]);
        await expect.poll(async () => Number((await db.query("SELECT count(*) FROM cockpit_input_transfer WHERE workspace_id=$1 AND cleanup_state<>'deleted'", [workspaceId])).rows[0].count), { timeout: 120_000, intervals: [500, 1000, 2000] }).toBe(0);
        expect(await realpath(privateRoot)).toBe(privateRoot); const currentPrivate = await lstat(privateRoot, { bigint: true }); expect([currentPrivate.dev, currentPrivate.ino]).toEqual([privateInfo.dev, privateInfo.ino]);
        for (const transfer of transfers.rows) {
          const ownedObject = join(privateRoot, transfer.owned_storage_key);
          for (const suffix of ["", ".meta.json", ".tmp", ".meta.json.tmp"]) await expect(lstat(`${ownedObject}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const retained = await db.query("SELECT id,cleanup_state,command_receipt,actor_id,workspace_deleted_at IS NOT NULL AS workspace_deleted FROM cockpit_input_transfer WHERE workspace_id=$1 ORDER BY id", [workspaceId]);
        expect(retained.rows).toHaveLength(transfers.rows.length);
        for (const row of retained.rows) expect(row).toMatchObject({ cleanup_state: "deleted", command_receipt: {}, actor_id: null, workspace_deleted: true });
        evidence.cleanup = { owned_workspace: "HTTP 204 and database absent", private_objects_absent: transfers.rows.length, deleted_transfer_tombstones_retained: retained.rows.map((row) => row.id) };
      }
      if (sourcePath && sourceInfo && sourceHash) { sameFile(sourceInfo, await lstat(sourcePath, { bigint: true })); expect(await hashFile(sourcePath, sourceInfo)).toEqual({ bytes: SIZE, sha256: sourceHash }); evidence.nas_source_retained = true; }
      const currentRoot = await lstat(root, { bigint: true }), currentBoundary = await lstat(boundary, { bigint: true });
      expect([currentRoot.dev, currentRoot.ino, currentBoundary.dev, currentBoundary.ino]).toEqual([rootInfo.dev, rootInfo.ino, boundaryInfo.dev, boundaryInfo.ino]);
      sameFile(markerInfo, await lstat(marker, { bigint: true })); expect((await readFile(marker, "utf8")).trim()).toBe(rootId);
    } finally {
      await db.end();
      await writeFile(info.outputPath("input-real-nas-next-500mib-evidence.json"), JSON.stringify(evidence, null, 2));
    }
  }
});
