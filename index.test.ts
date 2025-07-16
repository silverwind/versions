import {execa} from "execa";
import {readFileSync} from "node:fs";
import {readFile, writeFile, unlink} from "node:fs/promises";
import {parse} from "smol-toml";
import type {SemverLevel} from "./index.ts";

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
  const {stdout, exitCode} = await execa("node", ["dist/index.js", "-v"]);
  expect(stdout).toEqual(expected);
  expect(exitCode).toEqual(0);
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
  return await execa(`node dist/index.js ${args}`, {shell: true});
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

  await run(`--date --base ${version} --gitless major t*stf*le`);
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
