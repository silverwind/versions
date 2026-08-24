import {Buffer} from "node:buffer";
import {readFileSync} from "node:fs";
import {readFile, writeFile, rm, mkdir, mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  isSemver, incrementSemver, replaceTokens, esc,
  joinStrings, findUp, getFileChanges, write, findCompanionLockfile,
  readVersionFile,
  removeIgnoredFiles, getForgeTokens, githubTokenEnvNames, giteaTokenEnvNames,
  getRepoInfo, writeResult, createForgeRelease, pingForge,
  readChangelogEntry, updateChangelogHeadingDate,
  type RepoInfo,
} from "./api.ts";
import {exec, tomlGetString, SubprocessError} from "./utils.ts";

const distPath = join(process.cwd(), "dist/index.js");
const pkgJson = (version: string) => JSON.stringify({name: "test-pkg", version}, null, 2);
const pep621 = (version: string) => `[project]\nname = "test-project"\nversion = "${version}"\n`;

// bun's vitest-compat `vi` lacks stubGlobal/unstubAllGlobals, so fall back to manual restore.
const stubbedGlobals = new Map<string, unknown>();
function stubGlobal(name: string, value: unknown) {
  if (typeof vi.stubGlobal === "function") {
    vi.stubGlobal(name, value);
  } else {
    if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, (globalThis as any)[name]);
    (globalThis as any)[name] = value;
  }
}

// bun's --concurrent ignores `describe({concurrent: false})`, so tests touching global state opt out
// one by one via its `test.serial`. vitest has no such thing and honors the describe option instead.
const serialTest: typeof test = (test as any).serial ?? test;

beforeAll(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  if (typeof vi.unstubAllGlobals === "function") {
    vi.unstubAllGlobals();
  } else {
    for (const [name, value] of stubbedGlobals) (globalThis as any)[name] = value;
    stubbedGlobals.clear();
  }
});

async function createBareRemote(tmpDir: string): Promise<string> {
  const bareDir = join(tmpDir, "remote.git");
  await exec("git", ["init", "--bare", "-q", bareDir]);
  return bareDir;
}

function getIsolatedGitEnv(tmpDir: string) {
  const isolatedHome = join(tmpDir, ".home");
  return {
    HOME: isolatedHome,
    GIT_CONFIG_GLOBAL: join(isolatedHome, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
}

async function initGitRepo(tmpDir: string) {
  const env = getIsolatedGitEnv(tmpDir);
  const opts = {cwd: tmpDir, env: {...process.env, ...env}};
  await mkdir(env.HOME, {recursive: true});
  await exec("git", ["init", "-q"], opts);
  return opts;
}

async function withTmpDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "versions-test-"));
  try {
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
}

// callers must write tracked files first, this stages everything via `git add .`
// the fetch URL is a non-resolvable gitea host so --release tests fail at DNS without touching the network
async function setupReleaseRepo(tmpDir: string) {
  const [opts, bareDir] = await Promise.all([initGitRepo(tmpDir), createBareRemote(tmpDir)]);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "Initial commit"], opts);
  await exec("git", ["remote", "add", "origin", "https://gitea.invalid/o/r.git"], opts);
  await exec("git", ["remote", "set-url", "--push", "origin", bareDir], opts);
  await exec("git", ["push", "origin", "master"], opts);
  await exec("git", ["tag", "1.0.0"], opts);
  return {bareDir, opts};
}

async function runFail(args: string[], opts?: Parameters<typeof exec>[2]): Promise<SubprocessError> {
  try {
    await exec("node", [distPath, ...args], opts);
  } catch (err) {
    if (err instanceof SubprocessError) return err;
    throw err;
  }
  throw new Error(`expected \`versions ${args.join(" ")}\` to fail`);
}

test("version", async () => {
  const {version: expected} = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
  const {stdout} = await exec("node", [distPath, "-v"]);
  expect(stdout).toEqual(expected);
});

test("semver", () => {
  expect(isSemver("1.0.0")).toEqual(true);
  expect(isSemver("1.0.0-pre-1.0.0")).toEqual(true);
  expect(isSemver("1.2.3-0123")).toEqual(false);
  expect(incrementSemver("1.0.0", "patch")).toEqual("1.0.1");
  expect(incrementSemver("1.0.0", "minor")).toEqual("1.1.0");
  expect(incrementSemver("1.0.0", "major")).toEqual("2.0.0");
  expect(incrementSemver("2.0.0", "patch")).toEqual("2.0.1");
  expect(incrementSemver("2.0.1", "minor")).toEqual("2.1.0");
  expect(incrementSemver("2.1.1", "major")).toEqual("3.0.0");
  expect(incrementSemver("10.10.10", "patch")).toEqual("10.10.11");
  expect(incrementSemver("10.10.10", "minor")).toEqual("10.11.0");
  expect(incrementSemver("10.10.10", "major")).toEqual("11.0.0");
  expect(incrementSemver("1.0.0-pre-1.0.0", "patch")).toEqual("1.0.1");
  expect(incrementSemver("1.0.0-pre-1.0.0", "minor")).toEqual("1.1.0");
  expect(incrementSemver("1.0.0-pre-1.0.0", "major")).toEqual("2.0.0");
  expect(incrementSemver("10.10.10-pre-1.0.0", "patch")).toEqual("10.10.11");
  expect(incrementSemver("10.10.10-pre-1.0.0", "minor")).toEqual("10.11.0");
  expect(incrementSemver("10.10.10-pre-1.0.0", "major")).toEqual("11.0.0");
});

test("versions", () => withTmpDir(async (tmpDir) => {
  const pkgStr = readFileSync(new URL("package.json", import.meta.url), "utf8");
  let {version} = JSON.parse(pkgStr);

  await writeFile(join(tmpDir, "package.json"), pkgStr);
  await writeFile(join(tmpDir, "testfile"), `testfile v${version} (1999-01-01)`);

  const run = (args: string) => exec(`node ${distPath} ${args}`, [], {shell: true, cwd: tmpDir});
  const verify = async (ver: string) => {
    expect(await readFile(join(tmpDir, "testfile"), "utf8")).toEqual(
      `testfile v${ver} (${(new Date()).toISOString().substring(0, 10)})`
    );
    return ver;
  };

  await run(`--date --base ${version} --gitless patch testfile`);
  version = await verify(incrementSemver(version, "patch"));

  await run(`--date --base ${version} --gitless minor testfile`);
  version = await verify(incrementSemver(version, "minor"));

  await run(`--date --base ${version} --gitless major testfile`);
  version = await verify(incrementSemver(version, "major"));

  // a file named twice must dedupe to a single replacement pass
  await run(`--date --base ${version} --gitless major testfile testfile`);
  version = await verify(incrementSemver(version, "major"));
}));

test("poetry", () => withTmpDir(async (tmpDir) => {
  const str = await readFile(new URL("fixtures/poetry/pyproject.toml", import.meta.url), "utf8");
  const versionBefore = tomlGetString(str, "tool.poetry", "version")!;
  expect(tomlGetString(str, "tool.poetry.dependencies", "flask")).toEqual(versionBefore);

  await writeFile(join(tmpDir, "pyproject.toml"), str);
  await exec(`node ${distPath} minor --gitless --date --base ${versionBefore} pyproject.toml`, [], {shell: true, cwd: tmpDir});

  const afterStr = await readFile(join(tmpDir, "pyproject.toml"), "utf8");
  const versionAfter = incrementSemver(versionBefore, "minor");
  expect(tomlGetString(afterStr, "tool.poetry", "version")).toEqual(versionAfter);
  expect(tomlGetString(afterStr, "tool.poetry.dependencies", "flask")).toEqual(versionBefore);
}));

