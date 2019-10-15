#!/usr/bin/env node
"use strict";

const minOpts = {
  boolean: [
    "g", "gitless",
    "h", "help",
    "P", "packageless",
    "p", "prefix",
    "v", "version",
    "C", "changelog",
  ],
  string: [
    "b", "base",
    "c", "command",
    "d", "date",
    "r", "replace",
    "m", "message",
    "_",
  ],
  alias: {
    b: "base",
    c: "command",
    C: "changelog",
    d: "date",
    g: "gitless",
    h: "help",
    m: "message",
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
   files                     Files to do version replacement in. The nearest package.json and
                             package-lock.json will always be included unless the -P argument is given
  Options:
    -b, --base <version>     Base version to use. Default is parsed from the nearest package.json
    -c, --command <command>  Run a command after files are updated but before git commit and tag
    -d, --date [<date>]      Replace dates in format YYYY-MM-DD with current or given date
    -r, --replace <str>      Additional replacement in the format "s#regexp#replacement#flags"
    -P, --packageless        Do not include package.json and package-lock.json unless explicitely given
    -g, --gitless            Do not create a git commit and tag
    -p, --prefix             Prefix git tags with a "v" character
    -m, --message <str>      Custom tag and commit message, can be given multiple times. The token
                             _VER_ is available to fill in the new version
    -C, --changelog          Generate a changelog since the base version tag or if absent, the latest
                             tag, which will be appended to the tag and commit messages
    -v, --version            Print the version
    -h, --help               Print this help

  Examples:
    $ ver patch
    $ ver minor build.js
    $ ver major -p build.js
    $ ver patch -c 'npm run build'
    $ ver patch -C -m '_VER_' -m 'This is a great release'`);
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

const messages = parseMixedArg(args.message);

const {promisify} = require("util");
const readFile = promisify(require("fs").readFile);
const writeFile = promisify(require("fs").writeFile);
const truncate = promisify(require("fs").truncate);
const stat = promisify(require("fs").stat);
const realpath = promisify(require("fs").realpath);
const semver = require("semver");
const {basename, dirname, join} = require("path");
const findUp = require("find-up");
const shellEscape = require("shell-escape");

function find(name, base) {
  if (!base) {
    return findUp(name);
  } else {
    return findUp(async directory => {
      const path = join(directory, name);
      if (directory.length < base.length) {
        return findUp.stop;
      } else if (await findUp.exists(path)) {
        return path;
      }
    });
  }
}

async function main() {
  let packageFile = await find("package.json");
  if (packageFile) packageFile = await realpath(packageFile);

  // try to open package.json if it exists
  let pkg, pkgStr;
  if (packageFile) {
    try {
      pkgStr = await readFile(packageFile, "utf8");
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
  files = await Promise.all(files.map(file => realpath(file)));

  // remove duplicate paths
  files = Array.from(new Set(files));

  if (!args.packageless) {
    // include package.json if present
    if (packageFile && !files.includes(packageFile)) {
      files.push(packageFile);
    }

    // include package-lock.json if present
    let packageLockFile = await find("package-lock.json", dirname(packageFile));
    if (packageLockFile) packageLockFile = await realpath(packageLockFile);
    if (packageLockFile && !files.includes(packageLockFile)) {
      files.push(packageLockFile);
    }
  }

  if (!files.length) {
    throw new Error(`Found no files to do replacements in`);
  }

  // verify files exist
  for (const file of files) {
    const stats = await stat(file);
    if (!stats.isFile() && !stats.isSymbolicLink()) {
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

    const commitMsgs = [newVersion];
    const tagMsgs = [];

    if (messages) {
      const msgs = messages.map(message => `${message.replace(/_VER_/gm, newVersion)}`);
      commitMsgs.push(msgs);
      tagMsgs.push(msgs);
    }

    if (args.changelog) {
      const ref = args["prefix"] ? `v${baseVersion}` : baseVersion;
      let range;

      try { // check if base tag exists
        await run(`git show ${ref} --`, {silent: true});
        range = `${ref}..HEAD`;
      } catch (err) {}

      if (!range) { // check if we have any previous tag
        try {
          const {stdout} = await run(`git describe --abbrev=0`, {silent: true});
          range = `${stdout}..HEAD`;
        } catch (err) {}
      }

      if (!range) { // just use the whole log
        range = "";
      }

      const {stdout} = await run(`git log ${range} --pretty=format:"* %s (%an)"`, {silent: true});
      if (stdout && stdout.length) {
        commitMsgs.push(stdout);
        tagMsgs.push(stdout);
      }
    }

    if (!tagMsgs.length) {
      tagMsgs.push(newVersion);
    }

    const commitMsgString = shellEscape(flat(commitMsgs.map(msg => ["-m", msg])));
    const tagMsgString = shellEscape(flat(tagMsgs.map(msg => ["-m", msg])));

    try {
      await run(`git commit -a ${commitMsgString}`, {nocmd: true});
      await run(`git tag -f ${tagMsgString} '${tagName}'`, {nocmd: true});
    } catch (err) {
      return process.exit(1);
    }
  }

  exit();
}

async function run(cmd, {silent = false, nocmd = false} = {}) {
  if (!silent && !nocmd) console.info(`+ ${cmd}`);
  const child = require("execa")(cmd, {shell: true});
  if (!silent) child.stdout.pipe(process.stdout);
  if (!silent) child.stderr.pipe(process.stderr);
  return await child;
}

async function updateFile({file, baseVersion, newVersion, replacements, pkgStr}) {
  let oldData;
  if (pkgStr) {
    oldData = pkgStr;
  } else {
    oldData = await readFile(file, "utf8");
  }

  let newData;
  if (pkgStr) {
    const re = new RegExp(`("version":[^]*?")${esc(baseVersion)}(")`);
    newData = pkgStr.replace(re, (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else if (basename(file) === "package-lock.json") {
    // special case for package-lock.json which contains a lot of version
    // strings which make regexp replacement risky. From a few tests on
    // Node.js 12, key order seems to be preserved through parse and stringify.
    newData = JSON.parse(oldData);
    newData.version = newVersion;
    newData = JSON.stringify(newData, null, 2) + "\n";
  } else {
    const re = new RegExp(esc(baseVersion), "g");
    newData = oldData.replace(re, newVersion);
  }

  if (date) {
    const re = /([^0-9]|^)[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)/g;
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
    await write(file, newData);
  }
}

async function write(file, content) {
  if (require("os").platform() === "win32") {
    // truncate and append on windows to preserve file metadata
    await truncate(file, 0);
    await writeFile(file, content, {encoding: "utf8", flag: "r+"});
  } else {
    await writeFile(file, content, {encoding: "utf8"});
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
    return Boolean(arg);
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

function esc(str) {
  return str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function flat(arr) {
  return [].concat(...arr);
}

function exit(err) {
  if (err) {
    console.info(String(err.message || err).trim());
  }
  process.exit(err ? 1 : 0);
}

main().then(exit).catch(exit);
