import {readFileSync} from "node:fs";
import {readFile, writeFile, rm, mkdir, mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  isSemver, incrementSemver, replaceTokens, esc,
  joinStrings, findUp, getFileChanges, write,
  readVersionFromPackageJson, readVersionFromPyprojectToml,
  removeIgnoredFiles, getGithubTokens, getGiteaTokens,
  getRepoInfo, writeResult, createForgeRelease,
  type RepoInfo,
} from "./index.ts";
import {exec, tomlGetString, SubprocessError} from "./utils.ts";

const distPath = join(process.cwd(), "dist/index.js");

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
  await exec("git", ["init", "--bare", bareDir]);
  return bareDir;
}

function getIsolatedGitEnv(tmpDir: string) {
  const isolatedHome = join(tmpDir, ".home");
  return {
    HOME: isolatedHome,
    GIT_CONFIG_GLOBAL: join(isolatedHome, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function initGitRepo(tmpDir: string): Promise<void> {
  const env = getIsolatedGitEnv(tmpDir);
  await mkdir(env.HOME, {recursive: true});
  await exec("git", ["init"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir, env: {...process.env, ...env}});
}

async function withTmpDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "versions-test-"));
  try {
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
}

// initial commit, github fetch URL with local bare push, tag 1.0.0. Caller must have written
// any tracked files into tmpDir before invocation since this stages everything via `git add .`.
async function setupReleaseRepo(tmpDir: string, fetchUrl: string = "https://github.com/o/r.git"): Promise<{env: ReturnType<typeof getIsolatedGitEnv>, bareDir: string}> {
  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  const opts = {cwd: tmpDir, env: {...process.env, ...env}};
  await exec("git", ["add", "."], opts);
  await exec("git", ["commit", "-m", "Initial commit"], opts);
  await exec("git", ["remote", "add", "origin", fetchUrl], opts);
  await exec("git", ["remote", "set-url", "--push", "origin", bareDir], opts);
  await exec("git", ["push", "origin", "master"], opts);
  await exec("git", ["tag", "1.0.0"], opts);
  return {env, bareDir};
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

  await run(`--date --base ${version} --gitless major testfile`);
  version = await verify(incrementSemver(version, "major"));

  await run(`--date --base ${version} --gitless major testfile testfile`);
  version = await verify(incrementSemver(version, "major"));

  await run(`--date --base ${version} --gitless minor testfile`);
  version = await verify(incrementSemver(version, "minor"));
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

test("fallback to package.json when no git tags exist", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "2.5.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 2.5.0");

  await exec("node", [distPath, "--gitless", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.5.1");
}));

test("fallback to pyproject.toml when no git tags exist", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "3.2.1"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 3.2.1");

  await exec("node", [distPath, "--gitless", "minor", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 3.3.0");
}));

test("fallback behavior with git repo but no tags", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-package", version: "5.1.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 5.1.0");

  await exec("node", [distPath, "--gitless", "major", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 6.0.0");
}));

test("poetry-style pyproject.toml fallback", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[tool.poetry]
name = "poetry-test"
version = "0.5.2"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 0.5.2");

  await exec("node", [distPath, "--gitless", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 0.5.3");
}));

test("package.json takes precedence over pyproject.toml", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "2.0.0"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await exec("node", [distPath, "--gitless", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1");
}));

test("fallback to pyproject.toml when package.json has invalid semver", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "invalid"}, null, 2));
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "3.0.0"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 3.0.0");

  await exec("node", [distPath, "--gitless", "minor", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 3.1.0");
}));

test("prerelease from stable version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await exec("node", [distPath, "--gitless", "--preid=alpha", "prerelease", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-alpha.0");
}));

test("prerelease increment with same preid", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.1-beta.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.1-beta.0");

  await exec("node", [distPath, "--gitless", "--preid=beta", "prerelease", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-beta.1");
}));

test("prerelease with different preid", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "2.0.0-alpha.5"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 2.0.0-alpha.5");

  await exec("node", [distPath, "--gitless", "--preid=rc", "prerelease", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.0.0-rc.0");
}));

