import {Buffer} from "node:buffer";
import {readFileSync} from "node:fs";
import {cp, readFile, writeFile, rm, mkdir, mkdtemp, stat} from "node:fs/promises";
import {createServer} from "node:https";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {text} from "node:stream/consumers";
import {fileURLToPath} from "node:url";
import {
  isSemver, incrementSemver, replaceTokens, esc, findUp, getFileChanges, write, findCompanionLockfile, readVersionFile,
  removeIgnoredFiles, getForgeTokens, githubTokenEnvNames, giteaTokenEnvNames, getRepoInfo, writeResult,
  createForgeRelease, pingForge, verifyToken, processChangelog, type RepoInfo,
} from "./api.ts";
import {removeToken, storeToken} from "./tokens.ts";
import {exec, tomlGetString, SubprocessError} from "./utils.ts";
import pkg from "./package.json" with {type: "json"};
import type {AddressInfo} from "node:net";

const distPath = join(process.cwd(), "dist/index.js");
const pkgJson = (version: string) => JSON.stringify({name: "test-pkg", version}, null, 2);
const pep621 = (version: string) => `[project]\nname = "test-project"\nversion = "${version}"\n`;
const tokenEnvNames = [...githubTokenEnvNames, ...giteaTokenEnvNames, "VERSIONS_FORGE_TOKENS", "GITEA_URL"];

const stubbedGlobals = new Map<string, unknown>();
const savedConfigHome = process.env.XDG_CONFIG_HOME;
let testConfigHome: string;
function stubGlobal(name: string, value: unknown) {
  if (typeof vi.stubGlobal === "function") {
    vi.stubGlobal(name, value);
  } else {
    if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, (globalThis as any)[name]);
    (globalThis as any)[name] = value;
  }
}

const serialTest: typeof test = (test as any).serial ?? test;

