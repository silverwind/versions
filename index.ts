#!/usr/bin/env node
import {SubprocessError, type Result} from "nano-spawn";
import {spawnEnhanced} from "./utils.ts";
import {parseArgs} from "node:util";
import {basename, dirname, join, relative} from "node:path";
import {cwd, exit, stdout} from "node:process";
import {EOL, platform} from "node:os";
import {readFileSync, writeFileSync, accessSync, truncateSync, statSync} from "node:fs";
import pkg from "./package.json" with {type: "json"};
import {parse} from "smol-toml";

export type SemverLevel = "patch" | "minor" | "major" | "prerelease";

const reEscapeChars = /[|\\{}()[\]^$+*?.-]/g;
const reSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const reVersionPrefix = /^v/;
const reVerToken = /_VER_/g;
const reMajorToken = /_MAJOR_/g;
const reMinorToken = /_MINOR_/g;
const rePatchToken = /_PATCH_/g;
const reMajorVersion = /([0-9]+)\.[0-9]+\.[0-9]+(.*)/;
const reMinorVersion = /([0-9]+\.)([0-9]+)\.[0-9]+(.*)/;
const rePatchVersion = /([0-9]+\.[0-9]+\.)([0-9]+)(.*)/;
const rePrereleaseVersion = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?/;
const rePrereleaseIdNum = /^([a-zA-Z0-9-]+)\.(\d+)$/;
const reNewline = /\r?\n/;
const reDatePattern = /([^0-9]|^)[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)/g;
const reReplaceString = /^s#(.+?)#(.+?)#(.*)$/;

function esc(str: string): string {
  return str.replace(reEscapeChars, "\\$&");
}

function isSemver(str: string): boolean {
  return reSemver.test(str.replace(reVersionPrefix, ""));
}

function uniq<T extends Array<any>>(arr: T): T {
  return Array.from(new Set(arr)) as T;
}

function replaceTokens(str: string, newVersion: string): string {
  const [major, minor, patch] = newVersion.split(".");
  return str
    .replace(reVerToken, newVersion)
    .replace(reMajorToken, major)
    .replace(reMinorToken, minor)
    .replace(rePatchToken, patch);
}

function incrementSemver(str: string, level: string, preid?: string): string {
  if (!isSemver(str)) throw new Error(`Invalid semver: ${str}`);
  if (level === "major") {
    const newVer = str.replace(reMajorVersion, (_, m1) => `${Number(m1) + 1}.0.0`);
    return preid ? `${newVer}-${preid}.0` : newVer;
  }
  if (level === "minor") {
    const newVer = str.replace(reMinorVersion, (_, m1, m2) => `${m1}${Number(m2) + 1}.0`);
    return preid ? `${newVer}-${preid}.0` : newVer;
  }
  if (level === "patch") {
    const newVer = str.replace(rePatchVersion, (_, m1, m2) => `${m1}${Number(m2) + 1}`);
    return preid ? `${newVer}-${preid}.0` : newVer;
  }
  if (level === "prerelease") {
    if (!preid) throw new Error("prerelease requires --preid option");

    // Check if current version has a prerelease
    const match = rePrereleaseVersion.exec(str);
    if (!match) throw new Error(`Invalid semver: ${str}`);

    const [, major, minor, patch, prerelease] = match;

    if (!prerelease) {
      // No prerelease, increment patch and add prerelease
      return `${major}.${minor}.${Number(patch) + 1}-${preid}.0`;
    }

    // Has prerelease, check if it matches the requested preid
    const prereleaseMatch = rePrereleaseIdNum.exec(prerelease);
    if (prereleaseMatch) {
      const [, currentPreid, preNum] = prereleaseMatch;
      if (currentPreid === preid) {
        // Same preid, increment the number
        return `${major}.${minor}.${patch}-${preid}.${Number(preNum) + 1}`;
      }
    }

    // Different preid or no number, replace with new preid
    return `${major}.${minor}.${patch}-${preid}.0`;
  }
  return str.replace(rePatchVersion, (_, m1, m2, m3) => `${m1}${Number(m2) + 1}${m3}`);
}

