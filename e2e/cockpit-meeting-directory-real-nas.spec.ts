import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, lstat, realpath, statfs } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { TestApiClient } from "./fixtures";

test("confirms owned real SMB directory plans and preserves fixed receipts and conflicting files", async ({}, info) => {
  test.setTimeout(150_000);
  test.skip(process.env.MULTICA_E2E_REAL_NAS !== "1", "Requires explicit authorization for the retained, owned real NAS fixture");
  expect(process.platform).toBe("darwin");
  expect(basename(homedir())).toBe("fosun_agent_3");
  const database = new URL(process.env.DATABASE_URL || "invalid://missing");
  expect(["127.0.0.1", "localhost"]).toContain(database.hostname);
  expect(decodeURIComponent(database.pathname)).toMatch(/_test$/);
  const apiURL = new URL(process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`);
  expect(["127.0.0.1", "localhost"]).toContain(apiURL.hostname);
  expect(apiURL.port).toBe("18880");
  const root = process.env.MULTICA_E2E_NAS_ROOT_PATH!;
  const rootId = process.env.MULTICA_E2E_NAS_ROOT_ID!;
  const scope = process.env.MULTICA_E2E_NAS_PREPARE_SCOPE!;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  expect(rootId).toMatch(uuid);
  expect(process.env.MULTICA_E2E_NAS_WORKSPACE_ID).toMatch(uuid);
  // A single explicitly provisioned child scope prevents traversal or silently widening the test boundary.
  expect(scope).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/);
  expect(root).toBe(`/Volumes/人机协作空间/.multica-validation-${rootId}`);
  expect(await realpath(root)).toBe(root);
  const marker = join(root, ".multica-root-id"); const markerInfo = await lstat(marker);
  expect(markerInfo.isFile() && !markerInfo.isSymbolicLink()).toBe(true);
  expect((await readFile(marker, "utf8")).trim()).toBe(rootId);
  expect(execFileSync("/sbin/mount", ["-t", "smbfs"], { encoding: "utf8" }).split("\n").some((line) => line.includes(" on /Volumes/人机协作空间 (smbfs,"))).toBe(true);
  expect((await statfs(root)).type).toBe((await statfs("/Volumes/人机协作空间")).type);
  const boundary = join(root, scope); const boundaryInfo = await lstat(boundary);
  expect(boundaryInfo.isDirectory() && !boundaryInfo.isSymbolicLink()).toBe(true);
  expect(await realpath(boundary)).toBe(boundary);
  expect(boundaryInfo.dev).toBe((await lstat(root)).dev);
  const api = new TestApiClient(); let owned = false;
  const evidence: Record<string, unknown> = { host: "fosun_agent_3", physical_root: root, root_id: rootId, scope, real_smb: true, physical_cleanup: "retained; no removal or rename requested" };
  try {
    const suffix = randomUUID().slice(0, 8);
    await api.login(`n1-realnas-${suffix}@multica.ai`, "Owned NAS verifier");
    const ws = await api.createNASFixtureWorkspace(`Owned directory verification ${suffix}`, `n1-realnas-${suffix}`); owned = true;
    await api.updateCockpitBoard({ title: "Owned directory verification" });
    const meeting = await api.createCockpitMeeting({ title: "Synthetic NAS preparation evidence", nas_dir: "", meet_date: "2026-10-11" });
    const base = apiURL.origin;
    const headers = { Authorization: `Bearer ${api.getToken()}`, "Content-Type": "application/json", "X-Workspace-ID": ws.id };
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() };
    };
    const prefix = `/api/cockpit/meetings/${meeting.id}`;
    const relative = `${scope}/meeting-evidence-${suffix}`;
    const target = join(root, relative);
    const partitions = ["已核资料", "录音转写"];
    const summary = await request(`${prefix}/directory-preparation`); expect(summary.status).toBe(200);
    const input = { mode: "prepare", root_id: rootId, relative_directory: relative, partitions, observed_nas_dir: summary.data.binding.nas_dir, observed_binding_revision: summary.data.binding.revision, bind_after_base: true };
    const preview = await request(`${prefix}/directory-preparations/preview`, input);
    expect(preview.status).toBe(200); expect(preview.data.can_confirm).toBe(true); expect(preview.data.counts.missing).toBeGreaterThan(0);
    const command = { ...input, command_key: randomUUID(), expected_revision: input.observed_binding_revision, context_token: preview.data.context_token };
    const accepted = await fetch(`${base}${prefix}/directory-preparations`, { method: "POST", headers, body: JSON.stringify(command) }); expect(accepted.status).toBeGreaterThanOrEqual(200); expect(accepted.status).toBeLessThan(300);
    await accepted.body?.cancel();
    // Discard the actual response body, then recover only through the fixed key.
    evidence.create_response_body_discarded = true;
    const recovered = await request(`${prefix}/lifecycle/commands/${command.command_key}`); expect(recovered.status).toBe(200);
    const receipt = recovered.data.receipt.directory; expect(receipt.directory_operation_id).toMatch(/^[0-9a-f-]{36}$/);
    const operation = receipt.directory_operation_id;
    await expect.poll(async () => (await api.getOwnedDirectoryOperation(meeting.id, operation)).state, { timeout: 45_000 }).toBe("completed");
    const initial = await api.getOwnedDirectorySteps(meeting.id, operation); expect(initial.items.every((x) => x.state === "satisfied")).toBe(true); expect(initial.items.every((x) => x.outcome === "created")).toBe(true);
    const firstIdentity = await lstat(target, { bigint: true });
    const replay = await request(`${prefix}/directory-preparations`, command); expect(replay.status).toBe(200); expect(replay.data.replayed).toBe(true); expect(replay.data.receipt).toEqual(receipt); expect(replay.data.current.state).toBe("completed");
    const binding = (await request(`${prefix}/directory-preparation`)).data.binding;
    const repairInput = { ...input, mode: "repair", partitions: [...partitions, "新增明确分区"], observed_nas_dir: binding.nas_dir, observed_binding_revision: binding.revision, bind_after_base: false };
    const repairPreview = await request(`${prefix}/directory-preparations/preview`, repairInput); expect(repairPreview.status).toBe(200); expect(repairPreview.data.can_confirm).toBe(true); expect(repairPreview.data.counts.exists).toBe(3); expect(repairPreview.data.counts.missing).toBe(1);
    const repair = await request(`${prefix}/directory-preparations`, { ...repairInput, command_key: randomUUID(), expected_revision: binding.revision, context_token: repairPreview.data.context_token }); expect(repair.status).toBeGreaterThanOrEqual(200); expect(repair.status).toBeLessThan(300);
    const repairId = repair.data.receipt.directory_operation_id; expect(repairId).not.toBe(operation);
    await expect.poll(async () => (await api.getOwnedDirectoryOperation(meeting.id, repairId)).state, { timeout: 45_000 }).toBe("completed");
    const repaired = await api.getOwnedDirectorySteps(meeting.id, repairId); expect(repaired.items.filter((x) => x.outcome === "observed_existing")).toHaveLength(3); expect(repaired.items.filter((x) => x.outcome === "created")).toHaveLength(1);
    const afterIdentity = await lstat(target, { bigint: true }); expect([afterIdentity.dev, afterIdentity.ino]).toEqual([firstIdentity.dev, firstIdentity.ino]);
    const conflictInput = { ...repairInput, partitions: [...repairInput.partitions, "保留冲突样本", "拒绝后不得创建"] };
    const beforeConflict = await request(`${prefix}/directory-preparations/preview`, conflictInput); expect(beforeConflict.status).toBe(200); expect(beforeConflict.data.can_confirm).toBe(true); expect(beforeConflict.data.context_token).not.toBe("");
    const sentinel = join(target, "保留冲突样本"); const contents = Buffer.from("Owned N1 verification evidence. Preserve this file.\n", "utf8"); await writeFile(sentinel, contents, { flag: "wx" });
    const sentinelHash = createHash("sha256").update(contents).digest("hex");
    const rejected = await request(`${prefix}/directory-preparations`, { ...conflictInput, command_key: randomUUID(), expected_revision: binding.revision, context_token: beforeConflict.data.context_token }); expect(rejected.status).toBe(409); expect(rejected.data.code).toBe("context_changed");
    expect(createHash("sha256").update(await readFile(sentinel)).digest("hex")).toBe(sentinelHash);
    await expect(lstat(join(target, "拒绝后不得创建"))).rejects.toMatchObject({ code: "ENOENT" });
    const list = await request(`${prefix}/directory-preparations?page_size=25`); expect(list.status).toBe(200); expect(list.data.total).toBe(2);
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    Object.assign(evidence, { workspace_id: ws.id, meeting_id: meeting.id, target, operation_id: operation, repair_operation_id: repairId, fixed_receipt: receipt, original_steps: initial.items, repair_steps: repaired.items, conflict_status: rejected.status, conflict_code: rejected.data.code, sentinel_path: sentinel, sentinel_sha256: sentinelHash, operation_count: list.data.total, agent_runs: 0, filesystem_paths_retained: [target, ...repairInput.partitions.map((name) => join(target, name)), sentinel] });
  } finally {
    if (owned) { await api.cleanupCreatedWorkspace(); evidence.owned_workspace_cleanup = "HTTP 204"; }
    await writeFile(info.outputPath("real-nas-directory-evidence.json"), JSON.stringify(evidence, null, 2));
  }
});
