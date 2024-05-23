#!/usr/bin/env node
import {execa} from "execa";
import minimist from "minimist";
import {basename, dirname, join, relative} from "node:path";
import {cwd, exit as doExit} from "node:process";
import {platform} from "node:os";
import {readFileSync, writeFileSync, accessSync, truncateSync, statSync} from "node:fs";
import {version} from "./package.json" with {type: "json"};
import type {Opts as MinimistOpts} from "minimist";

export type SemverLevel = "patch" | "minor" | "major";

const packageVersion = version || "0.0.0";
const esc = (str: string) => str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const isSemver = (str: string) => semverRe.test(str.replace(/^v/, ""));
const pwd = cwd();

function uniq<T extends any[]>(arr: T): T {
  return Array.from(new Set(arr)) as T;
}

const minOpts: MinimistOpts = {
  boolean: [
    "a", "all",
    "D", "dry",
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
    "m", "message",
    "_",
  ],
  alias: {
    a: "all",
    b: "base",
    c: "command",
    d: "date",
    D: "dry",
    g: "gitless",
    h: "help",
    m: "message",
    p: "prefix",
    r: "replace",
    v: "version",
  }
};

function replaceTokens(str: string, newVersion: string) {
  const [major, minor, patch] = newVersion.split(".");
  return str
    .replace(/_VER_/g, newVersion)
    .replace(/_MAJOR_/g, major)
    .replace(/_MINOR_/g, minor)
    .replace(/_PATCH_/g, patch);
}

