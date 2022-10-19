import {execa} from "execa";
import {isSemver, incrementSemver} from "./versions.js";
import {readFileSync} from "fs";
import {readFile, writeFile, unlink} from "fs/promises";
import toml from "toml";

const pkgFile = new URL("package.json", import.meta.url);
const pyFile = new URL("fixtures/pyproject.toml", import.meta.url);
const testFile = new URL("testfile", import.meta.url);
let pkgStr;

afterAll(async () => {
  if (pkgStr) await writeFile(pkgFile, pkgStr);
  await unlink(testFile);
});

test("version", async () => {
  const {version: expected} = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
  const {stdout, exitCode} = await execa("node", ["bin/versions.js", "-v"]);
  expect(stdout).toEqual(expected);
  expect(exitCode).toEqual(0);
});

test("semver", async () => {
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

async function run(args) {
  return await execa(`node bin/versions.js ${args}`, {shell: true});
}

async function verify(version) {
  expect(await readFile(testFile, "utf8")).toEqual(
    `testfile v${version} (${(new Date()).toISOString().substring(0, 10)})`
  );
  return version;
}

test("versions", async () => {
  pkgStr = await readFile(pkgFile, "utf8");
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

test("pyproject.toml", async () => {
  const str = await readFile(pyFile, "utf8");
  const dataBefore = toml.parse(str);

  const versionBefore = dataBefore.tool.poetry.version;
  expect(dataBefore.tool.poetry.dependencies.flask).toEqual(versionBefore);
  expect(dataBefore["build-system"].requires[0]).toEqual(`poetry>=${versionBefore}`);

  const tmpFile = new URL("pyproject.toml", import.meta.url);
  await writeFile(tmpFile, str);
  // todo: eliminate need for -b
  await run(`minor --gitless --date --base ${versionBefore} pyproject.toml`);

  const dataAfter = toml.parse(await readFile(tmpFile, "utf8"));
  const versionAfter = incrementSemver(versionBefore, "minor");
  expect(dataAfter.tool.poetry.version).toEqual(versionAfter);
  expect(dataAfter.tool.poetry.dependencies.flask).toEqual(versionBefore);
  expect(dataAfter["build-system"].requires[0]).toEqual(`poetry>=${versionBefore}`);
  await unlink(tmpFile);
});