test("uv", () => withTmpDir(async (tmpDir) => {
  const pyproject = await readFile(new URL("fixtures/uv/pyproject.toml", import.meta.url), "utf8");
  const lock = await readFile(new URL("fixtures/uv/uv.lock", import.meta.url), "utf8");

  const name = tomlGetString(pyproject, "project", "name")!;
  const versionBefore = tomlGetString(pyproject, "project", "version")!;

  await writeFile(join(tmpDir, "pyproject.toml"), pyproject);
  await writeFile(join(tmpDir, "uv.lock"), lock);
  await exec(`node ${distPath} minor --gitless --date --base ${versionBefore} pyproject.toml uv.lock`, [], {shell: true, cwd: tmpDir});

  const afterStr = await readFile(join(tmpDir, "pyproject.toml"), "utf8");
  const versionAfter = incrementSemver(versionBefore, "minor");
  expect(tomlGetString(afterStr, "project", "version")).toEqual(versionAfter);

  const lockStr = await readFile(join(tmpDir, "uv.lock"), "utf8");
  const lockMatch = new RegExp(`\\[\\[package\\]\\]\nname = "${name}"\nversion = "([^"]+)"`).exec(lockStr);
  expect(lockMatch![1]).toEqual(versionAfter);
}));

test.each([
  {from: "package.json", files: {"package.json": pkgJson("2.5.0")}, level: "patch", before: "2.5.0", after: "2.5.1"},
  {from: "pyproject.toml", files: {"pyproject.toml": pep621("3.2.1")}, level: "minor", before: "3.2.1", after: "3.3.0"},
  {from: "poetry-style pyproject.toml", files: {"pyproject.toml": `[tool.poetry]\nname = "poetry-test"\nversion = "0.5.2"\n`}, level: "patch", before: "0.5.2", after: "0.5.3"},
  {from: "package.json over pyproject.toml", files: {"package.json": pkgJson("1.0.0"), "pyproject.toml": pep621("2.0.0")}, level: "patch", before: "1.0.0", after: "1.0.1"},
  {from: "pyproject.toml when package.json has invalid semver", files: {"package.json": pkgJson("invalid"), "pyproject.toml": pep621("3.0.0")}, level: "minor", before: "3.0.0", after: "3.1.0"},
])("base version with no git tags comes from $from", ({files, level, before, after}) => withTmpDir(async (tmpDir) => {
  for (const [name, content] of Object.entries(files)) await writeFile(join(tmpDir, name), content);
  await writeFile(join(tmpDir, "testfile.txt"), `version ${before}`);

  await exec("node", [distPath, "--gitless", level, "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual(`version ${after}`);
}));

test("version files above the repo root are not used", () => withTmpDir(async (tmpDir) => {
  const repoDir = join(tmpDir, "repo");
  await mkdir(repoDir, {recursive: true});
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "outer", version: "42.0.0"}));
  await writeFile(join(repoDir, "testfile.txt"), "version 0.0.0");
  await initGitRepo(repoDir);

  const {stderr} = await exec("node", [distPath, "-D", "-V", "patch", "testfile.txt"], {cwd: repoDir});

  expect(stderr).toContain("base version 0.0.0 from default");
  expect(stderr).not.toContain("42.0.0");
}));

test("version file at the repo root is still found from a subdirectory", () => withTmpDir(async (tmpDir) => {
  const subDir = join(tmpDir, "sub");
  await mkdir(subDir, {recursive: true});
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "5.0.0"}));
  await initGitRepo(tmpDir);

  const {stderr} = await exec("node", [distPath, "-D", "-V", "patch"], {cwd: subDir});

  expect(stderr).toContain("base version 5.0.0 from package.json");
}));

test("warns only when a manifest disagrees with a detected base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "9.9.9"}));
  const {opts} = await setupReleaseRepo(tmpDir); // tags 1.0.0

  expect((await exec("node", [distPath, "-D", "patch", "package.json"], opts)).stderr)
    .toContain("warning: package.json declares 9.9.9 but the base version is 1.0.0");
  expect((await exec("node", [distPath, "-D", "--base=7.0.0", "patch", "package.json"], opts)).stderr).not.toContain("warning:");

  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}));
  expect((await exec("node", [distPath, "-D", "patch", "package.json"], opts)).stderr).not.toContain("warning:");
}));

test("empty --base is rejected rather than ignored", () => withTmpDir(async (tmpDir) => {
  const err = await runFail(["--gitless", "--base=", "patch", "package.json"], {cwd: tmpDir});
  expect(err.output).toContain("Invalid base version");
}));

test("prerelease without preid fails", async () => {
  expect((await runFail(["--gitless", "prerelease", "testfile.txt"])).output).toContain("prerelease requires --preid option");
});

// incrementSemver covers the level matrix, this only proves the flag wires through
test("patch with preid creates prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await exec("node", [distPath, "--gitless", "--preid=alpha", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-alpha.0");
}));

test("patch with preid on prerelease version strips old prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0-alpha.5"));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0-alpha.5");

  await exec("node", [distPath, "--gitless", "--preid=beta", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-beta.0");
}));

test("package.json with non-matching base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));

  await exec("node", [distPath, "--gitless", "--base", "8.16.3", "patch", "package.json"], {cwd: tmpDir});

  const result = JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8"));
  expect(result.version).toEqual("8.16.4");
}));

test("pyproject.toml with non-matching base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), pep621("2.0.0"));

  await exec("node", [distPath, "--gitless", "--base", "5.3.1", "minor", "pyproject.toml"], {cwd: tmpDir});

  const resultStr = await readFile(join(tmpDir, "pyproject.toml"), "utf8");
  expect(tomlGetString(resultStr, "project", "version")).toEqual("5.4.0");
}));

test("lockfiles are not corrupted by version replacement", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("2.3.0"));

  const lockContent = `lockfileVersion: '9.0'

packages:

  some-dep@2.3.0:
    resolution: {integrity: sha512-abc123}
    engines: {node: '>=8'}

snapshots:

  some-dep@2.3.0:
    dependencies:
      other-dep: 1.0.0
`;
  await writeFile(join(tmpDir, "pnpm-lock.yaml"), lockContent);

  await exec("node", [distPath, "--gitless", "--base", "2.3.0", "patch", "package.json", "pnpm-lock.yaml"], {cwd: tmpDir});

  const pkgAfter = JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8"));
  expect(pkgAfter.version).toEqual("2.3.1");

  expect(await readFile(join(tmpDir, "pnpm-lock.yaml"), "utf8")).toEqual(lockContent);
}));

test("readChangelogEntry", () => {
  const md = `# Changelog

## [Unreleased]

## [1.2.3] - 2024-01-15
### Added
- new thing

### Fixed
- broken thing

## 1.2.2 (2024-01-01)
- prior

## v1.2.1
old
`;
  expect(readChangelogEntry(md, "1.2.3")).toEqual("### Added\n- new thing\n\n### Fixed\n- broken thing");
  expect(readChangelogEntry(md, "1.2.2")).toEqual("- prior");
  expect(readChangelogEntry(md, "1.2.1")).toEqual("old");
  expect(readChangelogEntry(md, "v1.2.3")).toEqual("### Added\n- new thing\n\n### Fixed\n- broken thing");
  expect(readChangelogEntry(md, "9.9.9")).toBeNull();

  // Keep a Changelog trails link definitions below the last entry
  const links = `# Changelog

## [1.0.0] - 2024-01-15
- thing

[unreleased]: https://example.com/compare/v1.0.0...HEAD
[1.0.0]: https://example.com/compare/v0.9.0...v1.0.0
`;
  expect(readChangelogEntry(links, "1.0.0")).toEqual("- thing");
  // a reference-style link cited by the entry itself is kept, only the trailing run goes
  expect(readChangelogEntry("## 1.0.0\n\n[pr]: https://e.com/1\n\n- see [pr]\n\n[1.0.0]: https://e.com/c\n", "1.0.0"))
    .toEqual("[pr]: https://e.com/1\n\n- see [pr]");
  expect(readChangelogEntry("## 1.0.0\n\n[1.0.0]: https://e.com/c\n", "1.0.0")).toBeNull();

  expect(readChangelogEntry("# 1.0.0\n\nbody\n", "1.0.0")).toEqual("body");
  expect(readChangelogEntry("# 1.0.0\n\nbody\n", "1.0.10")).toBeNull();
  expect(readChangelogEntry("## 1.0.0\n## 1.0.1\nb\n", "1.0.0")).toBeNull();
  expect(readChangelogEntry("## 1.0.0-rc.1\n\nrc\n## 1.0.0\n\nrelease\n", "1.0.0")).toEqual("release");
  expect(readChangelogEntry("## 1.0.0\n\nrelease\n## 1.0.0-rc.1\n\nrc\n", "1.0.0-rc.1")).toEqual("rc");
  expect(readChangelogEntry("# Changelog\n\n## 1.0.0\nbody\n", "1.0.0")).toEqual("body");
  expect(readChangelogEntry("", "1.0.0")).toBeNull();
});

