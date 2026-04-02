import {readFileSync} from "node:fs";
import {readFile, writeFile, rm, mkdir, mkdtemp} from "node:fs/promises";
import {EOL, tmpdir} from "node:os";
import {join} from "node:path";
import {
  isSemver, incrementSemver, replaceTokens, esc,
  joinStrings, ensureEol, findUp,
} from "./index.ts";
import {exec, tomlGetString, SubprocessError} from "./utils.ts";

const distPath = join(process.cwd(), "dist/index.js");

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
    await rm(tmpDir, {recursive: true, force: true});
  }
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

test("release", () => withTmpDir(async (tmpDir) => {
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
  await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

  await initGitRepo(tmpDir);
  const env = getIsolatedGitEnv(tmpDir);
  await exec("git", ["add", "."], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["remote", "add", "origin", "https://github.com/test-copilot-versions/test-repo.git"], {cwd: tmpDir, env: {...process.env, ...env}});
  await exec("git", ["tag", "1.0.0"], {cwd: tmpDir, env: {...process.env, ...env}});

  try {
    await exec("node", [distPath, "--release", "patch", "testfile.txt"], {
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

test("ensureEol", () => {
  expect(ensureEol("text")).toEqual(`text${EOL}`);
  expect(ensureEol(`text${EOL}`)).toEqual(`text${EOL}`);
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
  const err = new SubprocessError("failed", "out", "err");
  expect(err.message).toEqual("failed");
  expect(err.stdout).toEqual("out");
  expect(err.stderr).toEqual("err");
  expect(err.output).toEqual("err\nout");
  expect(err.name).toEqual("SubprocessError");

  const errNoOutput = new SubprocessError("failed");
  expect(errNoOutput.output).toEqual("");
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
