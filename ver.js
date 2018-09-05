#!/usr/bin/env node
"use strict";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
    "c", "color",
    "g", "gitless",
    "h", "help",
    "n", "no-color",
    "p", "prefix",
    "v", "version",
  ],
  string: [
    "r", "replace",
    "_",
  ],
  alias: {
    b: "base",
    c: "color",
    g: "gitless",
    h: "help",
    n: "no-color",
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

  Increment semantic versions across your project. Intended for projects with a package.json, but
  works with any other text-based files too. Will also create a git commit and tag by default.

  Commands:
    patch                   Increment patch 0.0.x version
    minor                   Increment minor 0.x.0 version
    major                   Increment major x.0.0 version

  Arguments:
    files                   Files to replace the version in. Default is the nearest package.json

  Options:
    -b, --base <version>    Base version to use. Default is from the nearest package.json
    -r, --replace <str>     Additional replacement in the format "s#regexp#replacement#flags"
    -g, --gitless           Do not create a git commit and tag
    -p, --prefix            Prefix tags with a "v" character
    -c, --color             Force-enable color output
    -n, --no-color          Disable color output
    -v, --version           Print the version
    -h, --help              Print this help

  Examples:
    $ ver patch
    $ ver patch build.js
    $ ver minor build.js -r "s#[0-9]{4}-[0-9]{2}-[0-9]{2}#$(date +%Y-%m-%d)#g"`);
  exit();
}

if (args["color"]) process.env.FORCE_COLOR = "1";
if (args["no-color"]) process.env.FORCE_COLOR = "0";

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
const chalk = require("chalk");
const boxen = require("boxen");

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
      throw new Error(`Unable to obtain base version, either create package,json or specify --base`);
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
  } else if (!files.includes(packageFile)) {
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

  const oldStr = highlightDiff(baseVersion, newVersion, false);
  const newStr = highlightDiff(newVersion, baseVersion, true);

  console.log(boxen(` Version updated from ${oldStr} to ${newStr} `, {
    borderStyle: "round",
    borderColor: "green",
  }));

  if (args.gitless) {
    return exit();
  }

  // create git commit and tag
  const tagName = args.prefix ? `$v${newVersion}` : newVersion;
  try {
    await run("git", ["commit", "-a", "-m", newVersion]);
    await run("git", ["tag", "-a", "-f", "-m", tagName, tagName]);
  } catch (err) {
    return process.exit(1);
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
    newData = oldData.replace(new RegExp(`\b${esc(baseVersion)}\b`, "g"), newVersion);
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

function highlightDiff(a, b, added) {
  const aParts = a.split(/\./);
  const bParts = b.split(/\./);
  const color = chalk[added ? "green" : "red"];
  const versionPartRe = /^[0-9a-zA-Z-.]+$/;
  let res = "";

  for (let i = 0; i < aParts.length; i++) {
    if (aParts[i] !== bParts[i]) {
      if (versionPartRe.test(aParts[i])) {
        res += color(aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(char => {
          return versionPartRe.test(char) ? color(char) : char;
        }).join("") + color("." + aParts.slice(i + 1).join("."));
      }
      break;
    } else {
      res += aParts[i] + ".";
    }
  }

  return res;
}

function exit(err) {
  if (err) {
    console.info(String(err.message || err).trim());
  }
  process.exit(err ? 1 : 0);
}

main().then(exit).catch(exit);
