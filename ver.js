#!/usr/bin/env node
"use strict";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
    "g", "no-git",
    "h", "help",
    "p", "prefix",
    "v", "version",
  ],
  string: [
    "r", "replace",
    "_",
  ],
  alias: {
    b: "base",
    g: "no-git",
    h: "help",
    p: "prefix",
    r: "replace",
    v: "version",
  }
});

if (args.version) {
  console.info(require(require("path").join(__dirname, "package.json")).version);
  process.exit(0);
}

const commands = ["patch", "minor", "major"];
let [level, ...files] = args._;

if (!commands.includes(level) || args.help) {
  console.info(`usage: ver [options] command [files...]

  Semantically increment a project's version in multiple files.

  Commands:
    patch                   Increment patch 0.0.x version
    minor                   Increment minor 0.x.0 version
    major                   Increment major x.0.0 version

  Arguments:
   files                    Files to handle. Default is the nearest package.json which if
                            present, will always be included.
  Options:
    -b, --base <version>    Base version to use. Default is parsed from the nearest package.json
    -r, --replace <str>     Additional replacement in the format "s#regexp#replacement#flags"
    -g, --no-git            Do not create a git commit and tag
    -p, --prefix            Prefix git tags with a "v" character
    -v, --version           Print the version
    -h, --help              Print this help

  Examples:
    $ ver patch
    $ ver -g minor build.js
    $ ver -p major build.js`);
  exit();
}

const replacements = [];
if (args.replace) {
  args.replace = Array.isArray(args.replace) ? args.replace : [args.replace];
  for (const replaceStr of args.replace) {
    let [_, re, replacement, flags] = (/^s#(.+?)#(.+?)#(.*?)$/.exec(replaceStr) || []);

    if (!re || !replacement) {
      exit(new Error(`Invalid replace string: ${replaceStr}`));
    }

    re = new RegExp(re, flags || undefined);
    replacements.push({re, replacement});
  }
}

const fs = require("fs-extra");
const esc = require("escape-string-regexp");
const semver = require("semver");
const basename = require("path").basename;

async function main() {
  const packageFile = await require("find-up")("package.json");

  // try to open package.json if it exists
  let pkg, pkgStr;
  if (packageFile) {
    try {
      pkgStr = await fs.readFile(packageFile, "utf8");
      pkg = JSON.parse(pkgStr);
    } catch (err) {
      throw new Error(`Error reading ${packageFile}: ${err.message}`);
    }
  }

  // obtain old version
  let baseVersion;
  if (!args.base) {
    if (pkg) {
      if (pkg.version) {
        baseVersion = pkg.version;
      } else {
        throw new Error(`No "version" field found in ${packageFile}`);
      }
    } else {
      throw new Error(`Unable to obtain base version, either create package.json or specify --base`);
    }
  } else {
    baseVersion = args.base;
  }

  // validate old version
  if (!semver.valid(baseVersion)) {
    throw new Error(`Invalid base version: ${baseVersion}`);
  }

  // create new version
  const newVersion = semver.inc(baseVersion, level);

  // make sure package.json is included if present
  if (!files.length) {
    files = [packageFile];
  } else if (packageFile && !files.includes(packageFile)) {
    files.push(packageFile);
  }

  // verify files exist
  for (const file of files) {
    const stat = await fs.stat(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`${file} is not a file`);
    }
  }

  // update files
  for (const file of files) {
    if (basename(file) === "package.json") {
      await updateFile({file, baseVersion, newVersion, replacements, pkgStr});
    } else {
      await updateFile({file, baseVersion, newVersion, replacements});
    }
  }

  if (!args["no-git"]) {
    // create git commit and tag
    const tagName = args["prefix"] ? `v${newVersion}` : newVersion;
    try {
      await run("git", ["commit", "-a", "-m", newVersion]);
      await run("git", ["tag", "-f", "-m", tagName, tagName]);
    } catch (err) {
      return process.exit(1);
    }
  }

  exit();
}

async function run(cmd, args) {
  const child = require("execa")(cmd, args);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  await child;
}

async function updateFile({file, baseVersion, newVersion, replacements, pkgStr}) {
  let oldData;
  if (pkgStr) {
    oldData = pkgStr;
  } else {
    oldData = await fs.readFile(file, "utf8");
  }

  let newData;
  if (pkgStr) {
    const re = new RegExp(`("version":[^]*?")${esc(baseVersion)}(")`);
    newData = pkgStr.replace(re, (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else {
    const re = new RegExp(`\\b${esc(baseVersion)}\\b`, "g");
    newData = oldData.replace(re, newVersion);
  }

  if (replacements.length) {
    for (const replacement of replacements) {
      newData = newData.replace(replacement.re, replacement.replacement);
    }
  }

  if (oldData === newData) {
    throw new Error(`No replacement made in ${file}`);
  } else {
    await fs.writeFile(file, newData);
  }
}

function exit(err) {
  if (err) {
    console.info(String(err.message || err).trim());
  }
  process.exit(err ? 1 : 0);
}

main().then(exit).catch(exit);