test("prerelease without preid fails", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  let error;
  try {
    await exec("node", [distPath, "--gitless", "prerelease", "testfile.txt"], {cwd: tmpDir});
  } catch (err) {
    error = err;
  }

  expect(error).toBeDefined();
}));

test("patch with preid creates prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await exec("node", [distPath, "--gitless", "--preid=alpha", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-alpha.0");
}));

test("minor with preid creates prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await exec("node", [distPath, "--gitless", "--preid=beta", "minor", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.1.0-beta.0");
}));

test("major with preid creates prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await exec("node", [distPath, "--gitless", "--preid=rc", "major", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.0.0-rc.0");
}));

test("patch with preid on prerelease version strips old prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0-alpha.5"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0-alpha.5");

  await exec("node", [distPath, "--gitless", "--preid=beta", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-beta.0");
}));

test("package.json with non-matching base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await exec("node", [distPath, "--gitless", "--base", "8.16.3", "patch", "package.json"], {cwd: tmpDir});

  const result = JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8"));
  expect(result.version).toEqual("8.16.4");
}));

test("pyproject.toml with non-matching base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "2.0.0"
`);

  await exec("node", [distPath, "--gitless", "--base", "5.3.1", "minor", "pyproject.toml"], {cwd: tmpDir});

  const resultStr = await readFile(join(tmpDir, "pyproject.toml"), "utf8");
  expect(tomlGetString(resultStr, "project", "version")).toEqual("5.4.0");
}));

test("lockfiles are not corrupted by version replacement", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "2.3.0"}, null, 2));

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

test("createForgeRelease github success", async () => {
  const mock = vi.fn(() => Promise.resolve(Response.json({html_url: "https://github.com/o/r/releases/tag/1.0.1"}, {status: 201})));
  stubGlobal("fetch", mock);
  const info: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
  await createForgeRelease(info, "1.0.1", "changelog", ["gh-token"]);
  expect(mock).toHaveBeenCalledOnce();
  const [url, init] = mock.mock.calls[0] as unknown as [string, any];
  expect(url).toEqual("https://api.github.com/repos/o/r/releases");
  expect(init.headers.Authorization).toEqual("Bearer gh-token");
  const body = JSON.parse(init.body);
  expect(body.tag_name).toEqual("1.0.1");
  expect(body.name).toEqual("1.0.1");
  expect(body.body).toEqual("changelog");
  expect(body.draft).toEqual(false);
  expect(body.prerelease).toEqual(false);
});

test("createForgeRelease gitea success", async () => {
  const mock = vi.fn(() => Promise.resolve(Response.json({html_url: "https://gitea.example.com/o/r/releases/tag/2.0.0"}, {status: 201})));
  stubGlobal("fetch", mock);
  const info: RepoInfo = {owner: "o", repo: "r", host: "gitea.example.com", type: "gitea"};
  await createForgeRelease(info, "2.0.0", "notes", ["gitea-tok"]);
  expect(mock).toHaveBeenCalledOnce();
  const [url, init] = mock.mock.calls[0] as unknown as [string, any];
  expect(url).toEqual("https://gitea.example.com/api/v1/repos/o/r/releases");
  expect(init.headers.Authorization).toEqual("token gitea-tok");
});

test("createForgeRelease prerelease tag", async () => {
  const mock = vi.fn(() => Promise.resolve(Response.json({}, {status: 201})));
  stubGlobal("fetch", mock);
  const info: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
  await createForgeRelease(info, "1.0.0-beta.1", "body", ["tok"]);
  expect(JSON.parse((mock.mock.calls[0] as unknown as [string, any])[1].body).prerelease).toEqual(true);
});

test.each([[401, "Unauthorized"], [403, "Forbidden"]])("createForgeRelease token fallback on %i", async (status, text) => {
  const mock = vi.fn()
    .mockResolvedValueOnce(new Response(text, {status}))
    .mockImplementation(() => Promise.resolve(Response.json({html_url: "https://github.com/o/r/releases/tag/1.0.0"}, {status: 201})));
  stubGlobal("fetch", mock);
  const info: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
  await createForgeRelease(info, "1.0.0", "body", ["bad-token", "good-token"]);
  expect(mock).toHaveBeenCalledTimes(2);
});

test("createForgeRelease throws on non-auth error", async () => {
  stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("Validation failed", {status: 422, statusText: "Unprocessable Entity"}))));
  const info: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
  await expect(createForgeRelease(info, "1.0.0", "body", ["tok"])).rejects.toThrow("422");
});

test("createForgeRelease throws when all tokens fail", async () => {
  stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("Unauthorized", {status: 401, statusText: "Unauthorized"}))));
  const info: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
  await expect(createForgeRelease(info, "1.0.0", "body", ["tok1", "tok2"])).rejects.toThrow("401");
});

test("createForgeRelease network error includes cause", async () => {
  stubGlobal("fetch", vi.fn().mockRejectedValue(
    Object.assign(new TypeError("fetch failed"), {cause: new Error("getaddrinfo ENOTFOUND example.com")}),
  ));
  const info: RepoInfo = {owner: "o", repo: "r", host: "example.com", type: "gitea"};
  await expect(createForgeRelease(info, "1.0.0", "body", ["tok"])).rejects.toThrow("getaddrinfo ENOTFOUND example.com");
});

test("createForgeRelease no html_url in response", async () => {
  stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({id: 1}, {status: 201}))));
  const info: RepoInfo = {owner: "o", repo: "r", host: "github.com", type: "github"};
  await createForgeRelease(info, "1.0.0", "body", ["tok"]);
});

test("release rejects detached HEAD", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "set-url", "--push", "origin", bareDir], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["push", "origin", "master"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["checkout", "--detach"], {cwd: tmpDir, env: {...process.env, ...env}});

  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "tok", ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.exitCode).toEqual(1);
  }
}));

test("--gitless and --release are mutually exclusive", async () => {
  try {
    await exec("node", [distPath, "--gitless", "--release", "--base", "1.0.0", "patch"]);
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.exitCode).toEqual(1);
  }
});

test("rollback - github forge failure reverts local + remote", () => withTmpDir(async (tmpDir) => {
  const pkgContent = JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2);
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const {env, bareDir} = await setupReleaseRepo(tmpDir, "https://github.com/owner/repo.git");

  const {stdout: preLocalHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  const {stdout: preRemoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});

  // forge release fails (api.github.com returns 404 for owner/repo), triggering full rollback
  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "fake-token", ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.exitCode).toEqual(1);
  }

  // local: tag deleted, HEAD restored, file restored, working tree + index clean
  const {stdout: localTags} = await exec("git", ["tag", "--list"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(localTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
  const {stdout: postLocalHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(postLocalHead.trim()).toEqual(preLocalHead.trim());
  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
  const {stdout: localStatus} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(localStatus.trim()).toEqual("");

  // remote: tag deleted, branch HEAD restored
  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
  const {stdout: postRemoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  expect(postRemoteHead.trim()).toEqual(preRemoteHead.trim());
}));

test("rollback - gitea forge failure reverts local + remote", () => withTmpDir(async (tmpDir) => {
  const pkgContent = JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2);
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const {env, bareDir} = await setupReleaseRepo(tmpDir, "https://gitea.example.com/owner/repo.git");

  const {stdout: preLocalHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  const {stdout: preRemoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});

  // gitea.example.com doesn't resolve → forge fails → rollback runs
  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITEA_TOKEN: "fake-token", ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.exitCode).toEqual(1);
  }

  const {stdout: localTags} = await exec("git", ["tag", "--list"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(localTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
  const {stdout: postLocalHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(postLocalHead.trim()).toEqual(preLocalHead.trim());
  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
  const {stdout: localStatus} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(localStatus.trim()).toEqual("");

  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
  const {stdout: postRemoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  expect(postRemoteHead.trim()).toEqual(preRemoteHead.trim());
}));

test("rollback - push failure reverts local commit, tag, and file", () => withTmpDir(async (tmpDir) => {
  const pkgContent = JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2);
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const {env, bareDir} = await setupReleaseRepo(tmpDir);

  // pre-create tag 1.0.1 on bare remote pointing to a different commit so push fails
  const {stdout: oldRemoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  await exec("git", ["tag", "1.0.1", oldRemoteHead.trim()], {cwd: bareDir});

  const {stdout: preLocalHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});

  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "tok", ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.exitCode).toEqual(1);
  }

  // local tag was never created
  const {stdout: localTags} = await exec("git", ["tag", "--list"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(localTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
  // commit was reset
  const {stdout: postLocalHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(postLocalHead.trim()).toEqual(preLocalHead.trim());
  // file restored
  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
  // working tree + index clean
  const {stdout: status} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(status.trim()).toEqual("");
}));

test("rollback - -c failure restores file writes (gitless)", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  try {
    await exec("node", [distPath, "--gitless", "--base", "1.0.0", "-c", "exit 1", "patch", "testfile.txt"], {cwd: tmpDir});
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
  }

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.0");
}));

test("rollback - -c failure restores multiple file writes", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "a.txt"), "v 1.0.0 a");
  await writeFile(join(tmpDir, "b.txt"), "v 1.0.0 b");

  try {
    await exec("node", [distPath, "--gitless", "--base", "1.0.0", "-c", "exit 1", "patch", "a.txt", "b.txt"], {cwd: tmpDir});
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
  }

  expect(await readFile(join(tmpDir, "a.txt"), "utf8")).toEqual("v 1.0.0 a");
  expect(await readFile(join(tmpDir, "b.txt"), "utf8")).toEqual("v 1.0.0 b");
}));

test("rollback - -c failure leaves no commit or tag in git mode", () => withTmpDir(async (tmpDir) => {
  const pkgContent = JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2);
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout: preHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});

  try {
    await exec("node", [distPath, "--no-push", "-c", "exit 1", "patch", "package.json"], {
      cwd: tmpDir, env: {...process.env, ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
  }

  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
  // -c runs before commit/tag, so neither should exist
  const {stdout: tags} = await exec("git", ["tag", "--list"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(tags.trim().split("\n").filter(Boolean)).toEqual(["1.0.0"]);
  const {stdout: postHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(postHead.trim()).toEqual(preHead.trim());
}));

test("rollback - prior local tag is restored to its original target", () => withTmpDir(async (tmpDir) => {
  const pkgContent = JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2);
  await writeFile(join(tmpDir, "package.json"), pkgContent);

  const {env} = await setupReleaseRepo(tmpDir);

  // pre-existing local tag 1.0.1 at the initial commit
  const {stdout: initialOid} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.1"], {cwd: tmpDir, env: {...process.env, ...env}});
  const priorTagOid = initialOid.trim();

  // forge release fails after push, triggering rollback that must restore (not delete) the prior tag
  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "fake-token", ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
  }

  const {stdout: postTagOid} = await exec("git", ["rev-parse", "refs/tags/1.0.1"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(postTagOid.trim()).toEqual(priorTagOid);
}));

test("rollback - prior annotated tag stays annotated after restore", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  const {env} = await setupReleaseRepo(tmpDir);

  // pre-existing ANNOTATED tag 1.0.1 — `tag -f <oid>` would silently downgrade to lightweight on rollback
  await exec("git", ["tag", "-a", "1.0.1", "-m", "annotated"], {cwd: tmpDir, env: {...process.env, ...env}});
  const {stdout: priorType} = await exec("git", ["cat-file", "-t", "refs/tags/1.0.1"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(priorType.trim()).toEqual("tag");

  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "fake-token", ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
  }

  const {stdout: postType} = await exec("git", ["cat-file", "-t", "refs/tags/1.0.1"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(postType.trim()).toEqual("tag");
}));

test("rollback - user's pre-existing staged hunks survive", () => withTmpDir(async (tmpDir) => {
  const pkgContent = JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2);
  await writeFile(join(tmpDir, "package.json"), pkgContent);
  await writeFile(join(tmpDir, "other.txt"), "before");

  const {env} = await setupReleaseRepo(tmpDir);

  // user has pre-staged a hunk on an unrelated file
  await writeFile(join(tmpDir, "other.txt"), "user staged change");
  await exec("git", ["add", "other.txt"], {cwd: tmpDir, env: {...process.env, ...env}});
  const {stdout: preStatus} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(preStatus.trim()).toEqual("M  other.txt");

  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "fake-token", ...env},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
  }

  // after rollback: other.txt is still staged with the user's change, package.json untouched
  const {stdout: postStatus} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], {cwd: tmpDir, env: {...process.env, ...env}});
  expect(postStatus.trim()).toEqual("M  other.txt");
  expect(await readFile(join(tmpDir, "package.json"), "utf8")).toEqual(pkgContent);
}));

test("rollback - partial staged hunks and staged additions survive byte-for-byte", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "tracked.txt"), "base\n");

  const {env} = await setupReleaseRepo(tmpDir);
  const opts = {cwd: tmpDir, env: {...process.env, ...env}};

  // partial staged hunk: index has "base + staged hunk", working tree has more on top.
  // a plain --soft reset would leave our committed package.json bump in the index here too,
  // overwriting the staged hunk with a 1.0.1 entry; only read-tree restores it byte-for-byte.
  await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged hunk\n");
  await exec("git", ["add", "tracked.txt"], opts);
  await writeFile(join(tmpDir, "tracked.txt"), "base\nstaged hunk\nworktree only\n");

  // staged addition: a brand new file the user staged (`A  new.txt`)
  await writeFile(join(tmpDir, "new.txt"), "new content\n");
  await exec("git", ["add", "new.txt"], opts);

  const {stdout: preStatus} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts);
  const {stdout: preStaged} = await exec("git", ["diff", "--cached"], opts);
  const preTracked = await readFile(join(tmpDir, "tracked.txt"), "utf8");

  try {
    await exec("node", [distPath, "--release", "patch", "package.json"], {
      ...opts, env: {...opts.env, GITHUB_TOKEN: "fake-token"},
    });
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
  }

  const {stdout: postStatus} = await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts);
  expect(postStatus).toEqual(preStatus);
  const {stdout: postStaged} = await exec("git", ["diff", "--cached"], opts);
  expect(postStaged).toEqual(preStaged);
  expect(await readFile(join(tmpDir, "tracked.txt"), "utf8")).toEqual(preTracked);
}));

test("default push - pushes commit and tag without --release", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "add", "origin", bareDir], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["push", "origin", "master"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});

  await exec("node", [distPath, "patch", "package.json"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout: localHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: tmpDir, env: {...process.env, ...env}});
  const {stdout: remoteHead} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  expect(remoteHead.trim()).toEqual(localHead.trim());
  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).toContain("1.0.1");
}));

test("--no-push skips push", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "add", "origin", bareDir], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["push", "origin", "master"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout: remoteHeadBefore} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});

  await exec("node", [distPath, "--no-push", "patch", "package.json"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout: remoteHeadAfter} = await exec("git", ["rev-parse", "HEAD"], {cwd: bareDir});
  expect(remoteHeadAfter.trim()).toEqual(remoteHeadBefore.trim());
  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).not.toContain("1.0.1");
}));

test("--no-push and --release are mutually exclusive", async () => {
  try {
    await exec("node", [distPath, "--no-push", "--release", "--base", "1.0.0", "patch"]);
    throw new Error("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.exitCode).toEqual(1);
  }
});

test("--remote pushes to custom remote", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "add", "upstream", bareDir], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["push", "upstream", "master"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});

  await exec("node", [distPath, "--remote", "upstream", "patch", "package.json"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout: remoteTags} = await exec("git", ["tag", "--list"], {cwd: bareDir});
  expect(remoteTags.trim().split("\n").filter(Boolean)).toContain("1.0.1");
}));

test("--remote with --release uses that remote for forge detection", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  // origin has no forge URL, upstream points at github.com — release must follow --remote
  await exec("git", ["remote", "add", "origin", "file:///nowhere"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "add", "upstream", "https://github.com/owner/repo.git"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "set-url", "--push", "upstream", bareDir], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["push", "upstream", "master"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});

  // forge call to api.github.com fails (fake token + non-existent repo); the error proves the
  // upstream URL was used. If --remote was ignored, getRepoInfo would return null for file:///
  // and the error would be "Could not determine repository type" instead.
  let err: any;
  try {
    await exec("node", [distPath, "--remote", "upstream", "--release", "patch", "package.json"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "fake-token", ...env},
    });
  } catch (caught: any) {
    err = caught;
  }
  expect(err).toBeInstanceOf(SubprocessError);
  expect(err.exitCode).toEqual(1);
  expect(err.output).toContain("Failed to create release");
  expect(err.output).not.toContain("Could not determine repository type");
}));

test("--branch pushes specified branch", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  const bareDir = await createBareRemote(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "add", "origin", bareDir], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["push", "origin", "master"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["checkout", "-b", "release"], {cwd: tmpDir, env: {...process.env, ...env}});

  await exec("node", [distPath, "--branch", "release", "patch", "package.json"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout: remoteBranches} = await exec("git", ["branch", "--list"], {cwd: bareDir});
  expect(remoteBranches).toContain("release");
}));

test("incrementSemver prerelease", () => {
  expect(incrementSemver("1.0.0", "prerelease", "alpha")).toEqual("1.0.1-alpha.0");
  expect(incrementSemver("1.0.1-beta.0", "prerelease", "beta")).toEqual("1.0.1-beta.1");
  expect(incrementSemver("2.0.0-alpha.5", "prerelease", "rc")).toEqual("2.0.0-rc.0");
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

test("help", async () => {
  const {stdout} = await exec("node", [distPath, "--help"]);
  expect(stdout).toContain("usage: versions");
  expect(stdout).toContain("--replace");
});

test("no args prints help", async () => {
  const {stdout} = await exec("node", [distPath]);
  expect(stdout).toContain("usage: versions");
});

test("dry mode", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");
  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "init"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout} = await exec("node", [distPath, "--dry", "patch", "testfile.txt"], {
    cwd: tmpDir, env: {...process.env, ...env},
  });
  expect(stdout).toContain("Would create new tag and commit: 1.0.1");
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1");
}));

test("prefix", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");
  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "init"], {cwd: tmpDir, env: {...process.env, ...env}});

  const {stdout} = await exec("node", [distPath, "--dry", "--prefix", "patch", "testfile.txt"], {
    cwd: tmpDir, env: {...process.env, ...env},
  });
  expect(stdout).toContain("Would create new tag and commit: v1.0.1");
}));

test("replace", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0\ncopyright YEAR_PLACEHOLDER");
  await exec("node", [distPath, "--gitless", "--base", "1.0.0", "-r", "s#YEAR_PLACEHOLDER#_VER_#", "patch", "testfile.txt"], {cwd: tmpDir});
  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1\ncopyright 1.0.1");
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
});

test("incrementSemver unknown level throws", () => {
  expect(() => incrementSemver("1.0.0", "unknown")).toThrow("Invalid semver level");
});

test("readVersionFromPackageJson", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test", version: "3.2.1"}, null, 2));
  expect(readVersionFromPackageJson(tmpDir)).toEqual("3.2.1");

  const subDir = join(tmpDir, "sub");
  await mkdir(subDir);
  expect(readVersionFromPackageJson(subDir)).toEqual("3.2.1");
}));

test("readVersionFromPackageJson returns null", () => withTmpDir(async (tmpDir) => {
  expect(readVersionFromPackageJson(tmpDir)).toBeNull();

  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test"}, null, 2));
  expect(readVersionFromPackageJson(tmpDir)).toBeNull();
}));

test("readVersionFromPyprojectToml", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]\nname = "test"\nversion = "1.5.0"\n`);
  expect(readVersionFromPyprojectToml(tmpDir)).toEqual("1.5.0");
}));

