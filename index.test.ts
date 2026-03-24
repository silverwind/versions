import spawn from "nano-spawn";
import {readFileSync} from "node:fs";
import {readFile, writeFile, rm, mkdir, mkdtemp} from "node:fs/promises";
import {parse} from "smol-toml";
import type {SemverLevel} from "./index.ts";
import {spawnEnhanced} from "./utils.ts";
import {join} from "node:path";
import {tmpdir} from "node:os";

const distPath = join(process.cwd(), "dist/index.js");

const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const isSemver = (str: string) => semverRe.test(str.replace(/^v/, ""));

function incrementSemver(str: string, level: SemverLevel) {
  if (!isSemver(str)) throw new Error(`Invalid semver: ${str}`);
  if (level === "major") return str.replace(/([0-9]+)\.[0-9]+\.[0-9]+(.*)/, (_, m1, m2) => {
    return `${Number(m1) + 1}.0.0${m2}`;
  });
  if (level === "minor") return str.replace(/([0-9]+\.)([0-9]+)\.[0-9]+(.*)/, (_, m1, m2, m3) => {
    return `${m1}${Number(m2) + 1}.0${m3}`;
  });
  return str.replace(/([0-9]+\.[0-9]+\.)([0-9]+)(.*)/, (_, m1, m2, m3) => {
    return `${m1}${Number(m2) + 1}${m3}`;
  });
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
  await spawnEnhanced("git", ["init"], {cwd: tmpDir, env: {...process.env, ...env}});
  await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir, env: {...process.env, ...env}});
  await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir, env: {...process.env, ...env}});
}

async function withTmpDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "versions-test-"));
  try {
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
}

test("version", async () => {
  const {version: expected} = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
  const {stdout} = await spawn("node", [distPath, "-v"]);
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
  expect(incrementSemver("1.0.0-pre-1.0.0", "patch")).toEqual("1.0.1-pre-1.0.0");
  expect(incrementSemver("1.0.0-pre-1.0.0", "minor")).toEqual("1.1.0-pre-1.0.0");
  expect(incrementSemver("1.0.0-pre-1.0.0", "major")).toEqual("2.0.0-pre-1.0.0");
  expect(incrementSemver("10.10.10-pre-1.0.0", "patch")).toEqual("10.10.11-pre-1.0.0");
  expect(incrementSemver("10.10.10-pre-1.0.0", "minor")).toEqual("10.11.0-pre-1.0.0");
  expect(incrementSemver("10.10.10-pre-1.0.0", "major")).toEqual("11.0.0-pre-1.0.0");
});

test("versions", () => withTmpDir(async (tmpDir) => {
  const pkgStr = readFileSync(new URL("package.json", import.meta.url), "utf8");
  let {version} = JSON.parse(pkgStr);

  await writeFile(join(tmpDir, "package.json"), pkgStr);
  await writeFile(join(tmpDir, "testfile"), `testfile v${version} (1999-01-01)`);

  const run = (args: string) => spawn(`node ${distPath} ${args}`, {shell: true, cwd: tmpDir});
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
  const dataBefore = parse(str) as Record<string, any>;

  const versionBefore = dataBefore.tool.poetry.version;
  expect(dataBefore.tool.poetry.dependencies.flask).toEqual(versionBefore);

  await writeFile(join(tmpDir, "pyproject.toml"), str);
  await spawn(`node ${distPath} minor --gitless --date --base ${versionBefore} pyproject.toml`, {shell: true, cwd: tmpDir});

  const dataAfter = parse(await readFile(join(tmpDir, "pyproject.toml"), "utf8")) as Record<string, any>;
  const versionAfter = incrementSemver(versionBefore, "minor");
  expect(dataAfter.tool.poetry.version).toEqual(versionAfter);
  expect(dataAfter.tool.poetry.dependencies.flask).toEqual(versionBefore);
}));

test("uv", () => withTmpDir(async (tmpDir) => {
  const pyproject = await readFile(new URL("fixtures/uv/pyproject.toml", import.meta.url), "utf8");
  const lock = await readFile(new URL("fixtures/uv/uv.lock", import.meta.url), "utf8");

  const dataBeforePyproject = parse(pyproject) as Record<string, any>;

  const name = dataBeforePyproject.project.name;
  const versionBefore = dataBeforePyproject.project.version;

  await writeFile(join(tmpDir, "pyproject.toml"), pyproject);
  await writeFile(join(tmpDir, "uv.lock"), lock);
  await spawn(`node ${distPath} minor --gitless --date --base ${versionBefore} pyproject.toml uv.lock`, {shell: true, cwd: tmpDir});

  const dataAfter = parse(await readFile(join(tmpDir, "pyproject.toml"), "utf8")) as Record<string, any>;
  const versionAfter = incrementSemver(versionBefore, "minor");
  expect(dataAfter.project.version).toEqual(versionAfter);

  const lockAfter = parse(await readFile(join(tmpDir, "uv.lock"), "utf8")) as Record<string, any>;

  for (const pkg of lockAfter.package) {
    if (pkg.name === name) {
      expect(pkg.version).toEqual(versionAfter);
      break;
    }
  }
}));