beforeAll(async () => {
  testConfigHome = await mkdtemp(join(tmpdir(), "versions-config-test-"));
  process.env.XDG_CONFIG_HOME = testConfigHome;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterAll(async () => {
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
  await rm(testConfigHome, {recursive: true, force: true});
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
  await exec("git", ["init", "--bare", "-q", bareDir], {env: {...process.env, ...getIsolatedGitEnv(tmpDir)}});
  return bareDir;
}

function getIsolatedGitEnv(tmpDir: string) {
  const isolatedHome = join(tmpDir, ".home");
  return {
    HOME: isolatedHome, GIT_CONFIG_GLOBAL: join(isolatedHome, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@test.com",
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

async function setupTaggedRepo(tmpDir: string) {
  const opts = await initGitRepo(tmpDir);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "Initial commit"], opts);
  await exec("git", ["tag", "1.0.0"], opts);
  return opts;
}

async function setupReleaseRepo(tmpDir: string) {
  const opts = await setupTaggedRepo(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["remote", "add", "origin", "https://gitea.invalid/o/r.git"], opts);
  await exec("git", ["remote", "set-url", "--push", "origin", bareDir], opts);
  await exec("git", ["push", "origin", "master"], opts);
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
  expect((await exec("node", [distPath, "-v"])).stdout).toEqual(pkg.version);
});

test("semver", () => {
  expect(isSemver("1.0.0")).toEqual(true);
  expect(isSemver("1.0.0-pre-1.0.0")).toEqual(true);
  expect(isSemver("1.2.3-0123")).toEqual(false);
  for (const base of ["10.10.10", "10.10.10-pre-1.0.0"]) {
    expect(["patch", "minor", "major"].map(level => incrementSemver(base, level))).toEqual(["10.10.11", "10.11.0", "11.0.0"]);
  }
});

test("--date --gitless bumps each level, and a file passed twice only once", () => withTmpDir(async (tmpDir) => {
  const today = new Date().toISOString().substring(0, 10);
  let {version} = pkg;
  await writeFile(join(tmpDir, "testfile"), `testfile v${version} (1999-01-01)`);
  for (const [level, ...repeated] of [["patch"], ["minor"], ["major"], ["major", "testfile"]]) {
    await exec("node", [distPath, "--date", "--base", version, "--gitless", level, "testfile", ...repeated], {cwd: tmpDir});
    version = incrementSemver(version, level);
    expect(await readFile(join(tmpDir, "testfile"), "utf8")).toEqual(`testfile v${version} (${today})`);
  }
}));

test("poetry and uv bump the project version but not a same-versioned poetry dependency", () => withTmpDir(async (tmpDir) => {
  await cp(new URL("fixtures", import.meta.url), tmpDir, {recursive: true});
  const files = ["poetry/pyproject.toml", "uv/pyproject.toml", "uv/uv.lock"];
  await exec("node", [distPath, "minor", "--gitless", "--date", "--base", "1.0.2", ...files], {cwd: tmpDir});
  const [poetry, uv, uvLock] = await Promise.all(files.map(file => readFile(join(tmpDir, file), "utf8")));
  expect(tomlGetString(poetry, "tool.poetry", "version")).toEqual("1.1.0");
  expect(tomlGetString(poetry, "tool.poetry.dependencies", "flask")).toEqual("1.0.2");
  expect(tomlGetString(uv, "project", "version")).toEqual("1.1.0");
  expect(uvLock).toContain(`[[package]]\nname = "uvapp"\nversion = "1.1.0"`);
}));

test.each([
  {from: "poetry-style pyproject.toml", files: {"pyproject.toml": `[tool.poetry]\nname = "poetry-test"\nversion = "0.5.2"\n`}, level: "patch", before: "0.5.2", after: "0.5.3"},
  {from: "package.json over pyproject.toml", files: {"package.json": pkgJson("1.0.0"), "pyproject.toml": pep621("2.0.0")}, level: "patch", before: "1.0.0", after: "1.0.1"},
  {from: "pyproject.toml when package.json has invalid semver", files: {"package.json": pkgJson("invalid"), "pyproject.toml": pep621("3.0.0")}, level: "minor", before: "3.0.0", after: "3.1.0"},
])("base version with no git tags comes from $from", ({files, level, before, after}) => withTmpDir(async (tmpDir) => {
  for (const [name, content] of Object.entries(files)) await writeFile(join(tmpDir, name), content);
  await writeFile(join(tmpDir, "testfile.txt"), `version ${before}`);
  await exec("node", [distPath, "--gitless", level, "testfile.txt"], {cwd: tmpDir});
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual(`version ${after}`);
}));

test("version files are looked up to the repo root but not above it", () => withTmpDir(async (tmpDir) => {
  const repoDir = join(tmpDir, "repo");
  const subDir = join(repoDir, "sub");
  await mkdir(subDir, {recursive: true});
  await writeFile(join(tmpDir, "package.json"), pkgJson("42.0.0"));
  await initGitRepo(repoDir);
  const {stderr} = await exec("node", [distPath, "-D", "-V", "patch"], {cwd: subDir});
  expect(stderr).toContain("base version 0.0.0 from default");
  expect(stderr).not.toContain("42.0.0");
  await writeFile(join(repoDir, "package.json"), pkgJson("5.0.0"));
  expect((await exec("node", [distPath, "-D", "-V", "patch"], {cwd: subDir})).stderr).toContain("base version 5.0.0 from package.json");
}));

test("base version is the highest same-second tag on the described commit", () => withTmpDir(async (tmpDir) => {
  const opts = await initGitRepo(tmpDir);
  await exec("git", ["commit", "--allow-empty", "-m", "Initial commit"], opts);
  for (const tag of ["1.0.0", "1.0.1-rc.0", "1.1.0"]) {
    await exec("git", ["tag", "-a", tag, "-m", tag], {...opts, env: {...opts.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"}});
  }
  expect((await exec("node", [distPath, "-D", "-V", "patch"], opts)).stderr).toContain("base version 1.1.0 from git describe");
  await exec("git", ["commit", "--allow-empty", "-m", "Later commit"], opts);
  expect((await exec("node", [distPath, "-D", "-V", "patch"], opts)).stderr).toContain("base version 1.1.0 from git describe");
}));

test("warns only when a manifest disagrees with a detected base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("9.9.9"));
  const opts = await setupTaggedRepo(tmpDir);
  expect((await exec("node", [distPath, "-D", "patch", "package.json"], opts)).stderr)
    .toContain("warning: package.json declares 9.9.9 but the base version is 1.0.0");
  expect((await exec("node", [distPath, "-D", "--base=7.0.0", "patch", "package.json"], opts)).stderr).not.toContain("warning:");
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  expect((await exec("node", [distPath, "-D", "patch", "package.json"], opts)).stderr).not.toContain("warning:");
}));

test("--base rejects an empty value and bumps manifests declaring another version", () => withTmpDir(async (tmpDir) => {
  const files = {"package.json": pkgJson("1.0.0"), "pyproject.toml": pep621("2.0.0")};
  for (const [name, content] of Object.entries(files)) await writeFile(join(tmpDir, name), content);
  expect((await runFail(["--gitless", "--base=", "patch", "package.json"], {cwd: tmpDir})).output).toContain("Invalid base version");
  await exec("node", [distPath, "--gitless", "--base", "8.16.3", "patch", ...Object.keys(files)], {cwd: tmpDir});
  expect(JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8")).version).toEqual("8.16.4");
  expect(tomlGetString(await readFile(join(tmpDir, "pyproject.toml"), "utf8"), "project", "version")).toEqual("8.16.4");
}));

test("--preid turns patch into a prerelease replacing any old one, and prerelease requires it", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");
  expect((await runFail(["--gitless", "prerelease", "testfile.txt"], {cwd: tmpDir})).output)
    .toContain("prerelease requires --preid option");
  for (const [preid, expected] of [["alpha", "1.0.1-alpha.0"], ["beta", "1.0.2-beta.0"]]) {
    await exec("node", [distPath, "--gitless", `--preid=${preid}`, "patch", "package.json", "testfile.txt"], {cwd: tmpDir});
    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual(`version ${expected}`);
  }
}));

test("processChangelog", () => {
  const today = "2026-04-30";
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

[unreleased]: https://example.com/compare/v1.2.1...HEAD
[1.2.1]: https://example.com/compare/v1.2.0...v1.2.1
`;
  expect(processChangelog(md, "1.2.3", today)).toEqual({entry: "### Added\n- new thing\n\n### Fixed\n- broken thing", updated: null});
  expect(processChangelog(md, "v1.2.3", today)).toEqual(processChangelog(md, "1.2.3", today));
  expect(processChangelog(md, "1.2.2", today)).toEqual({entry: "- prior", updated: null});
  expect(processChangelog(md, "1.2.1", today)).toEqual({entry: "old", updated: md.replace("## v1.2.1", "## v1.2.1 - 2026-04-30")});
  expect(processChangelog("## 1.2.3\r\n\r\nbody\r\n", "1.2.3", today))
    .toEqual({entry: "body", updated: "## 1.2.3 - 2026-04-30\r\n\r\nbody\r\n"});
  for (const placeholder of ["YYYY-MM-DD", "yyyy-mm-dd", "xxxx-xx-xx", "XXXX-XX-XX", "DD-MM-YYYY", "????-??-??"]) {
    expect(processChangelog(`## [1.2.3] (${placeholder})\n\nbody\n`, "1.2.3", today))
      .toEqual({entry: "body", updated: "## [1.2.3] (2026-04-30)\n\nbody\n"});
  }
  expect(processChangelog("## 1.0.0\n\n[pr]: https://e.com/1\n\n- see [pr]\n\n[1.0.0]: https://e.com/c\n", "1.0.0", today)!.entry)
    .toEqual("[pr]: https://e.com/1\n\n- see [pr]");
  expect(processChangelog("# 1.0.0\n\nbody\n", "1.0.0", today)!.entry).toEqual("body");
  const fenced = "```sh\n# install\nnpm i\n```\n~~~\n## 0.9.0\n~~~";
  expect(processChangelog(`\`\`\`md\n## 1.0.0\n\`\`\`\n## 1.0.0\n${fenced}\n## 0.9.0\nold\n`, "1.0.0", today)!.entry).toEqual(fenced);
  expect(processChangelog("## 1.0.0-rc.1\n\nrc\n## 1.0.0\n\nrelease\n", "1.0.0", today)!.entry).toEqual("release");
  expect(processChangelog("## 1.0.0\n\nrelease\n## 1.0.0-rc.1\n\nrc\n", "1.0.0-rc.1", today)!.entry).toEqual("rc");
  expect(processChangelog(md, "9.9.9", today)).toBeNull();
  expect(processChangelog("## 1.0.0\n\n[1.0.0]: https://e.com/c\n", "1.0.0", today)).toBeNull();
  expect(processChangelog("# 1.0.10\n\nbody\n", "1.0.1", today)).toBeNull();
  expect(processChangelog("## 1.0.0\n## 1.0.1\nb\n", "1.0.0", today)).toBeNull();
  expect(processChangelog("", "1.0.0", today)).toBeNull();
});

function getCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
}

function authOf(init: RequestInit | undefined) {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

function mockFetch(respond: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(respond(url, init)));
  stubGlobal("fetch", mock);
  return mock;
}

function mockForgeConflict(conflictStatus: number, drafts: Array<{id: number; tag_name: string; draft: boolean}>, deleteStatus = 204) {
  let posts = 0;
  return mockFetch((_url, init) => {
    if (init?.method === "DELETE") return new Response(null, {status: deleteStatus});
    if (init?.method === "GET") return Response.json(drafts);
    return posts++ === 0 ? new Response(null, {status: conflictStatus}) : Response.json({}, {status: 201});
  });
}

const githubInfo: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
const giteaInfo: RepoInfo = {owner: "o", repo: "r", host: "gitea.example.com", type: "gitea"};

describe("forge requests", {concurrent: false}, () => {
  serialTest("createForgeRelease flags a hyphenated tag as prerelease", async () => {
    const mock = mockFetch(() => Response.json({}, {status: 201}));
    await createForgeRelease(giteaInfo, "1.0.1-beta.1", "changelog", ["tok"]);
    expect(JSON.parse(getCalls(mock)[0][1]!.body as string).prerelease).toEqual(true);
  });

  serialTest.each([
    [409, 404, giteaInfo, "https://gitea.example.com/api/v1/repos/o/r/releases", "token tok"],
    [422, 204, githubInfo, "https://api.github.com/repos/o/r/releases", "Bearer tok"],
  ])("createForgeRelease cleans up only matching drafts on a %i conflict, accepting a %i delete, then retries", async (conflict, deleteStatus, info, url, auth) => {
    const mock = mockForgeConflict(conflict, [
      {id: 1, tag_name: "v1.0.0", draft: true},
      {id: 2, tag_name: "v1.0.1", draft: true},
      {id: 3, tag_name: "v1.0.0", draft: false},
      {id: 4, tag_name: "v1.0.0", draft: true},
    ], deleteStatus);
    await createForgeRelease(info, "v1.0.0", "body", ["tok"]);
    expect(getCalls(mock).map(([callUrl, init]) => [init?.method, callUrl, authOf(init)])).toEqual([
      ["POST", url, auth],
      ["GET", `${url}?draft=true&limit=50&per_page=100`, auth],
      ["DELETE", `${url}/1`, auth],
      ["DELETE", `${url}/4`, auth],
      ["POST", url, auth],
    ]);
  });

  serialTest("createForgeRelease propagates a conflict without a matching draft and fails on a non-404 draft delete", async () => {
    const mock = mockForgeConflict(409, [{id: 1, tag_name: "other-tag", draft: true}]);
    await expect(createForgeRelease(giteaInfo, "v1.0.0", "body", ["tok"])).rejects.toThrow("409");
    expect(getCalls(mock).map(([_url, init]) => init?.method)).toEqual(["POST", "GET"]);
    mockForgeConflict(409, [{id: 5, tag_name: "v1.0.0", draft: true}], 500);
    await expect(createForgeRelease(githubInfo, "v1.0.0", "body", ["tok"])).rejects.toThrow("Failed to delete draft release 5");
  });

  serialTest("createForgeRelease throws a non-auth error, a network error's cause and, once every token fails, the last auth error", async () => {
    mockFetch(() => new Response("Server error", {status: 500}));
    await expect(createForgeRelease(githubInfo, "1.0.0", "body", ["tok"])).rejects.toThrow("500");
    stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", {cause: new Error("getaddrinfo ENOTFOUND example.com")})));
    await expect(createForgeRelease(giteaInfo, "1.0.0", "body", ["tok"])).rejects.toThrow("getaddrinfo ENOTFOUND example.com");
    mockFetch(() => new Response("Unauthorized", {status: 401}));
    await expect(createForgeRelease(githubInfo, "1.0.0", "body", ["tok1", "tok2"])).rejects.toThrow("401");
  });

  serialTest("stored 401 tokens warn once and are skipped while 403 tokens do not warn", async () => {
    await storeToken("github.com", "stored-rejected-token");
    await storeToken("gitea.example.com", "stored-forbidden-token");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const statuses: Record<string, number> = {"Bearer stored-rejected-token": 401, "token stored-forbidden-token": 403};
    const mock = mockFetch((_url, init) => Response.json({html_url: "https://example.com/release"}, {status: statuses[authOf(init)!] ?? 201}));
    try {
      await withTokenEnv({GH_TOKEN: "github-env-token"}, async () => {
        const tokens = await getForgeTokens(githubInfo);
        await createForgeRelease(githubInfo, "1.0.0", "body", tokens);
        await createForgeRelease(githubInfo, "1.0.1", "body", tokens);
      });
      await withTokenEnv({GITEA_URL: "https://gitea.example.com", GITEA_TOKEN: "gitea-env-token"}, async () => {
        await createForgeRelease(giteaInfo, "1.0.0", "body", await getForgeTokens(giteaInfo));
      });
      expect(getCalls(mock).map(([_url, init]) => authOf(init))).toEqual([
        "Bearer stored-rejected-token",
        "Bearer github-env-token",
        "Bearer github-env-token",
        "token stored-forbidden-token",
        "token gitea-env-token",
      ]);
      expect(error.mock.calls).toEqual([[
        "stored token for github.com was rejected, run \"versions --login github.com\" to replace it",
      ]]);
    } finally {
      error.mockRestore();
      await removeToken("github.com");
      await removeToken("gitea.example.com");
    }
  });

  serialTest("verifyToken uses each forge API and rejects a 401", async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(Response.json({login: "octocat"}, {status: 200}))
      .mockResolvedValueOnce(Response.json({login: "tea-user"}, {status: 200}))
      .mockResolvedValueOnce(new Response("Unauthorized", {status: 401}));
    stubGlobal("fetch", mock);
    expect(await verifyToken("github.com", "github-token")).toEqual("octocat");
    expect(await verifyToken("gitea.example.com:3000", "gitea-token")).toEqual("tea-user");
    await expect(verifyToken("github.com", "bad-token")).rejects.toThrow("token for github.com was rejected");
    expect(getCalls(mock).map(([url, init]) => [url, authOf(init)])).toEqual([
      ["https://api.github.com/user", "Bearer github-token"],
      ["https://gitea.example.com:3000/api/v1/user", "token gitea-token"],
      ["https://api.github.com/user", "Bearer bad-token"],
    ]);
  });

  serialTest.each([
    ["rejects a pull-only token", githubInfo, {permissions: {push: false, admin: false, pull: true}}, "token lacks push permission on o/r"],
    ["accepts the all-false permissions of an installation token", githubInfo, {permissions: {push: false, admin: false, pull: false}}, null],
    ["names a disabled gitea releases unit", giteaInfo, {has_releases: false, permissions: {push: true, admin: false}}, "the Releases unit is disabled on o/r; enable it in the repository settings"],
    ["lets a repo admin bypass a disabled gitea releases unit", giteaInfo, {has_releases: false, permissions: {push: true, admin: true}}, null],
  ])("pingForge %s", async (_name, info, body, expected) => {
    mockFetch(() => Response.json(body));
    expect(await pingForge(info, ["tok"])).toEqual(expected);
  });
});

