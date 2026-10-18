import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

/** This fixture may mutate only its own small files on agent 3's local QA
 * root. It deliberately refuses the real NAS fixture and all symlink paths. */
export async function createOwnedInputFilesystem() {
  if (process.env.MULTICA_E2E_REAL_NAS === "1") throw new Error("Source-change UI acceptance requires the local QA root");
  const configured = process.env.MULTICA_E2E_NAS_ROOT_PATH, rootId = process.env.MULTICA_E2E_NAS_ROOT_ID;
  if (!configured || !rootId || !/^[0-9a-f-]{36}$/i.test(rootId)) throw new Error("Configured local input fixture identity required");
  const base = await realpath(join(homedir(), "var/multica-dev-test")); const root = await realpath(configured);
  const location = relative(base, root);
  if (!location || location === ".." || location.startsWith(`..${sep}`) || location.startsWith(sep) || root !== configured) throw new Error("Input fixture must be within the dedicated agent 3 test directory");
  const marker = join(root, ".multica-root-id"), boundary = join(root, "input-e2e");
  const [rootStat, boundaryStat, markerStat] = await Promise.all([lstat(root, { bigint: true }), lstat(boundary, { bigint: true }), lstat(marker)]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !boundaryStat.isDirectory() || boundaryStat.isSymbolicLink() || boundaryStat.dev !== rootStat.dev || await realpath(boundary) !== boundary
    || !markerStat.isFile() || markerStat.isSymbolicLink() || (await readFile(marker, "utf8")).trim() !== rootId) throw new Error("Input fixture boundary identity mismatch");
  const directory = await mkdtemp(join(boundary, "input-ui-")); const identity = await lstat(directory, { bigint: true });
  async function verify() {
    const [r, b, d, m] = await Promise.all([lstat(root, { bigint: true }), lstat(boundary, { bigint: true }), lstat(directory, { bigint: true }), lstat(marker)]);
    if (r.ino !== rootStat.ino || r.dev !== rootStat.dev || r.isSymbolicLink() || b.ino !== boundaryStat.ino || b.dev !== boundaryStat.dev || b.isSymbolicLink() || d.ino !== identity.ino || d.dev !== identity.dev || d.isSymbolicLink()
      || !m.isFile() || m.isSymbolicLink() || (await readFile(marker, "utf8")).trim() !== rootId || relative(boundary, directory) !== basename(directory)) throw new Error("Input fixture identity changed");
  }
  const names = { stable: "可固定的会议材料.txt", changed: "观察后已变化的资料.txt" };
  const initial = Buffer.from("原始材料：用于人类会议准备。\n"); const stats = new Map<string, { ino: bigint; dev: bigint }>();
  for (const name of Object.values(names)) {
    const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(initial); const stat = await file.stat({ bigint: true }); stats.set(name, { ino: stat.ino, dev: stat.dev }); } finally { await file.close(); }
  }
  return { root, rootId, directory, directoryName: basename(directory), names, initial,
    async changeObservedFile() {
      await verify(); const path = join(directory, names.changed);
      const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
      try { const stat = await file.stat({ bigint: true }); const expected = stats.get(names.changed)!;
        if (!stat.isFile() || stat.ino !== expected.ino || stat.dev !== expected.dev) throw new Error("Refusing mutation after input file identity changed");
        await file.truncate(0); await file.writeFile("该本地测试资料在选择后发生了大小变化，必须重新核对来源。\n新增内容\n"); await file.sync();
      } finally { await file.close(); }
    },
    async cleanup() { await verify(); await rm(directory, { recursive: true, force: false }); },
  };
}