test("fallback to package.json when no git tags exist", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "2.5.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 2.5.0");

  await spawn("node", [distPath, "--gitless", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.5.1");
}));

test("fallback to pyproject.toml when no git tags exist", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "3.2.1"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 3.2.1");

  await spawn("node", [distPath, "--gitless", "minor", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 3.3.0");
}));

test("fallback behavior with git repo but no tags", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-package", version: "5.1.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 5.1.0");

  await spawn("node", [distPath, "--gitless", "major", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 6.0.0");
}));

test("poetry-style pyproject.toml fallback", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[tool.poetry]
name = "poetry-test"
version = "0.5.2"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 0.5.2");

  await spawn("node", [distPath, "--gitless", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 0.5.3");
}));

test("package.json takes precedence over pyproject.toml", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "2.0.0"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await spawn("node", [distPath, "--gitless", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1");
}));

test("fallback to pyproject.toml when package.json has invalid semver", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "invalid"}, null, 2));
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "3.0.0"
`);
  await writeFile(join(tmpDir, "testfile.txt"), "version 3.0.0");

  await spawn("node", [distPath, "--gitless", "minor", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 3.1.0");
}));

test("prerelease from stable version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await spawn("node", [distPath, "--gitless", "--preid=alpha", "prerelease", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-alpha.0");
}));

test("prerelease increment with same preid", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.1-beta.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.1-beta.0");

  await spawn("node", [distPath, "--gitless", "--preid=beta", "prerelease", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-beta.1");
}));

test("prerelease with different preid", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "2.0.0-alpha.5"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 2.0.0-alpha.5");

  await spawn("node", [distPath, "--gitless", "--preid=rc", "prerelease", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.0.0-rc.0");
}));

test("prerelease without preid fails", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  let error;
  try {
    await spawn("node", [distPath, "--gitless", "prerelease", "testfile.txt"], {cwd: tmpDir});
  } catch (err) {
    error = err;
  }

  expect(error).toBeDefined();
}));

test("patch with preid creates prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await spawn("node", [distPath, "--gitless", "--preid=alpha", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-alpha.0");
}));

test("minor with preid creates prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await spawn("node", [distPath, "--gitless", "--preid=beta", "minor", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.1.0-beta.0");
}));

test("major with preid creates prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await spawn("node", [distPath, "--gitless", "--preid=rc", "major", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.0.0-rc.0");
}));

test("patch with preid on prerelease version strips old prerelease", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0-alpha.5"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0-alpha.5");

  await spawn("node", [distPath, "--gitless", "--preid=beta", "patch", "testfile.txt"], {cwd: tmpDir});

  expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-beta.0");
}));

test("package.json with non-matching base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));

  await spawn("node", [distPath, "--gitless", "--base", "8.16.3", "patch", "package.json"], {cwd: tmpDir});

  const result = JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8"));
  expect(result.version).toEqual("8.16.4");
}));

test("pyproject.toml with non-matching base version", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "2.0.0"
`);

  await spawn("node", [distPath, "--gitless", "--base", "5.3.1", "minor", "pyproject.toml"], {cwd: tmpDir});

  const result = parse(await readFile(join(tmpDir, "pyproject.toml"), "utf8")) as Record<string, any>;
  expect(result.project.version).toEqual("5.4.0");
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

  await spawn("node", [distPath, "--gitless", "--base", "2.3.0", "patch", "package.json", "pnpm-lock.yaml"], {cwd: tmpDir});

  const pkgAfter = JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8"));
  expect(pkgAfter.version).toEqual("2.3.1");

  expect(await readFile(join(tmpDir, "pnpm-lock.yaml"), "utf8")).toEqual(lockContent);
}));

test("release", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  await spawnEnhanced("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await spawnEnhanced("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await spawnEnhanced("git", ["remote", "add", "origin", "https://github.com/test-copilot-versions/test-repo.git"], {cwd: tmpDir, env: {...process.env, ...env}});
  await spawnEnhanced("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});

  try {
    await spawn("node", [distPath, "--release", "patch", "testfile.txt"], {
      cwd: tmpDir,
      env: {...process.env, GITHUB_TOKEN: "fake-test-token-12345", ...env},
    });
    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1");
  } catch (err: any) {
    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1");
    expect(err.output).toContain("Failed to create release");
    expect(err.output).toMatch(/401|403/);
  }
}));