function findUp(filename: string, dir: string, stopDir?: string): string | null {
  const path = join(dir, filename);

  try {
    accessSync(path);
    return path;
  } catch {}

  const parent = dirname(dir);
  if ((stopDir && path === stopDir) || parent === dir) {
    return null;
  } else {
    return findUp(filename, parent, stopDir);
  }
}

function readVersionFromPackageJson(projectRoot: string): string | null {
  const packageJsonPath = findUp("package.json", projectRoot);
  if (!packageJsonPath) return null;

  try {
    const content = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(content);
    if (pkg.version && isSemver(pkg.version)) {
      return pkg.version.replace(reVersionPrefix, "");
    }
  } catch {}

  return null;
}

function readVersionFromPyprojectToml(projectRoot: string): string | null {
  const pyprojectPath = findUp("pyproject.toml", projectRoot);
  if (!pyprojectPath) return null;

  try {
    const content = readFileSync(pyprojectPath, "utf8");
    const toml = parse(content) as any;

    // Try project.version first (PEP 621 style)
    if (toml.project?.version && isSemver(toml.project.version)) {
      return toml.project.version.replace(reVersionPrefix, "");
    }

    // Try tool.poetry.version (Poetry style)
    if (toml.tool?.poetry?.version && isSemver(toml.tool.poetry.version)) {
      return toml.tool.poetry.version.replace(reVersionPrefix, "");
    }
  } catch {}

  return null;
}

async function removeIgnoredFiles(files: Array<string>): Promise<Array<string>> {
  let result: Result;
  try {
    result = await spawnEnhanced("git", ["check-ignore", "--", ...files]);
  } catch {
    return files;
  }
  const ignoredFiles = new Set<string>(result.stdout.split(reNewline));
  return files.filter(file => !ignoredFiles.has(file));
}

type GetFileChangesOpts = {
  file: string,
  baseVersion: string,
  newVersion: string,
  replacements?: Array<{re: RegExp | string, replacement: string}>,
  date?: string,
};

