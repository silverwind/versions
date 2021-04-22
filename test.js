import execa from "execa";
import {isSemver, incSemver} from "./semver.js";
import fs from "fs";

const {readFile, writeFile, unlink} = fs.promises;
const pkgFile = new URL("./package.json", import.meta.url);
const testFile = new URL("testfile", import.meta.url);
const script = `versions.cjs`;
const prefix = `testfile v`;
const fromSuffix = ` (1999-01-01)`;
const toSuffix = ` (${(new Date()).toISOString().substring(0, 10)})`;
let pkgStr;

test("semver", async () => {
  expect(isSemver("1.0.0")).toEqual(true);
  expect(isSemver("1.0.0-pre-1.0.0")).toEqual(true);
  expect(isSemver("1.2.3-0123")).toEqual(false);
  expect(incSemver("1.0.0", "patch")).toEqual("1.0.1");
  expect(incSemver("1.0.0", "minor")).toEqual("1.1.0");
  expect(incSemver("1.0.0", "major")).toEqual("2.0.0");
  expect(incSemver("2.0.0", "patch")).toEqual("2.0.1");
  expect(incSemver("2.0.1", "minor")).toEqual("2.1.0");
  expect(incSemver("2.1.1", "major")).toEqual("3.0.0");
  expect(incSemver("10.10.10", "patch")).toEqual("10.10.11");
  expect(incSemver("10.10.10", "minor")).toEqual("10.11.0");
  expect(incSemver("10.10.10", "major")).toEqual("11.0.0");
  expect(incSemver("1.0.0-pre-1.0.0", "patch")).toEqual("1.0.1-pre-1.0.0");
  expect(incSemver("1.0.0-pre-1.0.0", "minor")).toEqual("1.1.0-pre-1.0.0");
  expect(incSemver("1.0.0-pre-1.0.0", "major")).toEqual("2.0.0-pre-1.0.0");
  expect(incSemver("10.10.10-pre-1.0.0", "patch")).toEqual("10.10.11-pre-1.0.0");
  expect(incSemver("10.10.10-pre-1.0.0", "minor")).toEqual("10.11.0-pre-1.0.0");
  expect(incSemver("10.10.10-pre-1.0.0", "major")).toEqual("11.0.0-pre-1.0.0");
});

async function run(args) {
  return await execa(`node ${script} ${args}`, {shell: true});
}

async function read() {
  return await JSON.parse(await readFile(pkgFile, "utf8")).version;
}

async function verify(version) {
  expect(await readFile(testFile, "utf8")).toEqual(`${prefix}${version}${toSuffix}`);
  return version;
}

test("versions", async () => {
  pkgStr = await readFile(pkgFile);

  let version = await read();
  await writeFile(testFile, `${prefix}${version}${fromSuffix}`);

  await run(`-P patch -d -g testfile`);
  version = await verify(incSemver(version, "patch"));

  await run(`-b ${version} -P -C --date --gitless minor testfile`);
  version = await verify(incSemver(version, "minor"));

  await run(`-b ${version} --packageless --gitless --date major testfile`);
  version = await verify(incSemver(version, "major"));

  await run(`-b ${version} -g -C -P -d major t*stf*le`);
  version = await verify(incSemver(version, "major"));

  await run(`-b ${version} -d -g -P major testfile testfile`);
  version = await verify(incSemver(version, "major"));

  await run(`-b ${version} -dgPGC minor testfile`);
  version = await verify(incSemver(version, "minor"));
});

afterAll(async () => {
  if (pkgStr) await writeFile(pkgFile, pkgStr);
  await unlink(testFile);
});