test("updateChangelogHeadingDate", () => {
  const today = "2026-04-30";

  expect(updateChangelogHeadingDate("## 1.2.3\n\nbody\n", "1.2.3", today))
    .toEqual("## 1.2.3 - 2026-04-30\n\nbody\n");

  expect(updateChangelogHeadingDate("## [1.2.3]\n\nbody\n", "1.2.3", today))
    .toEqual("## [1.2.3] - 2026-04-30\n\nbody\n");

  expect(updateChangelogHeadingDate("## 1.2.3 - YYYY-MM-DD\n\nbody\n", "1.2.3", today))
    .toEqual("## 1.2.3 - 2026-04-30\n\nbody\n");

  expect(updateChangelogHeadingDate("## [1.2.3] (yyyy-mm-dd)\n\nbody\n", "1.2.3", today))
    .toEqual("## [1.2.3] (2026-04-30)\n\nbody\n");

  expect(updateChangelogHeadingDate("## 1.2.3 - xxxx-xx-xx\n\nbody\n", "1.2.3", today))
    .toEqual("## 1.2.3 - 2026-04-30\n\nbody\n");

  expect(updateChangelogHeadingDate("## 1.2.3 - XXXX-XX-XX\n\nbody\n", "1.2.3", today))
    .toEqual("## 1.2.3 - 2026-04-30\n\nbody\n");

  expect(updateChangelogHeadingDate("## 1.2.3 - DD-MM-YYYY\n\nbody\n", "1.2.3", today))
    .toEqual("## 1.2.3 - 2026-04-30\n\nbody\n");

  expect(updateChangelogHeadingDate("## 1.2.3 - ????-??-??\n\nbody\n", "1.2.3", today))
    .toEqual("## 1.2.3 - 2026-04-30\n\nbody\n");

  expect(updateChangelogHeadingDate("## [1.2.3] - 2024-01-15\n\nbody\n", "1.2.3", today)).toBeNull();

  expect(updateChangelogHeadingDate("## 1.0.0\nbody\n", "9.9.9", today)).toBeNull();
});

function getCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
}

function postCall(mock: ReturnType<typeof vi.fn>) {
  const found = getCalls(mock).find(([, init]) => init?.method === "POST");
  if (!found) throw new Error("no POST call recorded");
  return found;
}

function authOf(init: RequestInit | undefined) {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

function mockForgePost(create: Response) {
  const mock = vi.fn(() => Promise.resolve(create));
  stubGlobal("fetch", mock);
  return mock;
}

function mockForgeConflictThenSuccess(conflictStatus: number, drafts: Array<{id: number; tag_name: string; draft: boolean}>, success: Response) {
  let postCount = 0;
  const mock = vi.fn((_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      postCount += 1;
      if (postCount === 1) return Promise.resolve(new Response(`conflict ${conflictStatus}`, {status: conflictStatus, statusText: "Conflict"}));
      return Promise.resolve(success);
    }
    if (method === "GET") return Promise.resolve(Response.json(drafts, {status: 200}));
    if (method === "DELETE") return Promise.resolve(new Response(null, {status: 204}));
    throw new Error(`unexpected method ${method}`);
  });
  stubGlobal("fetch", mock);
  return mock;
}

const githubInfo: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
const giteaInfo: RepoInfo = {owner: "o", repo: "r", host: "gitea.example.com", type: "gitea"};

