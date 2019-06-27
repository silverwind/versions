"use strict";

const assert = require("assert");
const process = require("process");
const execa = require("execa");
const fs = require("fs-extra");
const path = require("path");
const semver = require("semver");

const pkgFile = path.join(__dirname, "package.json");
const testFile = path.join(__dirname, "testfile");

const prefix = `testfile v`;
const fromSuffix = ` (1999-01-01)`;
const toSuffix = ` (${(new Date()).toISOString().substring(0, 10)})`;
let pkgStr;

async function exit(err) {
  if (pkgStr) await fs.writeFile(pkgFile, pkgStr);
  await fs.unlink(testFile);
  if (err) console.info(err);
  process.exit(err ? 1 : 0);
}

async function run(args) {
  return await execa(`node ver.js ${args}`, {shell: true});
}

async function read() {
  return await JSON.parse(await fs.readFile(pkgFile, "utf8")).version;
}

async function verify(version) {
  assert.deepStrictEqual(await read(), version);
  assert.deepStrictEqual(await fs.readFile(testFile, "utf8"), `${prefix}${version}${toSuffix}`);
  return version;
}

async function main() {
  pkgStr = await fs.readFile(pkgFile);

  let version = await read();
  await fs.writeFile(testFile, `${prefix}${version}${fromSuffix}`);

  await run(`-P patch -d -g testfile`);
  version = await verify(semver.inc(version, "patch"));

  await run(`-P --date --gitless minor testfile`);
  version = await verify(semver.inc(version, "minor"));

  await run(`--packageless --gitless --date major testfile`);
  version = await verify(semver.inc(version, "major"));

  await run(`-g -P -d major t*stf*le`);
  version = await verify(semver.inc(version, "major"));

  await run(`-d -g -P major testfile testfile`);
  version = await verify(semver.inc(version, "major"));

  await run(`-dgP minor testfile`);
  version = await verify(semver.inc(version, "minor"));
}

main().then(exit).catch(exit);