test("readVersionFromPyprojectToml poetry", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[tool.poetry]\nname = "test"\nversion = "2.0.0"\n`);
  expect(readVersionFromPyprojectToml(tmpDir)).toEqual("2.0.0");
}));

test("readVersionFromPyprojectToml returns null", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]\nname = "test"\n`);
  expect(readVersionFromPyprojectToml(tmpDir)).toBeNull();
}));

test("getFileChanges package.json", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "package.json");
  await writeFile(file, JSON.stringify({name: "test", version: "1.0.0"}, null, 2));
  const [, content] = getFileChanges({file, baseVersion: "1.0.0", newVersion: "1.0.1"});
  expect(JSON.parse(content!).version).toEqual("1.0.1");
}));

test("getFileChanges package-lock.json", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "package-lock.json");
  const data = {name: "test", version: "1.0.0", lockfileVersion: 3, packages: {"": {version: "1.0.0"}}};
  await writeFile(file, JSON.stringify(data, null, 2));
  const [, content] = getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"});
  const result = JSON.parse(content!);
  expect(result.version).toEqual("2.0.0");
  expect(result.packages[""].version).toEqual("2.0.0");
}));

test("getFileChanges pyproject.toml", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "pyproject.toml");
  await writeFile(file, `[project]\nname = "test"\nversion = "1.0.0"\n`);
  const [, content] = getFileChanges({file, baseVersion: "1.0.0", newVersion: "1.1.0"});
  expect(content).toContain(`version = "1.1.0"`);
}));