// these stub globalThis.fetch; running them concurrently lets one test's stub leak into another
describe("forge requests", {concurrent: false}, () => {
  serialTest("createForgeRelease github success skips cleanup on happy path", async () => {
    const mock = mockForgePost(Response.json({id: 4242, html_url: "https://github.com/o/r/releases/tag/1.0.1"}, {status: 201}));
    await createForgeRelease(githubInfo, "1.0.1", "changelog", ["gh-token"]);
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = postCall(mock);
    expect(url).toEqual("https://api.github.com/repos/o/r/releases");
    expect(authOf(init)).toEqual("Bearer gh-token");
    const body = JSON.parse(init!.body as string);
    expect(body.tag_name).toEqual("1.0.1");
    expect(body.name).toEqual("1.0.1");
    expect(body.body).toEqual("changelog");
    expect(body.draft).toEqual(false);
    expect(body.prerelease).toEqual(false);
  });

  serialTest("createForgeRelease gitea success skips cleanup on happy path", async () => {
    const mock = mockForgePost(Response.json({html_url: "https://gitea.example.com/o/r/releases/tag/2.0.0"}, {status: 201}));
    await createForgeRelease(giteaInfo, "2.0.0", "notes", ["gitea-tok"]);
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = postCall(mock);
    expect(url).toEqual("https://gitea.example.com/api/v1/repos/o/r/releases");
    expect(authOf(init)).toEqual("token gitea-tok");
  });

  serialTest("createForgeRelease prerelease tag", async () => {
    const mock = mockForgePost(Response.json({}, {status: 201}));
    await createForgeRelease(githubInfo, "1.0.0-beta.1", "body", ["tok"]);
    expect(JSON.parse(postCall(mock)[1]!.body as string).prerelease).toEqual(true);
  });

  serialTest.each([[401, "Unauthorized"], [403, "Forbidden"]])("createForgeRelease token fallback on %i", async (status, text) => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(text, {status}))
      .mockImplementation(() => Promise.resolve(Response.json({html_url: "https://github.com/o/r/releases/tag/1.0.0"}, {status: 201})));
    stubGlobal("fetch", mock);
    await createForgeRelease(githubInfo, "1.0.0", "body", ["bad-token", "good-token"]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  serialTest("createForgeRelease throws on non-conflict, non-auth error", async () => {
    stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("Server error", {status: 500, statusText: "Internal Server Error"}))));
    await expect(createForgeRelease(githubInfo, "1.0.0", "body", ["tok"])).rejects.toThrow("500");
  });

  serialTest("createForgeRelease throws when all tokens fail", async () => {
    stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("Unauthorized", {status: 401, statusText: "Unauthorized"}))));
    await expect(createForgeRelease(githubInfo, "1.0.0", "body", ["tok1", "tok2"])).rejects.toThrow("401");
  });

  serialTest("createForgeRelease network error includes cause", async () => {
    stubGlobal("fetch", vi.fn().mockRejectedValue(
      new TypeError("fetch failed", {cause: new Error("getaddrinfo ENOTFOUND example.com")}),
    ));
    await expect(createForgeRelease(giteaInfo, "1.0.0", "body", ["tok"])).rejects.toThrow("getaddrinfo ENOTFOUND example.com");
  });

  serialTest("createForgeRelease cleans up draft on gitea 409 then retries", async () => {
    const mock = mockForgeConflictThenSuccess(
      409,
      [
        {id: 35141, tag_name: "v1.2.3", draft: true},
        {id: 35142, tag_name: "v1.2.4", draft: true},
        {id: 35143, tag_name: "v1.2.3", draft: false},
      ],
      Response.json({html_url: "https://gitea.example.com/o/r/releases/tag/v1.2.3"}, {status: 201}),
    );
    await createForgeRelease(giteaInfo, "v1.2.3", "notes", ["tok"]);

    const calls = getCalls(mock);
    const methods = calls.map(([, init]) => init?.method ?? "GET");
    expect(methods).toEqual(["POST", "GET", "DELETE", "POST"]);
    const deleteCall = calls.find(([, init]) => init?.method === "DELETE")!;
    expect(deleteCall[0]).toEqual("https://gitea.example.com/api/v1/repos/o/r/releases/35141");
  });

  serialTest("createForgeRelease cleans up draft on github 422 then retries", async () => {
    const mock = mockForgeConflictThenSuccess(
      422,
      [{id: 99, tag_name: "v1.0.0", draft: true}],
      Response.json({html_url: "https://github.com/o/r/releases/tag/v1.0.0"}, {status: 201}),
    );
    await createForgeRelease(githubInfo, "v1.0.0", "body", ["tok"]);

    const calls = getCalls(mock);
    const deleteCall = calls.find(([, init]) => init?.method === "DELETE")!;
    expect(deleteCall[0]).toEqual("https://api.github.com/repos/o/r/releases/99");
    expect(authOf(deleteCall[1])).toEqual("Bearer tok");
  });

  serialTest("createForgeRelease propagates conflict when no matching draft to clean up", async () => {
    const mock = vi.fn((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return Promise.resolve(new Response("Release is has no Tag", {status: 409, statusText: "Conflict"}));
      if (method === "GET") return Promise.resolve(Response.json([{id: 1, tag_name: "other-tag", draft: true}], {status: 200}));
      throw new Error(`unexpected method ${method}`);
    });
    stubGlobal("fetch", mock);
    await expect(createForgeRelease(giteaInfo, "v1.0.0", "body", ["tok"])).rejects.toThrow("409");
    const methods = getCalls(mock).map(([, init]) => init?.method ?? "GET");
    expect(methods).toEqual(["POST", "GET"]);
  });

  serialTest("createForgeRelease cleans up multiple matching drafts", async () => {
    const mock = mockForgeConflictThenSuccess(
      409,
      [
        {id: 10, tag_name: "v1.0.0", draft: true},
        {id: 11, tag_name: "v1.0.0", draft: true},
      ],
      Response.json({html_url: "https://gitea.example.com/o/r/releases/tag/v1.0.0"}, {status: 201}),
    );
    await createForgeRelease(giteaInfo, "v1.0.0", "body", ["tok"]);

    const deleteCalls = getCalls(mock).filter(([, init]) => init?.method === "DELETE");
    expect(deleteCalls).toHaveLength(2);
  });

  serialTest("createForgeRelease tolerates 404 on draft delete (already gone)", async () => {
    let postCount = 0;
    const mock = vi.fn((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        postCount += 1;
        if (postCount === 1) return Promise.resolve(new Response("conflict", {status: 409, statusText: "Conflict"}));
        return Promise.resolve(Response.json({}, {status: 201}));
      }
      if (method === "GET") return Promise.resolve(Response.json([{id: 5, tag_name: "v1.0.0", draft: true}], {status: 200}));
      if (method === "DELETE") return Promise.resolve(new Response("not found", {status: 404}));
      throw new Error(`unexpected method ${method}`);
    });
    stubGlobal("fetch", mock);
    await createForgeRelease(githubInfo, "v1.0.0", "body", ["tok"]);
    const methods = getCalls(mock).map(([, init]) => init?.method ?? "GET");
    expect(methods).toEqual(["POST", "GET", "DELETE", "POST"]);
  });

  serialTest("createForgeRelease throws if draft delete fails non-404", async () => {
    stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return Promise.resolve(new Response("conflict", {status: 409, statusText: "Conflict"}));
      if (method === "GET") return Promise.resolve(Response.json([{id: 5, tag_name: "v1.0.0", draft: true}], {status: 200}));
      if (method === "DELETE") return Promise.resolve(new Response("server error", {status: 500, statusText: "Internal Server Error"}));
      throw new Error(`unexpected method ${method}`);
    }));
    await expect(createForgeRelease(githubInfo, "v1.0.0", "body", ["tok"])).rejects.toThrow("Failed to delete draft release 5");
  });

  serialTest("pingForge gates on push permission, except on the all-false set of installation tokens", async () => {
    mockForgePost(Response.json({permissions: {push: false, admin: false, pull: true}}, {status: 200}));
    expect(await pingForge(githubInfo, ["tok"])).toEqual("token lacks push permission on o/r");
    mockForgePost(Response.json({permissions: {push: false, admin: false, pull: false}}, {status: 200}));
    expect(await pingForge(githubInfo, ["tok"])).toBeNull();
  });

  serialTest("pingForge names a disabled gitea releases unit, except for repo admins who bypass it", async () => {
    mockForgePost(Response.json({has_releases: false, permissions: {push: true, admin: false}}, {status: 200}));
    expect(await pingForge(giteaInfo, ["tok"])).toEqual("the Releases unit is disabled on o/r; enable it in the repository settings");
    mockForgePost(Response.json({has_releases: false, permissions: {push: true, admin: true}}, {status: 200}));
    expect(await pingForge(giteaInfo, ["tok"])).toBeNull();
  });
});

test("release rejects detached HEAD", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  const {opts} = await setupReleaseRepo(tmpDir);
  await exec("git", ["checkout", "--detach"], opts);

  const err = await runFail(["--release", "patch", "package.json"], {
    ...opts, env: {...opts.env, VERSIONS_FORGE_TOKENS: "gitea.invalid:tok"},
  });
  expect(err.exitCode).toEqual(1);
}));

test.each(["--gitless", "--no-push"])("%s and --release are mutually exclusive", async (flag) => {
  const err = await runFail([flag, "--release", "--base", "1.0.0", "patch"]);
  expect(err.exitCode).toEqual(1);
  expect(err.output).toContain(`${flag} and --release are mutually exclusive`);
});

test("validate aborts before any mutation", () => withTmpDir(async (tmpDir) => {
  const pkgContent = pkgJson("1.0.0");
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  const tokenOpts = {...opts, env: {...opts.env, VERSIONS_FORGE_TOKENS: "gitea.invalid:fake-token"}};
  const {stdout: preHead} = await exec("git", ["rev-parse", "HEAD"], opts);

  const expectUntouched = async () => {
    expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
    expect((await exec("git", ["rev-parse", "HEAD"], opts)).stdout).toEqual(preHead);
    expect((await exec("git", ["tag", "--list"], opts)).stdout).not.toContain("1.0.1");
    expect((await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts)).stdout.trim()).toEqual("");
    expect((await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir})).stdout).toEqual(preHead);
  };

  expect((await runFail(["--release", "patch", "package.json"], tokenOpts)).output).toContain("--release: forge ping");
  await expectUntouched();

  await exec("git", ["tag", "1.0.1", preHead.trim()], {cwd: bareDir});
  expect((await runFail(["patch", "package.json"], opts)).output).toContain("tag 1.0.1 already exists on remote origin");
  await expectUntouched();
}));