test.each(["--gitless", "--no-push"])("%s and --release are mutually exclusive", async (flag) => {
  const err = await runFail([flag, "--release", "--base", "1.0.0", "patch"]);
  expect(err.exitCode).toEqual(1);
  expect(err.output).toContain(`${flag} and --release are mutually exclusive`);
});

test("validate aborts before any mutation on forge ping, remote tag and non-descendant errors, and rejects a malformed tokens.json and detached HEAD", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  const {stdout: remoteCommit} = await exec("git", ["commit-tree", "-p", "HEAD", "-m", "remote work", "HEAD^{tree}"], opts);
  await exec("git", ["push", "origin", `${remoteCommit}:refs/heads/master`, "HEAD:refs/tags/1.0.1"], opts);
  const tokenOpts = {...opts, env: {...opts.env, VERSIONS_FORGE_TOKENS: "gitea.invalid:fake-token"}};
  const state = () => Promise.all([
    ...[["show-ref", "--head"], ["status", "--porcelain", "--untracked-files=no"]].map(args => exec("git", args, opts)),
    exec("git", ["show-ref", "--head"], {cwd: bareDir}),
    readFile(join(tmpDir, "package.json"), "utf8"),
  ]);
  const preState = await state();

  const {output} = await runFail(["--release", "patch", "package.json"], tokenOpts);
  for (const error of ["--release: forge ping", "tag 1.0.1 already exists on remote origin", "local HEAD is not a descendant"]) {
    expect(output).toContain(`error: ${error}`);
  }
  expect(await state()).toEqual(preState);

  const configHome = join(tmpDir, ".config");
  await mkdir(join(configHome, "versions"), {recursive: true});
  await writeFile(join(configHome, "versions", "tokens.json"), "{bad");
  expect((await runFail(["--release", "patch", "package.json"], {...opts, env: {...opts.env, XDG_CONFIG_HOME: configHome}})).output)
    .toMatch(/^Could not parse \S+tokens\.json: /);

  await exec("git", ["checkout", "--detach"], opts);
  const err = await runFail(["--release", "patch", "package.json"], tokenOpts);
  expect(err.exitCode).toEqual(1);
  expect(err.output).toContain("Cannot push from detached HEAD");
}));

