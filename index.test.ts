import spawn from "nano-spawn";
import {readFileSync} from "node:fs";
import {readFile, writeFile, unlink, mkdir, rm} from "node:fs/promises";
import {parse} from "smol-toml";
import type {SemverLevel} from "./index.ts";
import {spawnEnhanced} from "./utils.ts";
import {join} from "node:path";
import {tmpdir} from "node:os";

const testFile = new URL("testfile", import.meta.url);

const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const isSemver = (str: string) => semverRe.test(str.replace(/^v/, ""));
let pkgStr: string;

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

afterAll(async () => {
  if (pkgStr) await writeFile(new URL("package.json", import.meta.url), pkgStr);
  await unlink(testFile);
});

test("version", async () => {
  const {version: expected} = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
  const {stdout} = await spawn("node", ["dist/index.js", "-v"]);
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

async function run(args: string) {
  return await spawn(`node dist/index.js ${args}`, {shell: true});
}

async function verify(version: string) {
  expect(await readFile(testFile, "utf8")).toEqual(
    `testfile v${version} (${(new Date()).toISOString().substring(0, 10)})`
  );
  return version;
}

test("versions", async () => {
  pkgStr = await readFile(new URL("package.json", import.meta.url), "utf8");
  let {version} = await JSON.parse(pkgStr);

  await writeFile(testFile, `testfile v${version} (1999-01-01)`);

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
});

test("poetry", async () => {
  const str = await readFile(new URL("fixtures/poetry/pyproject.toml", import.meta.url), "utf8");
  const dataBefore = parse(str) as Record<string, any>;

  const versionBefore = dataBefore.tool.poetry.version;
  expect(dataBefore.tool.poetry.dependencies.flask).toEqual(versionBefore);

  const tmpFile = new URL("pyproject.toml", import.meta.url);
  await writeFile(tmpFile, str);
  // todo: eliminate need for -b
  await run(`minor --gitless --date --base ${versionBefore} pyproject.toml`);

  const dataAfter = parse(await readFile(tmpFile, "utf8")) as Record<string, any>;
  const versionAfter = incrementSemver(versionBefore, "minor");
  expect(dataAfter.tool.poetry.version).toEqual(versionAfter);
  expect(dataAfter.tool.poetry.dependencies.flask).toEqual(versionBefore);
  await unlink(tmpFile);
});

test("uv", async () => {
  const pyproject = await readFile(new URL("fixtures/uv/pyproject.toml", import.meta.url), "utf8");
  const lock = await readFile(new URL("fixtures/uv/uv.lock", import.meta.url), "utf8");

  const dataBeforePyproject = parse(pyproject) as Record<string, any>;

  const name = dataBeforePyproject.project.name;
  const versionBefore = dataBeforePyproject.project.version;

  const tmpFilePyproject = new URL("pyproject.toml", import.meta.url);
  await writeFile(tmpFilePyproject, pyproject);
  const tmpFileLock = new URL("uv.lock", import.meta.url);
  await writeFile(tmpFileLock, lock);
  await run(`minor --gitless --date --base ${versionBefore} pyproject.toml uv.lock`);

  const dataAfter = parse(await readFile(tmpFilePyproject, "utf8")) as Record<string, any>;
  const versionAfter = incrementSemver(versionBefore, "minor");
  expect(dataAfter.project.version).toEqual(versionAfter);

  const lockAfter = parse(await readFile(tmpFileLock, "utf8")) as Record<string, any>;

  for (const pkg of lockAfter.package) {
    if (pkg.name === name) {
      expect(pkg.version).toEqual(versionAfter);
      break;
    }
  }

  await unlink(tmpFilePyproject);
  await unlink(tmpFileLock);
});

test("fallback to package.json when no git tags exist", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "2.5.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 2.5.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "patch",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.5.1");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("fallback to pyproject.toml when no git tags exist", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "3.2.1"
`);
    await writeFile(join(tmpDir, "testfile.txt"), "version 3.2.1");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "minor",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 3.3.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("fallback behavior with git repo but no tags", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-package", version: "5.1.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 5.1.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});
    await spawnEnhanced("git", ["add", "."], {cwd: tmpDir});
    await spawnEnhanced("git", ["commit", "-m", "Initial commit"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "major",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 6.0.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("poetry-style pyproject.toml fallback", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "pyproject.toml"), `[tool.poetry]
name = "poetry-test"
version = "0.5.2"
`);
    await writeFile(join(tmpDir, "testfile.txt"), "version 0.5.2");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "patch",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 0.5.3");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("package.json takes precedence over pyproject.toml", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
    await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "2.0.0"
`);
    await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "patch",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("fallback to pyproject.toml when package.json has invalid semver", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "invalid"}, null, 2));
    await writeFile(join(tmpDir, "pyproject.toml"), `[project]
name = "test-project"
version = "3.0.0"
`);
    await writeFile(join(tmpDir, "testfile.txt"), "version 3.0.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "minor",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 3.1.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("prerelease from stable version", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "--preid=alpha",
      "prerelease",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-alpha.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("prerelease increment with same preid", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.1-beta.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.1-beta.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "--preid=beta",
      "prerelease",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-beta.1");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("prerelease with different preid", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "2.0.0-alpha.5"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 2.0.0-alpha.5");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "--preid=rc",
      "prerelease",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.0.0-rc.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("prerelease without preid fails", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    let error;
    try {
      await spawn("node", [
        join(process.cwd(), "dist/index.js"),
        "--gitless",
        "prerelease",
        "testfile.txt"
      ], {cwd: tmpDir});
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("patch with preid creates prerelease", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "--preid=alpha",
      "patch",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.0.1-alpha.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("minor with preid creates prerelease", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "--preid=beta",
      "minor",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 1.1.0-beta.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test("major with preid creates prerelease", async () => {
  const tmpDir = join(tmpdir(), `versions-test-${Date.now()}`);
  await mkdir(tmpDir, {recursive: true});

  try {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({name: "test-pkg", version: "1.0.0"}, null, 2));
    await writeFile(join(tmpDir, "testfile.txt"), "version 1.0.0");

    await spawnEnhanced("git", ["init"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.email", "test@test.com"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "user.name", "Test User"], {cwd: tmpDir});
    await spawnEnhanced("git", ["config", "--local", "commit.gpgsign", "false"], {cwd: tmpDir});

    await spawn("node", [
      join(process.cwd(), "dist/index.js"),
      "--gitless",
      "--preid=rc",
      "major",
      "testfile.txt"
    ], {cwd: tmpDir});

    expect(await readFile(join(tmpDir, "testfile.txt"), "utf8")).toEqual("version 2.0.0-rc.0");
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});