test("rollback - push failure restores commit, prior annotated tag, and the user's index", () => withTmpDir(async (tmpDir) => {
  const pkgContent = pkgJson("1.0.0");
  await writeFile(join(tmpDir, "package.json"), pkgContent);
  await writeFile(join(tmpDir, "tracked.txt"), "base\n");

  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  // server-side rejection: validate passes and the push itself fails, so EXECUTE has to roll back
  await writeFile(join(bareDir, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {mode: 0o755});

  // --base pins the bump at the pre-existing ANNOTATED tag, which rollback must restore, not delete
  await exec("git", ["tag", "-a", "1.0.1", "-m", "annotated"], opts);
  // index between HEAD and worktree: a bare --soft reset would leave the bump staged on top
  await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged hunk\n");
  await exec("git", ["add", "tracked.txt"], opts);
  await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged hunk\nworktree only\n");
  await writeFile(join(tmpDir, "new.txt"), "new content\n");
  await exec("git", ["add", "new.txt"], opts);

  const {stdout: preHead} = await exec("git", ["rev-parse", "HEAD"], opts);
  const {stdout: preTag} = await exec("git", ["rev-parse", "refs/tags/1.0.1"], opts);
  const {stdout: preStatus} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts);
  const {stdout: preStaged} = await exec("git", ["diff", "--cached"], opts);
  const preTracked = await readFile(join(tmpDir, "tracked.txt"), "utf8");

  expect((await runFail(["--base", "1.0.0", "patch", "package.json"], opts)).output).toContain("pre-receive hook declined");

  expect((await exec("git", ["rev-parse", "HEAD"], opts)).stdout).toEqual(preHead);
  expect((await exec("git", ["rev-parse", "refs/tags/1.0.1"], opts)).stdout).toEqual(preTag);
  expect((await exec("git", ["cat-file", "-t", "refs/tags/1.0.1"], opts)).stdout.trim()).toEqual("tag");
  expect((await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts)).stdout).toEqual(preStatus);
  expect((await exec("git", ["diff", "--cached"], opts)).stdout).toEqual(preStaged);
  expect(await readFile(join(tmpDir, "tracked.txt"), "utf8")).toEqual(preTracked);
  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
}));

test("validate - aborts when remote branch has advanced beyond local", () => withTmpDir(async (tmpDir) => {
  // remote master advanced invisibly, so a bump pushed the tag while the branch push was rejected
  const pkgContent = pkgJson("1.0.0");
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const {bareDir, opts} = await setupReleaseRepo(tmpDir);

  // advance origin/master without updating the local tracking ref
  await writeFile(join(tmpDir, "other.txt"), "remote work");
  await exec("git", ["add", "other.txt"], opts);
  await exec("git", ["commit", "-m", "remote work"], opts);
  await exec("git", ["push", "origin", "master"], opts);
  await exec("git", ["reset", "--hard", "HEAD^"], opts);
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const {stdout: preLocalHead} = await exec("git", ["rev-parse", "HEAD"], opts);
  const {stdout: preRemoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  const {stdout: preTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});

  const err = await runFail(["patch", "package.json"], opts);
  expect(err.exitCode).toEqual(1);
  expect(err.output).toMatch(/not a descendant/);

  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
  const {stdout: postLocalHead} = await exec("git", ["rev-parse", "HEAD"], opts);
  expect(postLocalHead).toEqual(preLocalHead);
  const {stdout: localTags} = await exec("git", ["tag", "--list"], opts);
  expect(localTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
  const {stdout: postRemoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  expect(postRemoteHead).toEqual(preRemoteHead);
  const {stdout: postTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(postTags).toEqual(preTags);
}));

test("rollback - -c failure restores file writes (gitless)", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await runFail(["--gitless", "--base", "1.0.0", "-c", "exit 1", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.0");
}));

test("rollback - -c failure restores multiple file writes", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "a.txt"), "v 1.0.0 a");
  await writeFile(join(tmpDir, "b.txt"), "v 1.0.0 b");

  await runFail(["--gitless", "--base", "1.0.0", "-c", "exit 1", "patch", "a.txt", "b.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "a.txt"), "utf8")).toEqual("v 1.0.0 a");
  expect(await readFile(join(tmpDir, "b.txt"), "utf8")).toEqual("v 1.0.0 b");
}));

test("rollback - -c failure leaves no commit or tag in git mode", () => withTmpDir(async (tmpDir) => {
  const pkgContent = pkgJson("1.0.0");
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const opts = await initGitRepo(tmpDir);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "Initial commit"], opts);
  await exec("git", ["tag", "1.0.0"], opts);

  const {stdout: preHead} = await exec("git", ["rev-parse", "HEAD"], opts);

  await runFail(["--no-push", "-c", "exit 1", "patch", "package.json"], opts);

  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
  const {stdout: tags} = await exec("git", ["tag", "--list"], opts);
  expect(tags.trim().split("\n").filter(Boolean)).toEqual(["1.0.0"]);
  const {stdout: postHead} = await exec("git", ["rev-parse", "HEAD"], opts);
  expect(postHead.trim()).toEqual(preHead.trim());
}));

test("default push - pushes commit and tag without --release", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));

  const {bareDir, opts} = await setupReleaseRepo(tmpDir);

  await exec("node", [distPath, "patch", "package.json"], opts);

  const {stdout: localHead} = await exec("git", ["rev-parse", "HEAD"], opts);
  const {stdout: remoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  expect(remoteHead.trim()).toEqual(localHead.trim());
  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).toContain("1.0.1");
}));

test("--no-push skips push", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));

  const {bareDir, opts} = await setupReleaseRepo(tmpDir);

  const {stdout: remoteHeadBefore} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);

  const {stdout: remoteHeadAfter} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  expect(remoteHeadAfter.trim()).toEqual(remoteHeadBefore.trim());
  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
}));

test("--remote pushes to custom remote", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));

  const opts = await initGitRepo(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "Initial commit"], opts);
  await exec("git", ["remote", "add", "upstream", bareDir], opts);
  await exec("git", ["push", "upstream", "master"], opts);
  await exec("git", ["tag", "1.0.0"], opts);

  await exec("node", [distPath, "--remote", "upstream", "patch", "package.json"], opts);

  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).toContain("1.0.1");
}));

test("--remote with --release uses that remote for forge detection", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));

  const opts = await initGitRepo(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "Initial commit"], opts);
  // origin has no forge URL, upstream points at a gitea host — release must follow --remote
  await exec("git", ["remote", "add", "origin", "file:///nowhere"], opts);
  await exec("git", ["remote", "add", "upstream", "https://gitea.invalid/owner/repo.git"], opts);
  await exec("git", ["remote", "set-url", "--push", "upstream", bareDir], opts);
  await exec("git", ["push", "upstream", "master"], opts);
  await exec("git", ["tag", "1.0.0"], opts);

  const err = await runFail(["--remote", "upstream", "--release", "patch", "package.json"], {
    ...opts, env: {...opts.env, VERSIONS_FORGE_TOKENS: "gitea.invalid:fake-token"},
  });
  expect(err.exitCode).toEqual(1);
  // gitea.invalid in the output proves upstream's URL was used, a null repoInfo would say "could not detect a forge"
  expect(err.output).toContain("gitea.invalid");
  expect(err.output).not.toContain("could not detect a forge");
}));

test("--branch pushes specified branch", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));

  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  await exec("git", ["checkout", "-b", "release"], opts);

  await exec("node", [distPath, "--branch", "release", "patch", "package.json"], opts);

  const {stdout: remoteBranches} = await exec("git", ["branch", "--list"], {cwd: bareDir});
  expect(remoteBranches).toContain("release");
}));

test("incrementSemver prerelease", () => {
  expect(incrementSemver("1.0.0", "prerelease", "alpha")).toEqual("1.0.1-alpha.0");
  expect(incrementSemver("1.0.1-beta.0", "prerelease", "beta")).toEqual("1.0.1-beta.1");
  expect(incrementSemver("2.0.0-alpha.5", "prerelease", "rc")).toEqual("2.0.0-rc.0");
  expect(incrementSemver("1.2.3-rc.1.2", "prerelease", "rc")).toEqual("1.2.3-rc.1.3");
  expect(incrementSemver("1.2.3-alpha.beta.0", "prerelease", "alpha")).toEqual("1.2.3-alpha.beta.1");
  expect(incrementSemver("1.2.3-alphax.1", "prerelease", "alpha")).toEqual("1.2.3-alpha.0");
  expect(incrementSemver("1.0.0", "patch", "alpha")).toEqual("1.0.1-alpha.0");
  expect(incrementSemver("1.0.0", "minor", "beta")).toEqual("1.1.0-beta.0");
  expect(incrementSemver("1.0.0", "major", "rc")).toEqual("2.0.0-rc.0");
  expect(() => incrementSemver("1.0.0", "prerelease")).toThrow("prerelease requires --preid option");
  expect(() => incrementSemver("invalid", "patch")).toThrow("Invalid semver");
});