test("rollback - -c failure, also with --gitless, and push failure restore files, commit, prior annotated tag and the user's index", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "b.txt"), "v 1.0.0 b");
  await writeFile(join(tmpDir, "tracked.txt"), "base\n");
  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  await writeFile(join(bareDir, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {mode: 0o755});
  await exec("git", ["tag", "-a", "1.0.1", "-m", "annotated"], opts);
  await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged hunk\n");
  await exec("git", ["add", "tracked.txt"], opts);
  await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged hunk\nworktree only\n");
  await writeFile(join(tmpDir, "new.txt"), "new content\n");
  await exec("git", ["add", "new.txt"], opts);
  const state = () => Promise.all([
    ...[["show-ref", "--head"], ["status", "--porcelain", "--untracked-files=no"], ["diff", "--cached"]].map(args => exec("git", args, opts)),
    ...["package.json", "b.txt", "tracked.txt"].map(file => readFile(join(tmpDir, file), "utf8")),
  ]);
  const preState = await state();
  const expectRestoredAfter = async (args: string[]) => {
    const {output} = await runFail(["--base", "1.0.0", ...args, "patch", "package.json", "b.txt"], opts);
    expect(await state()).toEqual(preState);
    return output;
  };

  await expectRestoredAfter(["--gitless", "-c", "exit 1"]);
  await expectRestoredAfter(["-c", "exit 1"]);
  expect(await expectRestoredAfter([])).toContain("pre-receive hook declined");
}));

test("push goes to origin by default, nowhere with --no-push, and to --remote, whose URL also picks the --release forge", () => withTmpDir(async (tmpDir) => {
  const files = {"package.json": pkgJson("1.0.0"), "pyproject.toml": pep621("1.0.0"), "README.md": "Install version 1.0.0\n"};
  for (const [file, content] of Object.entries(files)) await writeFile(join(tmpDir, file), content);
  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  const bareGit = async (args: string[]) => (await exec("git", args, {cwd: bareDir})).stdout;

  await exec("node", [distPath, "-p", "patch", ...Object.keys(files)], opts);
  const {stdout: head} = await exec("git", ["rev-parse", "HEAD"], opts);
  expect(await bareGit(["rev-parse", "HEAD", "v1.0.1^{}"])).toEqual(`${head}\n${head}`);
  for (const [file, content] of Object.entries(files)) {
    expect((await exec("git", ["show", `v1.0.1:${file}`], opts)).stdout).toEqual(content.replace("1.0.0", "1.0.1").trim());
  }

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);
  expect(await bareGit(["rev-parse", "HEAD"])).toEqual(head);
  expect(await bareGit(["tag", "--list"])).not.toContain("1.0.2");

  await exec("git", ["remote", "rename", "origin", "upstream"], opts);
  await exec("git", ["remote", "add", "origin", "file:///nowhere"], opts);
  const err = await runFail(["--remote", "upstream", "--release", "patch", "package.json"], {
    ...opts, env: {...opts.env, VERSIONS_FORGE_TOKENS: "gitea.invalid:fake-token"},
  });
  expect(err.exitCode).toEqual(1);
  expect(err.output).toContain("gitea.invalid");
  expect(err.output).not.toContain("could not detect a forge");
  await exec("node", [distPath, "--remote", "upstream", "patch", "package.json"], opts);
  expect(await bareGit(["tag", "--list"])).toContain("1.0.3");
}));