function getFileChanges({file, baseVersion, newVersion, replacements, date}: GetFileChangesOpts): Array<string> {
  const oldData = readFileSync(file, "utf8");
  const fileName = basename(file);

  let newData: string;
  if (fileName === "package.json") {
    const re = new RegExp(`("version":[^]*?")${esc(baseVersion)}(")`);
    newData = oldData.replace(re, (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else if (fileName === "package-lock.json") {
    // special case for package-lock.json which contains a lot of version
    // strings which make regexp replacement risky.
    const lockFile = JSON.parse(oldData);
    if (lockFile.version) lockFile.version = newVersion; // v1 and v2
    if (lockFile?.packages?.[""]?.version) lockFile.packages[""].version = newVersion; // v2 and v3
    newData = `${JSON.stringify(lockFile, null, 2)}\n`;
  } else if (fileName === "pyproject.toml") {
    const re = new RegExp(`(^version ?= ?["'])${esc(baseVersion)}(["'].*)`, "gm");
    newData = oldData.replace(re, (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else if (fileName === "uv.lock") {
    // uv.lock is a tricky case because it lists all packages and the current package. we parse pyproject.toml
    // to obtain the current package name and then search for that name in uv.lock and replace the version
    // on the next line which luckily is possible because of static ordering.
    const projStr = readFileSync(file.replace(/uv\.lock$/, "pyproject.toml"), "utf8");
    const toml = parse(projStr) as {project: {name: string}};
    const name = toml.project.name;
    const re = new RegExp(`(\\[\\[package\\]\\]\r?\n.+${esc(name)}.+\r?\nversion = ").+?(")`);
    newData = oldData.replace(re, (_m, p1, p2) => `${p1}${newVersion}${p2}`);
  } else {
    const re = new RegExp(esc(baseVersion), "g");
    newData = oldData.replace(re, newVersion);
  }

  if (date) {
    const re = reDatePattern;
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

function write(file: string, content: string): void {
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

// join strings, ignoring falsy values and trimming the result
function joinStrings(strings: Array<string | undefined>, separator: string): string {
  const arr: Array<string> = [];
  for (const string of strings) {
    if (!string) continue;
    arr.push(string);
  }
  return arr.join(separator).trim();
}

function end(err?: Error | string | void): void {
  if (err instanceof SubprocessError) {
    console.info(`${err.message}\n${err.output}`);
  } else if (err instanceof Error) {
    console.info(String(err.stack || err.message || err).trim());
  } else if (err) {
    console.info(err);
  }
  exit(err ? 1 : 0);
}

function ensureEol(str: string): string {
  return str.endsWith(EOL) ? str : `${str}${EOL}`;
}

function writeResult(result: Result): void {
  if (result.stdout) stdout.write(ensureEol(result.stdout));
  if (result.stderr) stdout.write(ensureEol(result.stderr));
}

async function main(): Promise<void> {
  const commands = new Set(["patch", "minor", "major", "prerelease"]);
  const result = parseArgs({
    strict: false,
    allowPositionals: true,
    options: {
      all: {short: "a", type: "boolean"},
      dry: {short: "D", type: "boolean"},
      gitless: {short: "g", type: "boolean"},
      help: {short: "h", type: "boolean"},
      packageless: {short: "P", type: "boolean"},
      prefix: {short: "p", type: "boolean"},
      version: {short: "v", type: "boolean"},
      date: {short: "d", type: "boolean"},
      base: {short: "b", type: "string"},
      command: {short: "c", type: "string"},
      replace: {short: "r", type: "string", multiple: true},
      message: {short: "m", type: "string", multiple: true},
      preid: {short: "i", type: "string"},
    },
  });
  const args = result.values;
  let [level, ...files] = result.positionals;
  files = uniq(files);

  if (args.version) {
    console.info(pkg.version || "0.0.0");
    end();
  }

  if (!commands.has(level) || args.help) {
    console.info(`usage: versions [options] patch|minor|major|prerelease [files...]

  Options:
    -a, --all             Add all changed files to the commit
    -b, --base <version>  Base version. Default is from latest git tag, package.json, pyproject.toml, or 0.0.0
    -p, --prefix          Prefix version string with a "v" character. Default is none
    -c, --command <cmd>   Run command after files are updated but before git commit and tag
    -d, --date            Replace dates in format YYYY-MM-DD with current date
    -i, --preid <id>      Prerelease identifier, e.g., alpha, beta, rc. Can be used with any command to create a prerelease version
    -m, --message <str>   Custom tag and commit message
    -r, --replace <str>   Additional replacements in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -D, --dry             Do not create a tag or commit, just print what would be done
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Examples:
    $ versions patch
    $ versions patch --preid=alpha
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css
    $ versions prerelease --preid=alpha package.json`);
    end();
  }

  let date = "";
  if (args.date) {
    date = (new Date()).toISOString().substring(0, 10);
  }

  const pwd = cwd();
  const gitDir = findUp(".git", pwd);
  let projectRoot = gitDir ? dirname(gitDir) : null;
  if (!projectRoot) projectRoot = pwd;

  // obtain old version
  let baseVersion: string = "";
  if (!args.base) {
    let stdout: string = "";
    if (!args.gitless) {
      try {
        ({stdout} = await spawnEnhanced("git", ["tag", "--list", "--sort=-creatordate"]));
      } catch {}
      for (const tag of stdout.split(reNewline).map(v => v.trim()).filter(Boolean)) {
        if (isSemver(tag)) {
          baseVersion = tag.replace(reVersionPrefix, "");
          break;
        }
      }
    }
    if (!baseVersion) {
      // Try to get version from package.json first, then pyproject.toml as fallback
      // package.json takes precedence for JavaScript/TypeScript projects
      baseVersion = readVersionFromPackageJson(projectRoot) || readVersionFromPyprojectToml(projectRoot) || "";
      if (!baseVersion && args.gitless) {
        return end(new Error(`--gitless requires --base to be set or a version in package.json or pyproject.toml`));
      }
      if (!baseVersion) {
        baseVersion = "0.0.0";
      }
    }
  } else {
    baseVersion = String(args.base);
  }

  // chop off "v"
  if (baseVersion.startsWith("v")) baseVersion = baseVersion.substring(1);

  // validate old version
  if (!isSemver(baseVersion)) {
    throw new Error(`Invalid base version: ${baseVersion}`);
  }

  // convert paths to relative
  files = files.map(file => relative(pwd, file));

  // validate prerelease requirements
  if (level === "prerelease" && !args.preid) {
    return end(new Error("prerelease requires --preid option"));
  }

  // set new version
  const newVersion = incrementSemver(baseVersion, level, typeof args.preid === "string" ? args.preid : undefined);

  const replacements: Array<{re: RegExp, replacement: string}> = [];
  if (args.replace?.length) {
    const replace = args.replace.filter(arg => typeof arg === "string");
    for (const replaceStr of replace) {
      let [_, re, replacement, flags] = (reReplaceString.exec(replaceStr) || []);

      if (!re || !replacement) {
        end(new Error(`Invalid replace string: ${replaceStr}`));
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
    const todo: Array<Array<string>> = [];
    for (const file of files) {
      todo.push(getFileChanges({file, baseVersion, newVersion, replacements, date}));
    }

    for (const [file, newData] of todo) {
      write(file, newData);
    }
  }

  if (typeof args.command === "string") {
    writeResult(await spawnEnhanced(args.command, [], {shell: true}));
  }
  if (args.gitless) return; // nothing else to do

  const msgs = (args.message || []).filter(msg => typeof msg === "string");
  const tagName = args["prefix"] ? `v${newVersion}` : newVersion;

  // check if base tag exists
  let range = "";
  try {
    await spawnEnhanced("git", ["show", tagName]);
    range = `${tagName}..HEAD`;
  } catch {}

  // check if we have any previous tag
  if (!range) {
    try {
      const {stdout} = await spawnEnhanced("git", ["describe", "--abbrev=0"]);
      range = `${stdout}..HEAD`;
    } catch {}
  }

  // use the whole log (for cases where it's the first release)
  if (!range) range = "";

  let changelog: string | undefined;
  try {
    const args = ["log"];
    if (range) args.push(range);
    // https://git-scm.com/docs/pretty-formats
    const {stdout} = await spawnEnhanced("git", [...args, `--pretty=format:* %s (%aN)`]);
    if (stdout?.length) changelog = stdout;
  } catch {}

  if (args.dry) {
    return console.info(`Would create new tag and commit: ${tagName}`);
  }

  // create commit
  const commitMsg = joinStrings([tagName, ...msgs, changelog], "\n\n");
  if (args.all) {
    writeResult(await spawnEnhanced("git", ["commit", "-a", "--allow-empty", "-F", "-"], {stdin: {string: commitMsg}}));
  } else {
    const filesToAdd = await removeIgnoredFiles(files);
    if (filesToAdd.length) {
      writeResult(await spawnEnhanced("git", ["add", ...filesToAdd]));
      writeResult(await spawnEnhanced("git", ["commit", "-F", "-"], {stdin: {string: commitMsg}}));
    } else {
      writeResult(await spawnEnhanced("git", ["commit", "--allow-empty", "-F", "-"], {stdin: {string: commitMsg}}));
    }
  }

  // create tag
  const tagMsg = joinStrings([...msgs, changelog], "\n\n");
  // adding explicit -a here seems to make git no longer sign the tag
  writeResult(await spawnEnhanced("git", ["tag", "-f", "-F", "-", tagName], {stdin: {string: tagMsg}}));
}

main().then(end).catch(end);