test("replaceTokens", () => {
  expect(replaceTokens("version _VER_", "2.3.4")).toEqual("version 2.3.4");
  expect(replaceTokens("v_MAJOR_._MINOR_._PATCH_", "2.3.4")).toEqual("v2.3.4");
  expect(replaceTokens("_VER_ _MAJOR_ _MINOR_ _PATCH_", "10.20.30")).toEqual("10.20.30 10 20 30");
  expect(replaceTokens("no tokens", "1.0.0")).toEqual("no tokens");
  // the prerelease and build parts belong to _VER_ alone, never to _PATCH_
  expect(replaceTokens("_VER_ _MAJOR_ _MINOR_ _PATCH_", "1.2.3-alpha.0")).toEqual("1.2.3-alpha.0 1 2 3");
  expect(replaceTokens("_PATCH_", "1.2.3+build.5")).toEqual("3");
});

test("esc", () => {
  expect(esc("1.0.0")).toEqual("1\\.0\\.0");
  expect(esc("a|b")).toEqual("a\\|b");
  expect(esc("abc")).toEqual("abc");
  expect(esc("")).toEqual("");
});

test("joinStrings", () => {
  expect(joinStrings(["a", "b", "c"], "\n")).toEqual("a\nb\nc");
  expect(joinStrings(["a", undefined, "c"], "\n")).toEqual("a\nc");
  expect(joinStrings([undefined, undefined], "\n")).toEqual("");
  expect(joinStrings(["  a  "], "\n")).toEqual("a");
});

test("findUp", () => withTmpDir(async (tmpDir) => {
  const subDir = join(tmpDir, "a", "b");
  await mkdir(subDir, {recursive: true});
  await writeFile(join(tmpDir, "target.txt"), "found");
  expect(findUp("target.txt", subDir)).toEqual(join(tmpDir, "target.txt"));
  expect(findUp("nonexistent.txt", subDir, tmpDir)).toBeNull();
}));

// no level hits the first operand of `!level || args.help`, `patch --help` the second
test.each([[[]], [["patch", "--help"]]])("prints help for %j", async (args) => {
  const {stdout} = await exec("node", [distPath, ...args]);
  expect(stdout).toContain("usage: versions");
  expect(stdout).toContain("--replace");
});

test("dry mode", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");
  const opts = await initGitRepo(tmpDir);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "init"], opts);

  const {stdout} = await exec("node", [distPath, "--dry", "patch", "testfile.txt"], opts);
  expect(stdout).toContain("Would update testfile.txt");
  expect(stdout).toContain("Would create new tag and commit: 1.0.1");
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.0");
  const {stdout: status} = await exec("git", ["status", "--porcelain"], opts);
  expect(status.trim()).toEqual("");

  // --gitless creates neither, so promising them would be a lie
  const {stdout: gitless} = await exec("node", [distPath, "--dry", "--gitless", "patch", "testfile.txt"], opts);
  expect(gitless).toContain("Would update testfile.txt");
  expect(gitless).not.toContain("Would create");
}));

test("--all no longer exempts named files that produce no diff", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "notes.txt"), "no version in here");
  const {opts} = await setupReleaseRepo(tmpDir);

  const err = await runFail(["--no-push", "--all", "--base", "1.0.0", "patch", "notes.txt"], opts);
  expect(err.output).toContain("would not change any of the specified files");
}));

// a tag-only release, the flow used by repos whose version lives solely in the git tag
test("no files still commits and tags", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "README.md"), "docs"); // the initial commit needs a file
  const {opts} = await setupReleaseRepo(tmpDir); // tags 1.0.0

  await exec("node", [distPath, "--no-push", "patch"], opts);

  const {stdout: tags} = await exec("git", ["tag", "--list"], opts);
  expect(tags.trim().split("\n").filter(Boolean)).toContain("1.0.1");
  const {stdout: log} = await exec("git", ["log", "--oneline"], opts);
  expect(log.trim().split("\n")).toHaveLength(2);
}));

test("prefix", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");
  const opts = await initGitRepo(tmpDir);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "init"], opts);

  const {stdout} = await exec("node", [distPath, "--dry", "--prefix", "patch", "testfile.txt"], opts);
  expect(stdout).toContain("Would create new tag and commit: v1.0.1");
}));

test("replace", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0\ncopyright YEAR_PLACEHOLDER\nDROPME tail");
  const base = ["--gitless", "--base", "1.0.0"];
  // an empty replacement deletes, like sed
  await exec("node", [distPath, ...base, "-r", "s#YEAR_PLACEHOLDER#_VER_#", "-r", "s#DROPME ##", "patch", "testfile.txt"], {cwd: tmpDir});
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1\ncopyright 1.0.1\ntail");

  const err = await runFail([...base, "-r", "s#a#b#q", "patch", "testfile.txt"], {cwd: tmpDir});
  expect(err.output).toContain("Invalid replace string: s#a#b#q: Invalid flags");
}));

test("command", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");
  await exec("node", [distPath, "--gitless", "--base", "1.0.0", "-c", "echo hello > marker.txt", "patch", "testfile.txt"], {cwd: tmpDir});
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1");
  expect(await readFile(join(tmpDir, "marker.txt"), "utf8")).toContain("hello");
}));

test("package-lock.json", () => withTmpDir(async (tmpDir) => {
  const lockData = {
    name: "test",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {"": {name: "test", version: "1.0.0"}, "node_modules/dep": {version: "2.0.0"}},
  };
  await writeFile(join(tmpDir, "package-lock.json"), JSON.stringify(lockData, null, 2));
  await exec("node", [distPath, "--gitless", "--base", "1.0.0", "patch", "package-lock.json"], {cwd: tmpDir});

  const result = JSON.parse(await readFile(join(tmpDir, "package-lock.json"), "utf8"));
  expect(result.version).toEqual("1.0.1");
  expect(result.packages[""].version).toEqual("1.0.1");
  expect(result.packages["node_modules/dep"].version).toEqual("2.0.0");
}));

test("a packageManager pin carries the lockfile into the commit", () => withTmpDir(async (tmpDir) => {
  const pkg = (version: string, dep: string) => `${JSON.stringify({
    name: "test-pkg", version, packageManager: "pnpm@11.18.0", devDependencies: {timerel: dep},
  }, null, 2)}\n`;
  await writeFile(join(tmpDir, "package.json"), pkg("1.0.0", "5.8.7"));
  await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\ntimerel: 5.8.7\n");

  const {opts} = await setupReleaseRepo(tmpDir);

  await writeFile(join(tmpDir, "package.json"), pkg("1.0.0", "5.8.8"));
  await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\ntimerel: 5.8.8\n");

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);

  const {stdout: committed} = await exec("git", ["show", "--name-only", "--format=", "HEAD"], opts);
  expect(committed.trim().split("\n").filter(Boolean).sort()).toEqual(["package.json", "pnpm-lock.yaml"]);
  const {stdout: status} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts);
  expect(status.trim()).toEqual("");
  expect(await readFile(join(tmpDir, "pnpm-lock.yaml"), "utf8")).toEqual("lockfileVersion: '9.0'\ntimerel: 5.8.8\n");
}));

test("a packageManager naming an Object.prototype key finds no lockfile", () => withTmpDir(async (tmpDir) => {
  const manifest = join(tmpDir, "package.json");
  await writeFile(manifest, JSON.stringify({name: "test-pkg", version: "1.0.0", packageManager: "constructor@1.0.0"}));
  expect(findCompanionLockfile(manifest)).toBeNull();
}));

