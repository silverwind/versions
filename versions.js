#!/usr/bin/env node
import {execa} from "execa";
import fastGlob from "fast-glob";
import minimist from "minimist";
import {basename, dirname, join, relative} from "path";
import {cwd, exit as doExit} from "process";
import {platform} from "os";
import {readFileSync, writeFileSync, accessSync, truncateSync, statSync} from "fs";
import {parse as parseToml} from "toml";
import {version} from "./package.json";

const fastGlobSync = fastGlob.sync; // workaround for commonjs
const esc = str => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const isSemver = str => semverRe.test(str.replace(/^v/, ""));
const pwd = cwd();

const minOpts = {
  boolean: [
    "a", "all",
    "g", "gitless",
    "G", "globless",
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
    a: "all",
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

export function incrementSemver(str, level) {
  if (!isSemver(str)) throw new Error(`Invalid semver: ${str}`);
  if (level === "major") return str.replace(/([0-9]+)\.[0-9]+\.[0-9]+(.*)/, (_, m1, m2) => {
    return `${Number(m1) + 1}.0.0${m2}`;
  });
  if (level === "minor") return str.replace(/([0-9]+\.)([0-9]+)\.[0-9]+(.*)/, (_, m1, m2, m3) => {
    return `${m1}${Number(m2) + 1}.0${m3}`;
  });
  return str.replace(/([0-9]+\.[0-9]+\.)([0-9]+)(.*)/, (_, m1, m2, m3) => {
    return `${m1}${Number(m2) + 1}${m3}`;
  });
}

function find(filename, dir, stopDir) {
  const path = join(dir, filename);

  try {
    accessSync(path);
    return path;
  } catch {}

  const parent = dirname(dir);
  if ((stopDir && path === stopDir) || parent === dir) {
    return null;
  } else {
    return find(filename, parent, stopDir);
  }
}

function formatArgs(args) {
  return args.map(arg => arg.includes(" ") ? `'${arg}'` : arg).join(" ");
}

async function run(cmd, {silent = false, input} = {}) {
  let child;
  if (Array.isArray(cmd)) {
    if (!silent) console.info(`+ ${formatArgs(cmd)}`);
    const [c, ...args] = cmd;
    child = execa(c, args, {input});
  } else {
    if (!silent) console.info(`+ ${cmd}`);
    child = execa(cmd, {shell: true, input});
  }

  if (!silent) child.stdout.pipe(process.stdout);
  if (!silent) child.stderr.pipe(process.stderr);
  return await child;
}

async function removeIgnoredFiles(files) {
  let stdout;
  try {
    ({stdout} = await run(["git", "check-ignore", "--", ...files], {silent: true}));
  } catch {
    return files;
  }
  const ignoredFiles = new Set(stdout.split(/\r?\n/));
  return files.filter(file => !ignoredFiles.has(file));
}

function updateFile({file, baseVersion, newVersion, replacements, pkgStr, date}) {
  const oldData = pkgStr || readFileSync(file, "utf8");
  const fileName = basename(file);

  let newData;
  if (pkgStr) {
    const re = new RegExp(`("version":[^]*?")${esc(baseVersion)}(")`);
    newData = pkgStr.replace(re, (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else if (fileName === "package-lock.json") {
    // special case for package-lock.json which contains a lot of version
    // strings which make regexp replacement risky.
    newData = JSON.parse(oldData);
    if (newData.version) newData.version = newVersion; // v1
    if (newData?.packages?.[""]?.version) newData.packages[""].version = newVersion; // v2
    newData = `${JSON.stringify(newData, null, 2)}\n`;
  } else if (fileName === "pyproject.toml") {
    const re = new RegExp(`(^version ?= ?["'])${esc(baseVersion)}(["'].*)`, "gm");
    newData = oldData.replace(re, (_, p1, p2) => `${p1}${newVersion}${p2}`);
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
    throw new Error(`No replacement made in ${file} for base version ${baseVersion}`);
  } else {
    write(file, newData);
  }
}

function write(file, content) {
  if (platform() === "win32") {
    try {
      truncateSync(file);
      writeFileSync(file, content, {flag: "r+"});
    } catch {
      writeFileSync(file, content);
    }
  } else {
    writeFileSync(file, content);
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

// handle minimist parsing issues like '-d patch'
function fixArgs(commands, args, minOpts) {
  for (const key of Object.keys(minOpts.alias)) {
    delete args[key];
  }

  if (commands.has(args.date)) {
    args._ = [args.date, ...args._];
    args.date = true;
  }
  if (commands.has(args.base)) {
    args._ = [args.base, ...args._];
    args.base = true;
  }
  if (commands.has(args.command)) {
    args._ = [args.command, ...args._];
    args.command = "";
  }
  if (commands.has(args.replace)) {
    args._ = [args.replace, ...args._];
    args.replace = "";
  }
  if (commands.has(args.packageless)) {
    args._ = [args.packageless, ...args._];
    args.packageless = true;
  }

  return args;
}

function exit(err) {
  if (err) console.info(String(err.stack || err.message || err).trim());
  doExit(err ? 1 : 0);
}

async function main() {
  const commands = new Set(["patch", "minor", "major"]);
  const args = fixArgs(commands, minimist(process.argv.slice(2), minOpts), minOpts);
  let [level, ...files] = args._;

  if (args.version) {
    console.info(version);
    exit();
  }

  if (!commands.has(level) || args.help) {
    console.info(`usage: versions [options] patch|minor|major [files...]

    Semantically increment a project's version in multiple files.

    Arguments:
     files                  Files to do version replacement in. The nearest package.json and
                            package-lock.json will always be included unless the -P argument is given
    Options:
      -a, --all             Add all changed files to the commit instead of only the ones currently modified
      -b, --base <version>  Base version to use. Default is parsed from the nearest package.json
      -C, --changelog       Generate a changelog since the base version tag or if absent, the latest tag
      -c, --command <cmd>   Run a command after files are updated but before git commit and tag
      -d, --date [<date>]   Replace dates in format YYYY-MM-DD with current or given date
      -m, --message <str>   Custom tag and commit message. Token _VER_ is available to fill the new version
      -p, --prefix          Prefix git tags with a "v" character
      -r, --replace <str>   Additional replacement in the format "s#regexp#replacement#flags"
      -g, --gitless         Do not perform any git action like creating commit and tag
      -G, --globless        Do not process globs in the file arguments
      -P, --packageless     Do not include package.json and package-lock.json unless explicitely given
      -v, --version         Print the version
      -h, --help            Print this help

    Examples:
      $ versions patch
      $ versions -Cc 'npm run build' -m 'Release _VER_' minor file.css`);
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

  const gitDir = find(".git", pwd);
  let projectRoot = gitDir ? dirname(gitDir) : null;
  const packageFile = find("package.json", pwd, projectRoot);
  const pyprojectFile = find("pyproject.toml", pwd, projectRoot);

  if (!projectRoot) {
    if (packageFile) {
      projectRoot = dirname(packageFile);
    } else if (pyprojectFile) {
      projectRoot = dirname(pyprojectFile);
    } else {
      projectRoot = pwd;
    }
  }

  // obtain old version
  let baseVersion, pkgStr;
  if (!args.base) {
    if (packageFile) {
      try {
        pkgStr = readFileSync(packageFile, "utf8");
        baseVersion = JSON.parse(pkgStr)?.version;
      } catch (err) {
        throw new Error(`Error reading ${packageFile}: ${err.message}`);
      }
    }
    if (!baseVersion && pyprojectFile) {
      try {
        baseVersion = parseToml(readFileSync(pyprojectFile, "utf8"))?.tool?.poetry?.version;
      } catch (err) {
        throw new Error(`Error reading ${pyprojectFile}: ${err.message}`);
      }
    }

    if (!baseVersion) {
      throw new Error(`Unable to obtain base version from existing files`);
    }
  } else {
    baseVersion = args.base;
  }

  // validate old version
  if (!isSemver(baseVersion)) {
    throw new Error(`Invalid base version: ${baseVersion}`);
  }

  // de-glob files args which is useful when not spawned via a shell
  if (!args.globless) {
    files = fastGlobSync(files);
  }

  // remove duplicate paths
  files = Array.from(new Set(files));

  if (!args.packageless) {
    // include package.json if present
    if (packageFile && !files.includes(packageFile)) {
      files.push(packageFile);
    }

    // include package-lock.json if present
    const packageLockFile = await find("package-lock.json", dirname(packageFile), projectRoot);
    if (packageLockFile && !files.includes(packageLockFile)) {
      files.push(packageLockFile);
    }
  }

  // convert paths to relative
  files = await Promise.all(files.map(file => relative(pwd, file)));

  if (!files.length) {
    throw new Error(`Found no files to do replacements in`);
  }

  // verify files exist
  for (const file of files) {
    const stats = statSync(file);
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new Error(`${file} is not a file`);
    }
  }

  // update files
  const newVersion = incrementSemver(baseVersion, level);
  for (const file of files) {
    if (basename(file) === "package.json") {
      updateFile({file, baseVersion, newVersion, replacements, pkgStr, date});
    } else {
      updateFile({file, baseVersion, newVersion, replacements, date});
    }
  }

  if (args.command) {
    await run(args.command);
  }

  if (!args["gitless"]) {
    const messages = parseMixedArg(args.message);

    const tagName = args["prefix"] ? `v${newVersion}` : newVersion;
    const msgs = [];

    if (messages) {
      msgs.push(messages.map(message => `${message.replace(/_VER_/gm, newVersion)}`));
    }

    let changelog = "";
    if (args.changelog) {
      const ref = tagName;
      let range;

      // check if base tag exists
      try {
        await run(["git", "show", ref], {silent: true});
        range = `${ref}..HEAD`;
      } catch {}

      // check if we have any previous tag
      if (!range) {
        try {
          const {stdout} = await run(["git", "describe", "--abbrev=0"], {silent: true});
          range = `${stdout}..HEAD`;
        } catch {}
      }

      // use the whole log (for cases where it's the first release)
      if (!range) {
        range = "";
      }

      try {
        const args = ["git", "log"];
        if (range) args.push(range);
        const {stdout} = await run([...args, `--pretty=format:* %s (%an)`], {silent: true});
        if (stdout?.length) {
          changelog = stdout;
        }
      } catch {}
    }

    const commitMsgs = [tagName, ...msgs];
    const commitMsg = commitMsgs.join("\n\n") + (changelog ? `\n\n${changelog}` : ``);

    if (args.all) {
      await run(["git", "commit", "-a", "-F", "-"], {input: commitMsg});
    } else {
      const filesToAdd = await removeIgnoredFiles(files);
      if (filesToAdd.length) {
        await run(["git", "add", ...filesToAdd]);
        await run(["git", "commit", "-F", "-"], {input: commitMsg});
      } else {
        await run(["git", "commit", "--allow-empty", "-F", "-"], {input: commitMsg});
      }
    }

    const tagMsgs = msgs.length ? msgs : [];
    const tagMsg = tagMsgs.join("\n\n") + (changelog ? `\n\n${changelog}` : ``);
    await run(["git", "tag", "-f", "-F", "-", tagName], {input: tagMsg});
  }

  exit();
}

main().then(exit).catch(exit);