test("-R -p patch with no files commits the changelog entry with its fenced code, pushes and creates the release", () => withTmpDir(async (tmpDir) => {
  const entry = "### Fixed\n- existing entry\n\n```sh\n# install\nnpm i\n```";
  await writeFile(join(tmpDir, "CHANGELOG.md"), `# Changelog\n\n## 1.0.1 - 2024-01-15\n${entry}\n`);
  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  const certPath = fileURLToPath(new URL("fixtures/https/cert.pem", import.meta.url));
  const requests: Array<{method: string; url: string; authorization?: string; body: string}> = [];
  const routes: Record<string, [number, unknown]> = {
    "GET /api/v1/repos/owner/repo": [200, {permissions: {pull: true, push: true}}],
    "POST /api/v1/repos/owner/repo/releases": [201, {id: 1}],
  };
  const server = createServer({
    cert: readFileSync(certPath),
    key: readFileSync(new URL("fixtures/https/key.pem", import.meta.url)),
  }, async (request, response) => {
    requests.push({method: request.method!, url: request.url!, authorization: request.headers.authorization, body: await text(request)});
    const [status, body] = routes[`${request.method} ${request.url}`] ?? [404, {}];
    response.writeHead(status, {"Content-Type": "application/json"}).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    await exec("git", ["remote", "set-url", "origin", `https://${host}/owner/repo.git`], opts);
    await exec("node", [distPath, "-R", "-p", "patch"], {...opts, env: {
      ...opts.env, ...Object.fromEntries(tokenEnvNames.map(name => [name, ""])),
      VERSIONS_FORGE_TOKENS: `${host}:tok`, NODE_EXTRA_CA_CERTS: certPath, XDG_CONFIG_HOME: join(tmpDir, ".config"),
    }});
    expect(requests.map(({method, url, authorization}) => ({method, url, authorization}))).toEqual([
      {method: "GET", url: "/api/v1/repos/owner/repo", authorization: "token tok"},
      {method: "POST", url: "/api/v1/repos/owner/repo/releases", authorization: "token tok"},
    ]);
    expect(JSON.parse(requests[1].body)).toEqual({
      tag_name: "v1.0.1", name: "v1.0.1", body: entry, draft: false, prerelease: false,
    });
    const {stdout: head} = await exec("git", ["rev-parse", "HEAD"], opts);
    expect((await exec("git", ["show", "--name-only", "--format=", "HEAD"], opts)).stdout).toEqual("");
    expect((await exec("git", ["log", "-1", "--pretty=%B"], opts)).stdout).toEqual(`v1.0.1\n\n${entry}`);
    expect((await exec("git", ["tag", "-l", "v1.0.1", "--format=%(contents)"], opts)).stdout).toEqual(`v1.0.1\n\n${entry}`);
    expect((await exec("git", ["rev-parse", "HEAD", "v1.0.1^{}"], {cwd: bareDir})).stdout).toEqual(`${head}\n${head}`);
  } finally {
    server.close();
  }
}));

test("releasing to a non-default branch requires --any-branch, with or without --dry and --no-push", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  await exec("git", ["checkout", "-b", "release"], opts);

  const refusal = "release is not the default branch master of remote origin";
  expect((await runFail(["--branch", "release", "patch", "package.json"], opts)).output).toContain(refusal);
  await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"], opts);
  for (const flag of ["--dry", "--no-push"]) expect((await runFail([flag, "patch", "package.json"], opts)).output).toContain(refusal);
  await exec("node", [distPath, "--branch", "release", "--any-branch", "patch", "package.json"], opts);
  expect((await exec("git", ["branch", "--list"], {cwd: bareDir})).stdout).toContain("release");
}));

test("incrementSemver prerelease, preid and errors", () => {
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
  expect(() => incrementSemver("1.0.0", "unknown")).toThrow("Invalid semver level");
});

test("replaceTokens, with prerelease and build parts in _VER_ alone", () => {
  expect(replaceTokens("v_MAJOR_._MINOR_._PATCH_", "2.3.4")).toEqual("v2.3.4");
  expect(replaceTokens("_VER_ _MAJOR_ _MINOR_ _PATCH_", "10.20.30")).toEqual("10.20.30 10 20 30");
  expect(replaceTokens("no tokens", "1.0.0")).toEqual("no tokens");
  expect(replaceTokens("_VER_ _MAJOR_ _MINOR_ _PATCH_", "1.2.3-alpha.0")).toEqual("1.2.3-alpha.0 1 2 3");
  expect(replaceTokens("_PATCH_", "1.2.3+build.5")).toEqual("3");
});

test("esc", () => {
  expect(esc("1.0.0|abc")).toEqual("1\\.0\\.0\\|abc");
  expect(esc("")).toEqual("");
});

test("findUp", () => withTmpDir(async (tmpDir) => {
  const subDir = join(tmpDir, "a", "b");
  await writeFile(join(tmpDir, "target.txt"), "found");
  expect(findUp("target.txt", subDir)).toEqual(join(tmpDir, "target.txt"));
  expect(findUp("target.txt", subDir, join(tmpDir, "a"))).toBeNull();
}));

test.each([[[]], [["patch", "--help"]]])("prints help without a level and with --help: %j", async (args) => {
  const {stdout} = await exec("node", [distPath, ...args]);
  expect(stdout).toContain("usage: versions");
  expect(stdout).toContain("--replace");
});

test("login and logout dispatch without a release level", () => withTmpDir(async (tmpDir) => {
  const env = {...process.env, XDG_CONFIG_HOME: tmpDir};
  expect((await runFail(["--login"], {env})).output).toContain("Missing value for --login");
  expect((await runFail(["--logout", "ABSENT.example.com"], {env})).output).toContain("no stored token for absent.example.com");
  const path = join(tmpDir, "versions", "tokens.json");
  await mkdir(join(tmpDir, "versions"), {recursive: true});
  await writeFile(path, JSON.stringify({"gitea.example.com:3000": "token"}));
  const {stdout} = await exec("node", [distPath, "--logout", "https://GITEA.example.com:3000/path"], {env});
  expect(stdout).toEqual("removed token for gitea.example.com:3000");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({});
}));