test("a companion package-lock.json is bumped, not just committed", () => withTmpDir(async (tmpDir) => {
  const pkg = (dep: string) => `${JSON.stringify({
    name: "test-pkg", version: "1.0.0", packageManager: "npm@11.10.0", devDependencies: {timerel: dep},
  }, null, 2)}\n`;
  await writeFile(join(tmpDir, "package.json"), pkg("5.8.7"));
  await writeFile(join(tmpDir, "package-lock.json"), `${JSON.stringify({
    name: "test-pkg", version: "1.0.0", lockfileVersion: 3,
    packages: {"": {name: "test-pkg", version: "1.0.0"}, "node_modules/timerel": {version: "5.8.7"}},
  }, null, 2)}\n`);

  const {opts} = await setupReleaseRepo(tmpDir);

  await writeFile(join(tmpDir, "package.json"), pkg("5.8.8"));

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);

  const lock = JSON.parse(await readFile(join(tmpDir, "package-lock.json"), "utf8"));
  expect(lock.version).toEqual("1.0.1");
  expect(lock.packages[""].version).toEqual("1.0.1");
  expect(lock.packages["node_modules/timerel"].version).toEqual("5.8.7");
  const {stdout: status} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts);
  expect(status.trim()).toEqual("");
}));

test("go.sum is skipped", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "go.sum"), "content with 1.0.0");
  await exec("node", [distPath, "--gitless", "--base", "1.0.0", "patch", "go.sum"], {cwd: tmpDir});
  expect(await readFile(join(tmpDir, "go.sum"), "utf8")).toEqual("content with 1.0.0");
}));

test("arbitrary lock file is skipped", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "Gemfile.lock"), "gem 1.0.0");
  await exec("node", [distPath, "--gitless", "--base", "1.0.0", "patch", "Gemfile.lock"], {cwd: tmpDir});
  expect(await readFile(join(tmpDir, "Gemfile.lock"), "utf8")).toEqual("gem 1.0.0");
}));

test("SubprocessError", () => {
  const err = new SubprocessError("failed", "out", "err", 1);
  expect(err.message).toEqual("failed");
  expect(err.stdout).toEqual("out");
  expect(err.stderr).toEqual("err");
  expect(err.output).toEqual("err\nout");
  expect(err.name).toEqual("SubprocessError");
  expect(err.exitCode).toEqual(1);

  const errNoOutput = new SubprocessError("failed");
  expect(errNoOutput.output).toEqual("");
  expect(errNoOutput.exitCode).toBeNull();
});

test("exec error", async () => {
  await expect(exec("false", [])).rejects.toThrow();
  try {
    await exec("false", []);
  } catch (err) {
    expect(err).toBeInstanceOf(SubprocessError);
  }
});

test("tomlGetString edge cases", () => {
  expect(tomlGetString("", "project", "version")).toBeUndefined();
  expect(tomlGetString("# comment\n[project]\nversion = '1.0.0'", "project", "version")).toEqual("1.0.0");
  expect(tomlGetString("[project]\nname = 'test'", "project", "version")).toBeUndefined();
  expect(tomlGetString("[other]\nversion = '1.0.0'", "project", "version")).toBeUndefined();
  expect(tomlGetString("[project] # note\nversion = '1.0.0'", "project", "version")).toEqual("1.0.0");
  // a bracketed element of a multi-line array is not a table header
  expect(tomlGetString("[project]\nm = [\n  [1, 2],\n]\nversion = '1.0.0'", "project", "version")).toEqual("1.0.0");
});

test("incrementSemver unknown level throws", () => {
  expect(() => incrementSemver("1.0.0", "unknown")).toThrow("Invalid semver level");
});

test("--message tokens are substituted in commit and tag", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));

  const {opts} = await setupReleaseRepo(tmpDir);

  await exec("node", [distPath, "--no-push", "-m", "Release _VER_", "patch", "package.json"], opts);

  const {stdout: commitMsg} = await exec("git", ["log", "-1", "--pretty=%B"], opts);
  expect(commitMsg).toContain("Release 1.0.1");
  expect(commitMsg).not.toContain("_VER_");

  const {stdout: tagMsg} = await exec("git", ["tag", "-l", "1.0.1", "--format=%(contents)"], opts);
  expect(tagMsg).toContain("Release 1.0.1");
  expect(tagMsg.split("\n")[0]).toEqual("1.0.1");
}));

test("CHANGELOG.md drives commit body and gets dated heading", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "CHANGELOG.md"), `# Changelog\n\n## [1.0.1]\n- Fixed thing X\n- Added thing Y\n\n## 1.0.0\nold stuff\n`);

  const {opts} = await setupReleaseRepo(tmpDir);

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);

  const today = new Date().toISOString().substring(0, 10);
  const changelogAfter = await readFile(join(tmpDir, "CHANGELOG.md"), "utf8");
  expect(changelogAfter).toContain(`## [1.0.1] - ${today}`);

  const {stdout: msg} = await exec("git", ["log", "-1", "--pretty=%B"], opts);
  expect(msg).toContain("- Fixed thing X");
  expect(msg).toContain("- Added thing Y");
  // git log fallback (commit subjects) must not leak in
  expect(msg).not.toContain("Initial commit");
}));

test("CHANGELOG.md without entry falls back to git log", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "CHANGELOG.md"), `# Changelog\n\n## 1.0.0\nold\n`);

  const {opts} = await setupReleaseRepo(tmpDir);

  // commit between the tag and HEAD so the git log fallback has something to report
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0", changed: true}, null, 2));
  await exec("git", ["commit", "-am", "tweak something"], opts);

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);

  expect(await readFile(join(tmpDir, "CHANGELOG.md"), "utf8")).toEqual(`# Changelog\n\n## 1.0.0\nold\n`);

  const {stdout: msg} = await exec("git", ["log", "-1", "--pretty=%B"], opts);
  expect(msg).toContain("tweak something");
}));

test("--base still bounds the git log fallback at the last tag", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  const {opts} = await setupReleaseRepo(tmpDir); // commits "Initial commit", tags 1.0.0

  await exec("git", ["commit", "--allow-empty", "-m", "tweak something"], opts);

  await exec("node", [distPath, "--no-push", "--base=1.0.0", "patch", "package.json"], opts);

  const {stdout: msg} = await exec("git", ["log", "-1", "--pretty=%B"], opts);
  expect(msg).toContain("tweak something");
  expect(msg).not.toContain("Initial commit"); // the whole history, not the range after the tag
}));

test("a CHANGELOG.md-only bump is not read as a wrong base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "CHANGELOG.md"), `# Changelog\n\n## 1.0.1\n- entry\n\n## 1.0.0\nold\n`);

  const {opts} = await setupReleaseRepo(tmpDir);

  await exec("node", [distPath, "--no-push", "patch", "CHANGELOG.md"], opts);

  const today = new Date().toISOString().substring(0, 10);
  expect(await readFile(join(tmpDir, "CHANGELOG.md"), "utf8")).toContain(`## 1.0.1 - ${today}`);
  const {stdout: committed} = await exec("git", ["show", "--name-only", "--format=", "HEAD"], opts);
  expect(committed.trim()).toEqual("CHANGELOG.md");
}));

test("CHANGELOG.md with existing date is left alone", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  const original = `# Changelog\n\n## [1.0.1] - 2024-01-15\n- existing entry\n`;
  await writeFile(join(tmpDir, "CHANGELOG.md"), original);

  const {opts} = await setupReleaseRepo(tmpDir);

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);

  expect(await readFile(join(tmpDir, "CHANGELOG.md"), "utf8")).toEqual(original);

  const {stdout: msg} = await exec("git", ["log", "-1", "--pretty=%B"], opts);
  expect(msg).toContain("- existing entry");
}));

test("readVersionFile package.json", () => withTmpDir(async (tmpDir) => {
  expect(readVersionFile("package.json", tmpDir)).toBeNull();

  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test"}, null, 2));
  expect(readVersionFile("package.json", tmpDir)).toBeNull();

  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test", version: "3.2.1"}, null, 2));
  expect(readVersionFile("package.json", tmpDir)).toEqual("3.2.1");

  const subDir = join(tmpDir, "sub");
  await mkdir(subDir);
  expect(readVersionFile("package.json", subDir)).toEqual("3.2.1");
}));