test("getFileChanges uv.lock", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]\nname = "myapp"\nversion = "1.0.0"\n`);
  const file = join(tmpDir, "uv.lock");
  await writeFile(file, `[[package]]\nname = "myapp"\nversion = "1.0.0"\n`);
  const [, content] = getFileChanges({file, baseVersion: "1.0.0", newVersion: "1.1.0"});
  expect(content).toContain(`version = "1.1.0"`);
}));

test("getFileChanges generic file", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "version.txt");
  await writeFile(file, "version 1.0.0 here");
  const [, content] = getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"});
  expect(content).toEqual("version 2.0.0 here");
}));

test("getFileChanges lockfile skip", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "yarn.lock");
  await writeFile(file, "content 1.0.0");
  const [, content] = getFileChanges({file, baseVersion: "1.0.0", newVersion: "2.0.0"});
  expect(content).toBeNull();
}));

test("getFileChanges with date", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "changelog.txt");
  await writeFile(file, "version 1.0.0 released 2020-01-01");
  const [, content] = getFileChanges({file, baseVersion: "1.0.0", newVersion: "1.0.1", date: "2025-06-15"});
  expect(content).toEqual("version 1.0.1 released 2025-06-15");
}));

test("getFileChanges with replacements", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "file.txt");
  await writeFile(file, "version 1.0.0 FOO");
  const [, content] = getFileChanges({
    file, baseVersion: "1.0.0", newVersion: "1.0.1",
    replacements: [{re: /FOO/, replacement: "BAR"}],
  });
  expect(content).toEqual("version 1.0.1 BAR");
}));

test("write", () => withTmpDir(async (tmpDir) => {
  const file = join(tmpDir, "out.txt");
  await writeFile(file, "old");
  write(file, "new");
  expect(await readFile(file, "utf8")).toEqual("new");
}));

test("getGithubTokens", async () => {
  const saved = {...process.env};
  delete process.env.VERSIONS_FORGE_TOKEN;
  delete process.env.GITHUB_API_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.HOMEBREW_GITHUB_API_TOKEN;
  await getGithubTokens(); // may contain gh auth token if gh is installed
  process.env.GH_TOKEN = "test-token";
  expect(await getGithubTokens()).toContain("test-token");
  Object.assign(process.env, saved);
});

test("getGiteaTokens", () => {
  const saved = {...process.env};
  delete process.env.VERSIONS_FORGE_TOKEN;
  delete process.env.GITEA_API_TOKEN;
  delete process.env.GITEA_AUTH_TOKEN;
  delete process.env.GITEA_TOKEN;
  expect(getGiteaTokens()).toEqual([]);
  process.env.GITEA_TOKEN = "gitea-tok";
  expect(getGiteaTokens()).toContain("gitea-tok");
  Object.assign(process.env, saved);
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
  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  await writeFile(join(tmpDir, ".gitignore"), "ignored.txt\n");
  await writeFile(join(tmpDir, "kept.txt"), "");
  await writeFile(join(tmpDir, "ignored.txt"), "");
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "init"], {cwd: tmpDir, env: {...process.env, ...env}});

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
