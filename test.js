"use strict";

const assert = require("assert");
const process = require("process");
const execa = require("execa");
const fs = require("fs-extra");
const path = require("path");
const semver = require("semver");

const pkgFile = path.join(__dirname, "package.json");
const testFile = path.join(__dirname, "testfile");

let pkgStr;

async function exit(err) {
  if (pkgStr) await fs.writeFile(pkgFile, pkgStr);
  await fs.unlink(testFile);
  if (err) console.info(err);
  process.exit(err ? 1 : 0);
}

async function run(args) {
  return await execa.stdout("./ver.js", args.split(/\s+/));
}

async function read() {
  return await JSON.parse(await fs.readFile(pkgFile, "utf8")).version;
}

async function main() {
  pkgStr = await fs.readFile(pkgFile);

  const initialVersion = await read();
  let version = initialVersion;
  await fs.writeFile(testFile, version);

  await run(`patch -g testfile`);
  version = semver.inc(version, "patch");
  assert.deepStrictEqual(await read(), version);
  assert.deepStrictEqual(await fs.readFile(testFile, "utf8"), version);

  await run(`minor -g testfile`);
  version = semver.inc(version, "minor");
  assert.deepStrictEqual(await read(), version);
  assert.deepStrictEqual(await fs.readFile(testFile, "utf8"), version);

  await run(`major -g testfile`);
  version = semver.inc(version, "major");
  assert.deepStrictEqual(await read(), version);
  assert.deepStrictEqual(await fs.readFile(testFile, "utf8"), version);
}

main().then(exit).catch(exit);