test("readVersionFile pyproject.toml", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "pyproject.toml");

  await writeFile(file, `[project]\nname = "test"\n`);
  expect(readVersionFile("pyproject.toml", tmpDir)).toBeNull();

  await writeFile(file, `[project]\nname = "test"\nversion = "1.5.0"\n`);
  expect(readVersionFile("pyproject.toml", tmpDir)).toEqual("1.5.0");

  await writeFile(file, `[tool.poetry]\nname = "test"\nversion = "2.0.0"\n`);
  expect(readVersionFile("pyproject.toml", tmpDir)).toEqual("2.0.0");
}));

test.each([undefined, 2])("getFileChanges package.json with indent %s leaves nested version fields alone", (indent) => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "package.json");
  await writeFile(file, JSON.stringify({name: "foo", overrides: {"some-pkg": {version: "1.0.0"}}, version: "1.0.0"}, null, indent));
  const content = getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"})?.newData;
  const parsed = JSON.parse(content!);
  expect(parsed.version).toEqual("2.0.0");
  expect(parsed.overrides["some-pkg"].version).toEqual("1.0.0");
}));

test("getFileChanges package-lock.json", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "package-lock.json");
  const data = {name: "test", version: "1.0.0", lockfileVersion: 3, packages: {"": {version: "1.0.0"}}};
  await writeFile(file, JSON.stringify(data, null, 2));
  const content = getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"})?.newData;
  const result = JSON.parse(content!);
  expect(result.version).toEqual("2.0.0");
  expect(result.packages[""].version).toEqual("2.0.0");
}));

test("getFileChanges pyproject.toml", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "pyproject.toml");
  await writeFile(file, `[project]\nname = "test"\nversion = "1.0.0"\n`);
  const content = getFileChanges({file, baseVersion: "1.0.0", newVersion: "1.1.0"})?.newData;
  expect(content).toContain(`version = "1.1.0"`);
}));

test("getFileChanges pyproject.toml leaves unrelated section version alone", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "pyproject.toml");
  await writeFile(file, `[project]\nname = "test"\nversion = "1.0.0"\n\n[tool.someplugin]\nversion = "1.0.0"\n`);
  const content = getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"})?.newData;
  expect(content).toContain(`[project]\nname = "test"\nversion = "2.0.0"`);
  expect(content).toContain(`[tool.someplugin]\nversion = "1.0.0"`);
}));

test("getFileChanges uv.lock", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]\nname = "myapp"\nversion = "1.0.0"\n`);
  const file = join(tmpDir, "uv.lock");
  await writeFile(file, `[[package]]\nname = "myapp"\nversion = "1.0.0"\n`);
  const content = getFileChanges({file, baseVersion: "1.0.0", newVersion: "1.1.0"})?.newData;
  expect(content).toContain(`version = "1.1.0"`);
}));

test("getFileChanges generic file", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "version.txt");
  await writeFile(file, "version 1.0.0 here");
  const content = getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"})?.newData;
  expect(content).toEqual("version 2.0.0 here");
}));

test("getFileChanges lockfile skip", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "yarn.lock");
  await writeFile(file, "content 1.0.0");
  expect(getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"})).toBeNull();
}));

test("getFileChanges with date", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "changelog.txt");
  await writeFile(file, "version 1.0.0 released 2020-01-01");
  const content = getFileChanges({file, baseVersion: "1.0.0", newVersion: "1.0.1", date: "2025-06-15"})?.newData;
  expect(content).toEqual("version 1.0.1 released 2025-06-15");
}));

test("getFileChanges with replacements", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "file.txt");
  await writeFile(file, "version 1.0.0 FOO");
  const content = getFileChanges({
    file, baseVersion: "1.0.0", newVersion: "1.0.1",
    replacements: [{re: /FOO/, replacement: "BAR"}],
  })?.newData;
  expect(content).toEqual("version 1.0.1 BAR");
}));

test("write", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "out.txt");
  await writeFile(file, "old");
  write(file, "new");
  expect(await readFile(file, "utf8")).toEqual("new");
}));

const tokenEnvNames = [...githubTokenEnvNames, ...giteaTokenEnvNames, "VERSIONS_FORGE_TOKENS", "GITEA_URL"];

async function withTokenEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = {...process.env};
  for (const name of tokenEnvNames) delete process.env[name];
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const name of tokenEnvNames) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

const giteaHost = (host: string): RepoInfo => ({...giteaInfo, host});

// these swap token env vars in process.env, concurrent runs would delete each other's
describe("token env", {concurrent: false}, () => {
  serialTest("getForgeTokens reads GitHub env names", () => withTokenEnv({GH_TOKEN: "gh-tok"}, async () => {
    expect(await getForgeTokens(githubInfo)).toContain("gh-tok");
  }));

  serialTest("getForgeTokens sends Gitea env tokens only to the GITEA_URL host", () => withTokenEnv({
    GITEA_TOKEN: "gitea-tok", GITEA_URL: "https://gitea.example.com",
  }, async () => {
    expect(await getForgeTokens(giteaHost("gitea.example.com"))).toEqual(["gitea-tok"]);
    expect(await getForgeTokens(giteaHost("other.example.com"))).toEqual([]);
  }));

  serialTest("getForgeTokens matches a VERSIONS_FORGE_TOKENS host carrying a port", () => withTokenEnv({
    VERSIONS_FORGE_TOKENS: "localhost:3500:pair-tok", GITEA_TOKEN: "gitea-tok", GITEA_URL: "https://localhost:3500",
  }, async () => {
    expect(await getForgeTokens(giteaHost("localhost:3500"))).toEqual(["pair-tok"]);
    // the bare host must not claim the ported entry, which would hand back `3500:pair-tok`
    expect(await getForgeTokens(giteaHost("localhost"))).toEqual([]);
  }));

  // mirrors what actions/checkout writes, includeIf and all, so a regression to `git config --local` fails here
  serialTest("getForgeTokens recovers the CI token from the git config extraheader", () => withTmpDir(async (tmpDir) => {
    await exec("git", ["init", "-q"], {cwd: tmpDir});
    const globalConfig = join(tmpDir, "global.config");
    const basic = Buffer.from("x-access-token:ci-tok").toString("base64");
    await exec("git", ["config", "--file", globalConfig, "http.https://ci.example.com/.extraheader", `AUTHORIZATION: basic ${basic}`], {cwd: tmpDir});

    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      await withTokenEnv({}, async () => {
        expect(await getForgeTokens(giteaHost("ci.example.com"), tmpDir)).toEqual(["ci-tok"]);
        expect(await getForgeTokens(giteaHost("elsewhere.example.com"), tmpDir)).toEqual([]);
      });
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
  }));
});

test("getRepoInfo", async () => {
  const info = await getRepoInfo();
  expect(info).toBeTruthy();
  expect(info!.type).toEqual("github");
  expect(info!.owner).toBeTruthy();
  expect(info!.repo).toBeTruthy();
  expect(info!.host).toEqual("github.com");
});

test("getRepoInfo returns null without git", () => withTmpDir(async (tmpDir) => {
  expect(await getRepoInfo(tmpDir)).toBeNull();
}));

test("removeIgnoredFiles", () => withTmpDir(async (tmpDir) => {
  const opts = await initGitRepo(tmpDir);
  await writeFile(join(tmpDir, ".gitignore"), "ignored.txt\n");
  await writeFile(join(tmpDir, "kept.txt"), "");
  await writeFile(join(tmpDir, "ignored.txt"), "");
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "init"], opts);

  const result = await removeIgnoredFiles(["kept.txt", "ignored.txt"], tmpDir);
  expect(result).toEqual(["kept.txt"]);
}));

test("writeResult", () => {
  let output = "";
  const origWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => { output += chunk; return true; }) as any;
  try {
    writeResult({stdout: "hello", stderr: "warn"});
    expect(output).toContain("hello");
    expect(output).toContain("warn");
  } finally {
    process.stdout.write = origWrite;
  }
});
