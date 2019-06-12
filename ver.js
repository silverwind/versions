#!/usr/bin/env node
"use strict";

const minOpts = {
  boolean: [
    "g", "gitless",
    "h", "help",
    "P", "packageless",
    "p", "prefix",
    "v", "version",
  ],
  string: [
    "b", "base",
    "c", "command",
    "d", "date",
    "r", "replace",
    "_",
  ],
  alias: {
    b: "base",
    c: "command",
    d: "date",
    g: "gitless",
    h: "help",
    P: "packageless",
    p: "prefix",
    r: "replace",
    v: "version",
  }
};

const commands = ["patch", "minor", "major"];
let args = require("minimist")(process.argv.slice(2), minOpts);
args = fixArgs(commands, args, minOpts);
let [level, ...files] = args._;

if (args.version) {
  console.info(require(require("path").join(__dirname, "package.json")).version);
  process.exit(0);
}

if (!commands.includes(level) || args.help) {
  console.info(`usage: ver [options] command [files...]

  Semantically increment a project's version in multiple files.

  Commands:
    patch                    Increment patch 0.0.x version
    minor                    Increment minor 0.x.0 version
    major                    Increment major x.0.0 version

  Arguments:
   files                     Files to handle. The nearest package.json will always be included
                             unless the -P argument is given.
  Options:
    -b, --base <version>     Base version to use. Default is parsed from the nearest package.json
    -c, --command <command>  Run a command after files are updated but before git commit and tag
    -d, --date [<date>]      Replace dates in format YYYY-MM-DD with current or given date
    -r, --replace <str>      Additional replacement in the format "s#regexp#replacement#flags"
    -P, --packageless        Do not include nearest package.json unless it's explicitely given
    -g, --gitless            Do not create a git commit and tag
    -p, --prefix             Prefix git tags with a "v" character
    -v, --version            Print the version
    -h, --help               Print this help

  Examples:
    $ ver patch
    $ ver -g minor build.js
    $ ver -p major build.js
    $ ver patch -c 'npm run build'`);
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

let date = parseMixedArg(args.date);
if (date) {
  if (date === true) {
    date = (new Date()).toISOString().substring(0, 10);
  } else if (Array.isArray(date)) {
    date = date[date.length - 1];
  }

  if (typeof date !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
    exit(`Invalid date argument: ${date}`);
  }
}

const fs = require("fs-extra");
const esc = require("escape-string-regexp");
const semver = require("semver");
const {basename} = require("path");

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

  // de-glob files args which is needed for dumb shells like
  // powershell that do not support globbing
  files = await require("fast-glob")(files);

  // convert paths to absolute
  files = await Promise.all(files.map(file => fs.realpath(file)));

  // remove duplicate paths
  files = Array.from(new Set(files));

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
  const newVersion = semver.inc(baseVersion, level);
  for (const file of files) {
    if (basename(file) === "package.json") {
      await updateFile({file, baseVersion, newVersion, replacements, pkgStr});
    } else {
      await updateFile({file, baseVersion, newVersion, replacements});
    }
  }

  if (args.command) {
    await run(args.command);
  }

  if (!args["gitless"]) {
    // create git commit and tag
    const tagName = args["prefix"] ? `v${newVersion}` : newVersion;
    try {
      await run(`git commit -a -m ${newVersion}`);
      await run(`git tag -f -m ${newVersion} ${tagName}`);
    } catch (err) {
      return process.exit(1);
    }
  }

  exit();
}

async function run(cmd) {
  console.info(`+ ${cmd}`);
  const child = require("execa").shell(cmd);
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
    const re = new RegExp(esc(baseVersion), "g");
    newData = oldData.replace(re, newVersion);
  }

  if (date) {
    const re = new RegExp(`([^0-9]|^)[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)`, "g");
    newData = newData.replace(re, (_, p1, p2) => `${p1}${date}${p2}`);
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

function parseMixedArg(arg) {
  if (arg === "") {
    return true;
  } else if (typeof arg === "string") {
    return arg.includes(",") ? arg.split(",") : [arg];
  } else if (Array.isArray(arg)) {
    return arg;
  } else {
    return false;
  }
}

// handle minimist parsing error like '-d patch'
function fixArgs(commands, args, minOpts) {
  for (const key of Object.keys(minOpts.alias)) {
    delete args[key];
  }

  if (commands.includes(args.date)) {
    args._ = [args.date, ...args._];
    args.date = true;
  }
  if (commands.includes(args.base)) {
    args._ = [args.base, ...args._];
    args.base = true;
  }
  if (commands.includes(args.command)) {
    args._ = [args.command, ...args._];
    args.command = "";
  }
  if (commands.includes(args.replace)) {
    args._ = [args.replace, ...args._];
    args.replace = "";
  }
  if (commands.includes(args.packageless)) {
    args._ = [args.packageless, ...args._];
    args.packageless = true;
  }

  return args;
}

function exit(err) {
  if (err) {
    console.info(String(err.message || err).trim());
  }
  process.exit(err ? 1 : 0);
}

main().then(exit).catch(exit);
