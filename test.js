"use strict";

const assert = require("assert");
const process = require("process");
const execa = require("execa");
const fs = require("fs-extra");
const path = require("path");
const semver = require("semver");

const pkgFile = path.join(__dirname, "package.json");
const testFile = path.join(__dirname, "testfile");

const prefix = "testfile v";
let pkgStr;

async function exit(err) {
  if (pkgStr) await fs.writeFile(pkgFile, pkgStr);
  await fs.unlink(testFile);
  if (err) console.info(err);
  process.exit(err ? 1 : 0);
}

async function run(args) {
  return await execa.shell(`node ver.js ${args}`);
}

async function read() {
  return await JSON.parse(await fs.readFile(pkgFile, "utf8")).version;
}

async function verify(version) {
  assert.deepStrictEqual(await read(), version);
  assert.deepStrictEqual(await fs.readFile(testFile, "utf8"), `${prefix}${version}`);
  return version;
}

async function main() {
  pkgStr = await fs.readFile(pkgFile);

  let version = await read();
  await fs.writeFile(testFile, `${prefix}${version}`);

  await run(`patch -g testfile`);
  version = await verify(semver.inc(version, "patch"));

  await run(`minor -g testfile`);
  version = await verify(semver.inc(version, "minor"));

  await run(`major -g testfile`);
  version = await verify(semver.inc(version, "major"));

  await run(`major -g t*stf*le`);
  version = await verify(semver.inc(version, "major"));

  await run(`major -g testfile testfile`);
  version = await verify(semver.inc(version, "major"));
}

main().then(exit).catch(exit);