test("dry mode with gitless and prefix options", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");
  const opts = await initGitRepo(tmpDir);
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "init"], opts);

  const {stdout} = await exec("node", [distPath, "--dry", "patch", "testfile.txt"], opts);
  expect(stdout).toContain("Would update testfile.txt");
  expect(stdout).toContain("Would create new tag and commit: 1.0.1");
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.0");
  expect((await exec("git", ["status", "--porcelain"], opts)).stdout).toEqual("");

  const {stdout: gitless} = await exec("node", [distPath, "--dry", "--gitless", "patch", "testfile.txt"], opts);
  expect(gitless).toContain("Would update testfile.txt");
  expect(gitless).not.toContain("Would create");

  const {stdout: noFiles} = await exec("node", [distPath, "--dry", "patch"], opts);
  expect(noFiles).toContain("Would create new tag and commit: 1.0.1");
  expect(noFiles).not.toContain("Would update");
  expect((await exec("node", [distPath, "--dry", "--skip-empty", "--prefix", "patch"], opts)).stdout)
    .toContain("Would create new tag: v1.0.1");
}));

test("--all does not exempt named files that produce no diff, --gitless does", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "notes.txt"), "no version in here");
  expect((await runFail(["--no-push", "--all", "--base", "1.0.0", "patch", "notes.txt"], {cwd: tmpDir})).output)
    .toContain("would not change any of the specified files");
  await exec("node", [distPath, "--gitless", "--base", "1.0.0", "patch", "notes.txt"], {cwd: tmpDir});
}));

test("--skip-empty tags HEAD without a commit when nothing needs committing, and rolls back the tag on push failure", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "README.md"), "docs");
  const {bareDir, opts} = await setupReleaseRepo(tmpDir);
  const {stdout: preHead} = await exec("git", ["rev-parse", "HEAD"], opts);

  await exec("node", [distPath, "--skip-empty", "-p", "patch"], opts);
  await exec("node", [distPath, "--skip-empty", "--all", "-p", "patch"], opts);

  for (const cwd of [tmpDir, bareDir]) {
    for (const ref of ["HEAD", "v1.0.1^{}", "v1.0.2^{}"]) {
      expect((await exec("git", ["rev-parse", ref], {...opts, cwd})).stdout).toEqual(preHead);
    }
  }

  await writeFile(join(bareDir, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {mode: 0o755});
  expect((await runFail(["--skip-empty", "-p", "patch"], opts)).output).toContain("pre-receive hook declined");
  expect((await exec("git", ["rev-parse", "HEAD"], opts)).stdout).toEqual(preHead);
  expect((await exec("git", ["tag", "--list"], opts)).stdout.split("\n")).toEqual(["1.0.0", "v1.0.1", "v1.0.2"]);
}));

test("--skip-empty still commits a changelog date, staged changes and --all changes", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "CHANGELOG.md"), "# Changelog\n\n## 1.0.1\n- entry\n");
  await writeFile(join(tmpDir, "notes.txt"), "base\n");
  const opts = await setupTaggedRepo(tmpDir);

  await exec("node", [distPath, "--skip-empty", "--no-push", "patch"], opts);
  expect((await exec("git", ["show", "--name-only", "--format=", "HEAD"], opts)).stdout).toEqual("CHANGELOG.md");
  expect(await readFile(join(tmpDir, "CHANGELOG.md"), "utf8")).toContain(`## 1.0.1 - ${new Date().toISOString().substring(0, 10)}`);

  await writeFile(join(tmpDir, "notes.txt"), "base\nstaged\n");
  await exec("git", ["add", "notes.txt"], opts);
  await writeFile(join(tmpDir, "notes.txt"), "base\nstaged\nunstaged\n");
  await exec("node", [distPath, "-e", "--no-push", "patch"], opts);
  expect((await exec("git", ["show", "1.0.2:notes.txt"], opts)).stdout).toEqual("base\nstaged");
  expect(await readFile(join(tmpDir, "notes.txt"), "utf8")).toEqual("base\nstaged\nunstaged\n");

  await exec("node", [distPath, "--skip-empty", "--no-push", "--all", "patch"], opts);
  expect((await exec("git", ["show", "1.0.3:notes.txt"], opts)).stdout).toEqual("base\nstaged\nunstaged");
  expect((await exec("git", ["log", "--oneline"], opts)).stdout.split("\n")).toHaveLength(4);
}));

test("--replace with tokens, empty replacements and invalid flags, and --command", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0\ncopyright YEAR_PLACEHOLDER\nDROPME tail");
  const base = ["--gitless", "--base", "1.0.0"];
  await exec("node", [distPath, ...base, "-r", "s#YEAR_PLACEHOLDER#_VER_#", "-r", "s#DROPME ##", "-c", "echo hello > marker.txt", "patch", "testfile.txt"], {cwd: tmpDir});
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1\ncopyright 1.0.1\ntail");
  expect(await readFile(join(tmpDir, "marker.txt"), "utf8")).toContain("hello");

  const err = await runFail([...base, "-r", "s#a#b#q", "patch", "testfile.txt"], {cwd: tmpDir});
  expect(err.output).toContain("Invalid replace string: s#a#b#q: Invalid flags");
}));

test("a named package-lock.json is bumped, go.sum and other lockfiles are skipped", () => withTmpDir(async (tmpDir) => {
  const lock = (version: string) => ({version, packages: {"": {version}, "node_modules/dep": {version: "1.0.0"}}});
  const skipped = {"go.sum": "content with 1.0.0", "Gemfile.lock": "gem 1.0.0", "pnpm-lock.yaml": "dep@1.0.0"};
  for (const [name, content] of Object.entries(skipped)) await writeFile(join(tmpDir, name), content);
  await writeFile(join(tmpDir, "package-lock.json"), JSON.stringify(lock("1.0.0")));
  await exec("node", [distPath, "--gitless", "--base", "1.0.0", "patch", ...Object.keys(skipped), "package-lock.json"], {cwd: tmpDir});
  for (const [name, content] of Object.entries(skipped)) expect(await readFile(join(tmpDir, name), "utf8")).toEqual(content);
  expect(JSON.parse(await readFile(join(tmpDir, "package-lock.json"), "utf8"))).toEqual(lock("1.0.1"));
}));

