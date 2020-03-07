"use strict";

const execa = require("execa");
const {isSemver, incSemver} = require("./semver");
const {join} = require("path");
const {readFile, writeFile, unlink} = require("fs").promises;
const {test, expect, afterAll} = global;

test("semver", async () => {
  expect(isSemver("1.0.0")).toEqual(true);
  expect(isSemver("1.0.0-pre-1.0.0")).toEqual(true);
  expect(isSemver("1.2.3-0123")).toEqual(false);
  expect(incSemver("1.0.0", "patch")).toEqual("1.0.1");
  expect(incSemver("1.0.0", "minor")).toEqual("1.1.0");
  expect(incSemver("1.0.0", "major")).toEqual("2.0.0");
  expect(incSemver("10.10.10", "patch")).toEqual("10.10.11");
  expect(incSemver("10.10.10", "minor")).toEqual("10.11.10");
  expect(incSemver("10.10.10", "major")).toEqual("11.10.10");
  expect(incSemver("1.0.0-pre-1.0.0", "patch")).toEqual("1.0.1-pre-1.0.0");
  expect(incSemver("1.0.0-pre-1.0.0", "minor")).toEqual("1.1.0-pre-1.0.0");
  expect(incSemver("1.0.0-pre-1.0.0", "major")).toEqual("2.0.0-pre-1.0.0");
});

const pkgFile = join(__dirname, "package.json");
const testFile = join(__dirname, "testfile");
const prefix = `testfile v`;
const fromSuffix = ` (1999-01-01)`;
const toSuffix = ` (${(new Date()).toISOString().substring(0, 10)})`;
let pkgStr;

test("versions", async () => {
  async function run(args) {
    return await execa(`node versions ${args}`, {shell: true});
  }

  async function read() {
    return await JSON.parse(await readFile(pkgFile, "utf8")).version;
  }

  async function verify(version) {
    expect(await readFile(testFile, "utf8")).toEqual(`${prefix}${version}${toSuffix}`);
    return version;
  }

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

  await run(`-b ${version} -dgPC minor testfile`);
  version = await verify(incSemver(version, "minor"));
});

afterAll(async () => {
  if (pkgStr) await writeFile(pkgFile, pkgStr);
  await unlink(testFile);
});
