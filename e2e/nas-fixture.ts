import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const share = "/Volumes/人机协作空间";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Real-share writes require an explicit opt-in and one owned identity root. */
export async function createNASFilesystemFixture(purpose: "minutes" | "directory" = "minutes") {
  const configuredRoot = process.env.MULTICA_E2E_NAS_ROOT_PATH;
  const rootId = process.env.MULTICA_E2E_NAS_ROOT_ID;
  if (!configuredRoot || !rootId || !uuid.test(rootId)) throw new Error("Missing NAS fixture root identity");
  const root = await realpath(configuredRoot);
  const realNAS = process.env.MULTICA_E2E_REAL_NAS === "1";
  if (purpose === "directory" && realNAS) throw new Error("Directory preparation acceptance is restricted to the explicitly configured local QA root");
  if (realNAS) {
    if (process.platform !== "darwin" || resolve(configuredRoot) !== root
      || root !== join(share, `.multica-validation-${rootId}`)) {
      throw new Error("Real NAS verification requires the exact, unique identity directory on the authorized share");
    }
    const mounted = await run("/sbin/mount", ["-t", "smbfs"]);
    // Mount output can contain a username. Inspect it without logging it.
    if (!mounted.stdout.split("\n").some((line) => line.includes(` on ${share} (smbfs,`))) {
      throw new Error("The authorized share is not mounted as SMB");
    }
    const [rootFS, shareFS, rootStat, shareStat] = await Promise.all([statfs(root), statfs(share), stat(root), stat(share)]);
    if (rootFS.type !== shareFS.type || rootStat.dev !== shareStat.dev) {
      throw new Error("The validation root is not on the authorized SMB filesystem");
    }
  } else {
    const fixtureBase = await realpath(join(homedir(), "var/multica-dev-test"));
    const rootRelative = relative(fixtureBase, root);
    if (!rootRelative || rootRelative.startsWith(`..${sep}`) || rootRelative === ".." || rootRelative.startsWith(sep)) {
      throw new Error("Refusing filesystem writes outside the dedicated agent 3 test fixture directory");
    }
  }
  const marker = join(root, ".multica-root-id");
  if (!(await lstat(marker)).isFile() || (await readFile(marker, "utf8")).trim() !== rootId) {
    throw new Error("The NAS fixture root marker does not match its configured identity");
  }
  const identity = await stat(root, { bigint: true });
  const boundary = purpose === "directory" ? join(root, "directory-e2e") : root;
  const boundaryIdentity = await lstat(boundary, { bigint: true });
  if (!boundaryIdentity.isDirectory() || boundaryIdentity.isSymbolicLink() || await realpath(boundary) !== boundary || boundaryIdentity.dev !== identity.dev) {
    throw new Error("NAS fixture boundary must be a preconfigured directory on the verified root");
  }
  const prefix = purpose === "directory" ? "directory-e2e-" : "minutes-e2e-";
  const directory = await mkdtemp(join(boundary, prefix));
  const directoryIdentity = await lstat(directory, { bigint: true });
  return {
    directory, rootId, root, realNAS,
    async cleanup() {
      const current = await stat(root, { bigint: true });
      const currentBoundary = await lstat(boundary, { bigint: true });
      const child = await lstat(directory, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino
        || !currentBoundary.isDirectory() || currentBoundary.isSymbolicLink() || currentBoundary.dev !== boundaryIdentity.dev || currentBoundary.ino !== boundaryIdentity.ino
        || await realpath(boundary) !== boundary
        || !child.isDirectory() || child.dev !== directoryIdentity.dev || child.ino !== directoryIdentity.ino
        || (await readFile(marker, "utf8")).trim() !== rootId
        || relative(boundary, directory) !== basename(directory) || !basename(directory).startsWith(prefix)) {
        throw new Error("Refusing cleanup after the owned NAS fixture identity changed");
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
