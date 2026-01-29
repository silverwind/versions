#!/usr/bin/env node
import nanoSpawn, {SubprocessError, type Result} from "nano-spawn";
import {parseArgs} from "node:util";
import {basename, dirname, join, relative} from "node:path";
import {cwd, exit, stdout} from "node:process";
import {EOL, platform} from "node:os";
import {readFileSync, writeFileSync, accessSync, truncateSync, statSync} from "node:fs";
import pkg from "./package.json" with {type: "json"};
import {parse} from "smol-toml";

export type SemverLevel = "patch" | "minor" | "major";

function esc(str: string): string {
  return str.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function isSemver(str: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(str.replace(/^v/, ""));
}

function uniq<T extends Array<any>>(arr: T): T {
  return Array.from(new Set(arr)) as T;
}

function replaceTokens(str: string, newVersion: string): string {
  const [major, minor, patch] = newVersion.split(".");
  return str
    .replace(/_VER_/g, newVersion)
    .replace(/_MAJOR_/g, major)
    .replace(/_MINOR_/g, minor)
    .replace(/_PATCH_/g, patch);
}

function incrementSemver(str: string, level: string): string {
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
      return pkg.version.replace(/^v/, "");
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
      return toml.project.version.replace(/^v/, "");
    }

    // Try tool.poetry.version (Poetry style)
    if (toml.tool?.poetry?.version && isSemver(toml.tool.poetry.version)) {
      return toml.tool.poetry.version.replace(/^v/, "");
    }
  } catch {}

  return null;
}

async function removeIgnoredFiles(files: Array<string>): Promise<Array<string>> {
  let result: Result;
  try {
    result = await nanoSpawn("git", ["check-ignore", "--", ...files]);
  } catch {
    return files;
  }
  const ignoredFiles = new Set<string>(result.stdout.split(/\r?\n/));
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
    // Parse JSON to safely update only the top-level version field,
    // avoiding accidental replacement of nested version fields or version
    // strings in dependency specifications.
    const pkg = JSON.parse(oldData);
    if (pkg.version) pkg.version = newVersion;
    newData = `${JSON.stringify(pkg, null, 2)}\n`;
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
  const commands = new Set(["patch", "minor", "major"]);
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
    console.info(`usage: versions [options] patch|minor|major [files...]

  Options:
    -a, --all             Add all changed files to the commit
    -b, --base <version>  Base version. Default is from latest git tag, package.json, pyproject.toml, or 0.0.0
    -p, --prefix          Prefix version string with a "v" character. Default is none
    -c, --command <cmd>   Run command after files are updated but before git commit and tag
    -d, --date            Replace dates in format YYYY-MM-DD with current date
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
        ({stdout} = await nanoSpawn("git", ["tag", "--list", "--sort=-creatordate"]));
      } catch {}
      for (const tag of stdout.split(/\r?\n/).map(v => v.trim()).filter(Boolean)) {
        if (isSemver(tag)) {
          baseVersion = tag.replace(/^v/, "");
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

  // set new version
  const newVersion = incrementSemver(baseVersion, level);

  const replacements: Array<{re: RegExp, replacement: string}> = [];
  if (args.replace?.length) {
    const replace = args.replace.filter(arg => typeof arg === "string");
    for (const replaceStr of replace) {
      let [_, re, replacement, flags] = (/^s#(.+?)#(.+?)#(.*)$/.exec(replaceStr) || []);

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
    writeResult(await nanoSpawn(args.command, [], {shell: true}));
  }
  if (args.gitless) return; // nothing else to do

  const msgs = (args.message || []).filter(msg => typeof msg === "string");
  const tagName = args["prefix"] ? `v${newVersion}` : newVersion;

  // check if base tag exists
  let range = "";
  try {
    await nanoSpawn("git", ["show", tagName]);
    range = `${tagName}..HEAD`;
  } catch {}

  // check if we have any previous tag
  if (!range) {
    try {
      const {stdout} = await nanoSpawn("git", ["describe", "--abbrev=0"]);
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
    const {stdout} = await nanoSpawn("git", [...args, `--pretty=format:* %s (%aN)`]);
    if (stdout?.length) changelog = stdout;
  } catch {}

  if (args.dry) {
    return console.info(`Would create new tag and commit: ${tagName}`);
  }

  // create commit
  const commitMsg = joinStrings([tagName, ...msgs, changelog], "\n\n");
  if (args.all) {
    writeResult(await nanoSpawn("git", ["commit", "-a", "--allow-empty", "-F", "-"], {stdin: {string: commitMsg}}));
  } else {
    const filesToAdd = await removeIgnoredFiles(files);
    if (filesToAdd.length) {
      writeResult(await nanoSpawn("git", ["add", ...filesToAdd]));
      writeResult(await nanoSpawn("git", ["commit", "-F", "-"], {stdin: {string: commitMsg}}));
    } else {
      writeResult(await nanoSpawn("git", ["commit", "--allow-empty", "-F", "-"], {stdin: {string: commitMsg}}));
    }
  }

  // create tag
  const tagMsg = joinStrings([...msgs, changelog], "\n\n");
  // adding explicit -a here seems to make git no longer sign the tag
  writeResult(await nanoSpawn("git", ["tag", "-f", "-F", "-", tagName], {stdin: {string: tagMsg}}));
}

main().then(end).catch(end);