test.each([
  {pm: "pnpm", lockfile: "pnpm-lock.yaml", lock: (_version: string, dep: string) => `timerel: ${dep}\n`},
  {pm: "npm", lockfile: "package-lock.json", lock: (version: string, dep: string) =>
    `${JSON.stringify({version, packages: {"": {version}, "node_modules/timerel": {version: dep}}}, null, 2)}\n`},
])("a $pm packageManager pin carries $lockfile into the commit, bumped when handled", ({pm, lockfile, lock}) => withTmpDir(async (tmpDir) => {
  const manifest = (dep: string) => JSON.stringify({version: "1.0.0", packageManager: `${pm}@11.0.0`, devDependencies: {timerel: dep}});
  await writeFile(join(tmpDir, "package.json"), manifest("5.8.7"));
  await writeFile(join(tmpDir, lockfile), lock("1.0.0", "5.8.7"));
  const opts = await setupTaggedRepo(tmpDir);
  await writeFile(join(tmpDir, "package.json"), manifest("5.8.8"));
  await writeFile(join(tmpDir, lockfile), lock("1.0.0", "5.8.8"));

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);

  expect((await exec("git", ["show", "--name-only", "--format=", "HEAD"], opts)).stdout.split("\n").sort())
    .toEqual([lockfile, "package.json"].sort());
  expect((await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts)).stdout).toEqual("");
  expect(await readFile(join(tmpDir, lockfile), "utf8")).toEqual(lock("1.0.1", "5.8.8"));
}));

test("a packageManager naming an Object.prototype key finds no lockfile", () => withTmpDir(async (tmpDir) => {
  const manifest = join(tmpDir, "package.json");
  await writeFile(manifest, JSON.stringify({name: "test-pkg", version: "1.0.0", packageManager: "constructor@1.0.0"}));
  expect(findCompanionLockfile(manifest)).toBeNull();
}));

test("SubprocessError", () => {
  expect(new SubprocessError("failed", "out", "err", 1)).toMatchObject({
    message: "failed", name: "SubprocessError", stdout: "out", stderr: "err", output: "err\nout", exitCode: 1,
  });
  expect(new SubprocessError("failed")).toMatchObject({stdout: "", stderr: "", output: "", exitCode: null});
});

test("tomlGetString skips comments, other sections and bracketed array elements", () => {
  expect(tomlGetString("", "project", "version")).toBeUndefined();
  expect(tomlGetString("[other]\nversion = '1.0.0'\n[project]\nname = 'test'", "project", "version")).toBeUndefined();
  expect(tomlGetString("# comment\n[project] # note\nm = [\n  [1, 2],\n]\nversion = '1.0.0'", "project", "version")).toEqual("1.0.0");
});

async function expectReleaseMessage(opts: Parameters<typeof exec>[2], tag: string, message: string) {
  for (const args of [["log", "-1", "--pretty=%B", tag], ["tag", "-l", tag, "--format=%(contents)"]]) {
    expect((await exec("git", args, opts)).stdout).toEqual(message);
  }
}

test("commit and tag messages drop an empty --message, take --message tokens and the CHANGELOG.md entry, dating it if undated, else the git log since the last tag even with --base", () => withTmpDir(async (tmpDir) => {
  const changelogPath = join(tmpDir, "CHANGELOG.md");
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(changelogPath, `# Changelog\n\n## [1.0.2] - 2024-01-15\n- existing entry\n\n## [1.0.1]\n### Added\n- Fixed thing X\n- Added thing Y\n\n## 1.0.0\nold stuff\n`);
  const opts = await setupTaggedRepo(tmpDir);
  await exec("git", ["config", "commit.cleanup", "verbatim"], opts);

  await exec("node", [distPath, "--no-push", "-m", "", "-m", "Release _VER_", "patch", "package.json"], opts);
  const changelog = await readFile(changelogPath, "utf8");
  expect(changelog).toContain(`## [1.0.1] - ${new Date().toISOString().substring(0, 10)}`);
  await expectReleaseMessage(opts, "1.0.1", "1.0.1\n\nRelease 1.0.1\n\n### Added\n- Fixed thing X\n- Added thing Y");

  await exec("node", [distPath, "--no-push", "patch", "package.json"], opts);
  await expectReleaseMessage(opts, "1.0.2", "1.0.2\n\n- existing entry");

  await exec("git", ["commit", "--allow-empty", "-m", "tweak something"], opts);
  await exec("node", [distPath, "--no-push", "--base=1.0.2", "patch", "package.json"], opts);
  await expectReleaseMessage(opts, "1.0.3", "1.0.3\n\n* tweak something (Test User)");
  expect(await readFile(changelogPath, "utf8")).toEqual(changelog);
}));

test("a CHANGELOG.md-only bump is not read as a wrong base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "CHANGELOG.md"), `# Changelog\n\n## 1.0.1\n- entry\n\n## 1.0.0\nold\n`);
  const opts = await setupTaggedRepo(tmpDir);
  await exec("node", [distPath, "--no-push", "patch", "CHANGELOG.md"], opts);
  expect(await readFile(join(tmpDir, "CHANGELOG.md"), "utf8")).toContain(`## 1.0.1 - ${new Date().toISOString().substring(0, 10)}`);
  expect((await exec("git", ["show", "--name-only", "--format=", "HEAD"], opts)).stdout.trim()).toEqual("CHANGELOG.md");
}));

test("-N reads notes from stdin or a file over CHANGELOG.md for commit and tag", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), pkgJson("1.0.0"));
  await writeFile(join(tmpDir, "CHANGELOG.md"), "# Changelog\n\n## [1.0.1]\n- from changelog\n");
  await writeFile(join(tmpDir, "notes.md"), "- from notes file\n");
  const opts = await setupTaggedRepo(tmpDir);
  await exec("node", [distPath, "--no-push", "-N", "-", "patch", "package.json"], {...opts, stdin: "- from stdin\n"});
  await expectReleaseMessage(opts, "1.0.1", "1.0.1\n\n- from stdin");
  await exec("node", [distPath, "--no-push", "-N", "notes.md", "patch", "package.json"], opts);
  await expectReleaseMessage(opts, "1.0.2", "1.0.2\n\n- from notes file");
}));