function incrementSemver(str: string, level: SemverLevel) {
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

function find(filename: string, dir: string, stopDir?: string) {
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

async function run(cmd: string | string[], {silent = false, input}: {silent?: boolean, input?: any} = {}) {
  let child;
  if (Array.isArray(cmd)) {
    const [c, ...args] = cmd;
    child = execa(c, args, {input});
  } else {
    child = execa(cmd, {shell: true, input});
  }

  if (!silent) child.stdout.pipe(process.stdout);
  if (!silent) child.stderr.pipe(process.stderr);
  return await child;
}

async function removeIgnoredFiles(files: string[]) {
  let stdout;
  try {
    ({stdout} = await run(["git", "check-ignore", "--", ...files], {silent: true}));
  } catch {
    return files;
  }
  const ignoredFiles = new Set(stdout.split(/\r?\n/));
  return files.filter(file => !ignoredFiles.has(file));
}

type GetFileChangesOpts = {
  file: string,
  baseVersion: string,
  newVersion: string,
  replacements?: {re: RegExp | string, replacement: string}[],
  date?: string,
}

function getFileChanges({file, baseVersion, newVersion, replacements, date}: GetFileChangesOpts) {
  const oldData = readFileSync(file, "utf8");
  const fileName = basename(file);

  let newData;
  if (fileName === "package.json") {
    const re = new RegExp(`("version":[^]*?")${esc(baseVersion)}(")`);
    newData = oldData.replace(re, (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else if (fileName === "package-lock.json") {
    // special case for package-lock.json which contains a lot of version
    // strings which make regexp replacement risky.
    newData = JSON.parse(oldData);
    if (newData.version) newData.version = newVersion; // v1 and v2
    if (newData?.packages?.[""]?.version) newData.packages[""].version = newVersion; // v2 and v3
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

  if (replacements?.length) {
    for (const replacement of replacements) {
      newData = newData.replace(replacement.re, replacement.replacement);
    }
  }

  if (oldData === newData) {
    throw new Error(`No replacement made in ${file} for base version ${baseVersion}`);
  } else {
    return [file, newData];
  }
}

function write(file: string, content: string) {
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

function parseMixedArg(arg: any) {
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
function fixArgs(commands: Set<string>, args: any, minOpts: MinimistOpts) {
  for (const key of Object.keys(minOpts.alias as object)) {
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

  return args;
}

// join strings, ignoring falsy values and trimming the result
function joinStrings(strings: (string | undefined)[], separator: string) {
  const arr = [];
  for (const string of strings) {
    if (!string) continue;
    arr.push(string);
  }
  return arr.join(separator).trim();
}

function exit(err?: Error | string | void) {
  if (err instanceof Error) {
    console.info(String(err.stack || err.message || err).trim());
  } else if (err) {
    console.info(err);
  }
  doExit(err ? 1 : 0);
}

async function main() {
  const commands = new Set(["patch", "minor", "major"]);
  const args = fixArgs(commands, minimist(process.argv.slice(2), minOpts), minOpts);
  let [level, ...files]: [SemverLevel, ...string[]] = args._;
  files = uniq(files);

  if (args.version) {
    console.info(packageVersion);
    exit();
  }

  if (!commands.has(level) || args.help) {
    console.info(`usage: versions [options] patch|minor|major [files...]

  Options:
    -a, --all             Add all changed files to the commit
    -b, --base <version>  Base version. Default is from latest git tag or 0.0.0
    -p, --prefix          Prefix version string with a "v" character. Default is none
    -c, --command <cmd>   Run command after files are updated but before git commit and tag
    -d, --date [<date>]   Replace dates in format YYYY-MM-DD with current or given date
    -m, --message <str>   Custom tag and commit message
    -r, --replace <str>   Additional replacements in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -D, --dry             Do not create a tag or commit, just print what would be done
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Examples:
    $ versions patch
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css`);
    exit();
  }

  let date: any = parseMixedArg(args.date);
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
  if (!projectRoot) projectRoot = pwd;

  // obtain old version
  let baseVersion;
  if (!args.base) {
    if (args.gitless) return exit(new Error(`--gitless requires --base to be set`));
    let stdout, exitCode;
    try {
      ({stdout, exitCode} = await run(["git", "tag", "--list", "--sort=-creatordate"], {silent: true}));
    } catch {}

    if (exitCode === 0) {
      for (const tag of String(stdout).split(/\r?\n/).map(v => v.trim()).filter(Boolean)) {
        if (isSemver(tag)) {
          baseVersion = tag.replace(/^v/, "");
          break;
        }
      }
    }
    if (!baseVersion) {
      baseVersion = "0.0.0";
    }
  } else {
    baseVersion = args.base;
  }

  // chop off "v"
  if (baseVersion.startsWith("v")) baseVersion = baseVersion.substring(1);

  // validate old version
  if (!isSemver(baseVersion)) {
    throw new Error(`Invalid base version: ${baseVersion}`);
  }

  // convert paths to relative
  files = await Promise.all(files.map(file => relative(pwd, file)));

  // set new version
  const newVersion = incrementSemver(baseVersion, level);

  const replacements = [];
  if (args.replace) {
    args.replace = Array.isArray(args.replace) ? args.replace : [args.replace];
    for (const replaceStr of args.replace) {
      let [_, re, replacement, flags] = (/^s#(.+?)#(.+?)#(.*)$/.exec(replaceStr) || []);

      if (!re || !replacement) {
        exit(new Error(`Invalid replace string: ${replaceStr}`));
      }

      replacement = replaceTokens(replacement, newVersion);
      replacements.push({re: new RegExp(re, flags || undefined), replacement});
    }
  }

  if (files.length) {
    // verify files exist
    for (const file of files) {
      const stats = statSync(file);
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        throw new Error(`${file} is not a file`);
      }
    }

    // update files
    const todo = [];
    for (const file of files) {
      todo.push(getFileChanges({file, baseVersion, newVersion, replacements, date}));
    }

    for (const [file, newData] of todo) {
      write(file, newData);
    }
  }

  if (args.command) await run(args.command);
  if (args.gitless) return; // nothing else to do

  const messages: string[] = parseMixedArg(args.message) as string[];
  const tagName = args["prefix"] ? `v${newVersion}` : newVersion;
  const msgs: string[] = [];

  if (messages) {
    msgs.push(...messages.map(message => replaceTokens(message, newVersion)));
  }

  // check if base tag exists
  let range;
  try {
    await run(["git", "show", tagName], {silent: true});
    range = `${tagName}..HEAD`;
  } catch {}

  // check if we have any previous tag
  if (!range) {
    try {
      const {stdout} = await run(["git", "describe", "--abbrev=0"], {silent: true});
      range = `${stdout}..HEAD`;
    } catch {}
  }

  // use the whole log (for cases where it's the first release)
  if (!range) range = "";

  let changelog: string | undefined;
  try {
    const args = ["git", "log"];
    if (range) args.push(range);
    // https://git-scm.com/docs/pretty-formats
    const {stdout} = await run([...args, `--pretty=format:* %s (%aN)`], {silent: true});
    if (stdout?.length) changelog = stdout;
  } catch {}

  if (args.dry) {
    return console.info(`Would create new tag and commit: ${tagName}`);
  }

  // create commit
  const commitMsg = joinStrings([tagName, ...msgs, changelog], "\n\n");
  if (args.all) {
    await run(["git", "commit", "-a", "--allow-empty", "-F", "-"], {input: commitMsg});
  } else {
    const filesToAdd = await removeIgnoredFiles(files);
    if (filesToAdd.length) {
      await run(["git", "add", ...filesToAdd]);
      await run(["git", "commit", "-F", "-"], {input: commitMsg});
    } else {
      await run(["git", "commit", "--allow-empty", "-F", "-"], {input: commitMsg});
    }
  }

  // create tag
  const tagMsg = joinStrings([...msgs, changelog], "\n\n");
  // adding explicit -a here seems to make git no longer sign the tag
  await run(["git", "tag", "-f", "-F", "-", tagName], {input: tagMsg});
}

main().then(exit).catch(exit);