test("readVersionFile reads package.json and pyproject.toml versions, as rewritten by write, from a subdir", () => withTmpDir(async (tmpDir) => {
  const subDir = join(tmpDir, "sub");
  await mkdir(subDir);
  const read = (file: string, content: string) => {
    write(join(tmpDir, file), content);
    return readVersionFile(file, subDir);
  };
  expect(readVersionFile("package.json", subDir)).toBeNull();
  expect(read("package.json", JSON.stringify({name: "test"}))).toBeNull();
  expect(read("package.json", JSON.stringify({name: "test", version: "3.2.1"}))).toEqual("3.2.1");
  expect(read("pyproject.toml", `[project]\nname = "test"\n`)).toBeNull();
  expect(read("pyproject.toml", `[project]\nname = "test"\nversion = "1.5.0"\n`)).toEqual("1.5.0");
  expect(read("pyproject.toml", `[tool.poetry]\nname = "test"\nversion = "2.0.0"\n`)).toEqual("2.0.0");
  expect(read("pyproject.toml", `[tool.poetry]\nversion = "2.0.0"\n[project]\nversion = "3.0.0"\n`)).toEqual("3.0.0");
}));

test("getFileChanges bumps only the own version of each manifest, standalone versions, dates and replacements in generic files, and skips unhandled lockfiles", () => withTmpDir(async (tmpDir) => {
  const change = async (name: string, content: string, opts?: Partial<Parameters<typeof getFileChanges>[0]>) => {
    const file = join(tmpDir, name);
    await writeFile(file, content);
    return getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0", ...opts})?.newData;
  };
  for (const indent of [undefined, 2]) {
    const manifest = (version: string) => JSON.stringify({name: "foo", overrides: {"some-pkg": {version: "1.0.0"}}, version}, null, indent);
    expect(await change("package.json", manifest("1.0.0"))).toEqual(manifest("2.0.0"));
  }
  const lock = (version: string) => `${JSON.stringify({name: "test", version, packages: {"": {version}, "node_modules/dep": {version: "1.0.0"}}}, null, 2)}\n`;
  expect(await change("package-lock.json", lock("1.0.0"))).toEqual(lock("2.0.0"));
  const pyproject = (version: string) => `[project]\nname = "test"\nversion = "${version}"\n\n[tool.someplugin]\nversion = "1.0.0"\n[tool.poetry]\nversion = "${version}"\n`;
  expect(await change("pyproject.toml", pyproject("1.0.0"))).toEqual(pyproject("2.0.0"));
  const uvLock = (version: string) => `[[package]]\nname = "dep"\nversion = "1.0.0"\n\n[[package]]\nname = "test"\nversion = "${version}"\n`;
  expect(await change("uv.lock", uvLock("1.0.0"))).toEqual(uvLock("2.0.0"));
  expect(await change("version.txt", "version 1.0.0 needs 11.0.0 released 2020-01-01 FOO", {
    date: "2025-06-15", replacements: [{re: /FOO/, replacement: "BAR"}],
  })).toEqual("version 2.0.0 needs 11.0.0 released 2025-06-15 BAR");
  expect(getFileChanges({file: join(tmpDir, "yarn.lock"), baseVersion: "1.0.0", newVersion: "2.0.0"})).toBeNull();
}));

async function withTokenEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = {...process.env};
  for (const name of tokenEnvNames) delete process.env[name];
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const name of [...tokenEnvNames, ...Object.keys(env)]) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

const giteaHost = (host: string): RepoInfo => ({...giteaInfo, host});

describe("token env", {concurrent: false}, () => {
  serialTest("getForgeTokens puts a stored token before deduplicated env tokens, which bind to github.com and the GITEA_URL host", () => withTokenEnv({
    GH_TOKEN: "gh-tok", GITEA_AUTH_TOKEN: "gitea-tok", GITEA_TOKEN: "gitea-tok", GITEA_URL: "https://gitea.example.com",
  }, async () => {
    await storeToken("gitea.example.com", "stored-token");
    expect((await stat(join(testConfigHome, "versions", "tokens.json"))).mode & 0o777).toEqual(process.platform === "win32" ? 0o666 : 0o600);
    expect(await getForgeTokens(giteaInfo)).toEqual(["stored-token", "gitea-tok"]);
    expect(await getForgeTokens(giteaHost("other.example.com"))).toEqual([]);
    await removeToken("gitea.example.com");
  }));

  serialTest("getForgeTokens matches a VERSIONS_FORGE_TOKENS host carrying a port over env tokens, the bare host does not claim it", () => withTokenEnv({
    VERSIONS_FORGE_TOKENS: "localhost:3500:pair-tok", GITEA_TOKEN: "gitea-tok", GITEA_URL: "https://localhost:3500",
  }, async () => {
    expect(await getForgeTokens(giteaHost("localhost:3500"))).toEqual(["pair-tok"]);
    expect(await getForgeTokens(giteaHost("localhost"))).toEqual([]);
  }));

  serialTest("getForgeTokens recovers the CI token from an extraheader in the global git config", () => withTmpDir(async (tmpDir) => {
    const globalConfig = join(tmpDir, "global.config");
    await exec("git", ["config", "--file", globalConfig, "http.https://ci.example.com/.extraheader", `AUTHORIZATION: basic ${Buffer.from("x-access-token:ci-tok").toString("base64")}`]);
    await withTokenEnv({GIT_CONFIG_GLOBAL: globalConfig}, async () => {
      expect(await getForgeTokens(giteaHost("ci.example.com"), tmpDir)).toEqual(["ci-tok"]);
      expect(await getForgeTokens(giteaHost("elsewhere.example.com"), tmpDir)).toEqual([]);
    });
  }));
});

test("getRepoInfo parses the origin remote, null without one", () => withTmpDir(async (tmpDir) => {
  const opts = await initGitRepo(tmpDir);
  expect(await getRepoInfo(tmpDir)).toBeNull();
  await exec("git", ["remote", "add", "origin", "git@github.com:o/r.git"], opts);
  expect(await getRepoInfo(tmpDir)).toEqual({owner: "o", repo: "r", host: "github.com", type: "github"});
}));

test("removeIgnoredFiles", () => withTmpDir(async (tmpDir) => {
  await initGitRepo(tmpDir);
  await writeFile(join(tmpDir, ".gitignore"), "ignored.txt\n");
  expect(await removeIgnoredFiles(["kept.txt", "ignored.txt"], tmpDir)).toEqual(["kept.txt"]);
}));

test("writeResult prints stdout and stderr to stdout", () => {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  writeResult({stdout: "hello", stderr: "warn"});
  const output = spy.mock.calls.join("");
  spy.mockRestore();
  expect(output).toMatch(/^hello\r?\nwarn\r?\n$/);
});
