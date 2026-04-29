#!/usr/bin/env node
import {SubprocessError, type Result, colorize, exec, logVerbose, reNewline, setVerbose, tomlGetString} from "./utils.ts";
import {parseArgs} from "node:util";
import {basename, dirname, join, relative, resolve} from "node:path";
import {cwd, exit, platform, stdout} from "node:process";
import {readFileSync, writeFileSync, accessSync, truncateSync} from "node:fs";
import pkg from "./package.json" with {type: "json"};

export type SemverLevel = "patch" | "minor" | "major" | "prerelease";

const EOL = platform === "win32" ? "\r\n" : "\n";
const reEscapeChars = /[|\\{}()[\]^$+*?.-]/g;
const reSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const rePrereleaseVersion = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?/;
const rePrereleaseIdNum = /^([a-zA-Z0-9-]+)\.(\d+)$/;
const reDatePattern = /(?<=[^0-9]|^)[0-9]{4}-[0-9]{2}-[0-9]{2}(?=[^0-9]|$)/g;
const reReplaceString = /^s#([^#]+)#([^#]+)#(.*)$/;

function stripV(str: string): string {
  return str[0] === "v" ? str.slice(1) : str;
}

export function esc(str: string): string {
  return str.replace(reEscapeChars, "\\$&");
}

export function isSemver(str: string): boolean {
  return reSemver.test(stripV(str));
}

export function replaceTokens(str: string, newVersion: string): string {
  const [major, minor, patch] = newVersion.split(".");
  return str
    .replaceAll("_VER_", newVersion)
    .replaceAll("_MAJOR_", major)
    .replaceAll("_MINOR_", minor)
    .replaceAll("_PATCH_", patch);
}

export function incrementSemver(str: string, level: string, preid?: string): string {
  if (!isSemver(str)) throw new Error(`Invalid semver: ${str}`);
  const [, majStr, minStr, patStr, prerelease] = rePrereleaseVersion.exec(stripV(str))!;
  const major = Number(majStr), minor = Number(minStr), patch = Number(patStr);
  const tail = preid ? `-${preid}.0` : "";

  if (level === "major") return `${major + 1}.0.0${tail}`;
  if (level === "minor") return `${major}.${minor + 1}.0${tail}`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}${tail}`;
  if (level === "prerelease") {
    if (!preid) throw new Error("prerelease requires --preid option");
    if (!prerelease) return `${major}.${minor}.${patch + 1}-${preid}.0`;
    const idNum = rePrereleaseIdNum.exec(prerelease);
    if (idNum?.[1] === preid) {
      return `${major}.${minor}.${patch}-${preid}.${Number(idNum[2]) + 1}`;
    }
    return `${major}.${minor}.${patch}-${preid}.0`;
  }
  throw new Error(`Invalid semver level: ${level}`);
}

export function findUp(filename: string, dir: string, stopDir?: string): string | null {
  while (true) {
    const path = join(dir, filename);
    try {
      accessSync(path);
      return path;
    } catch {}
    const parent = dirname(dir);
    if ((stopDir && dir === stopDir) || parent === dir) return null;
    dir = parent;
  }
}

function readVersionFile(filename: string, dir: string, parse: (content: string) => string | undefined): string | null {
  const path = findUp(filename, dir);
  if (!path) return null;
  try {
    const v = parse(readFileSync(path, "utf8"));
    if (v && isSemver(v)) return stripV(v);
  } catch {}
  return null;
}

export function readVersionFromPackageJson(projectRoot: string): string | null {
  return readVersionFile("package.json", projectRoot, content => JSON.parse(content).version);
}

export function readVersionFromPyprojectToml(projectRoot: string): string | null {
  return readVersionFile("pyproject.toml", projectRoot, content => {
    const project = tomlGetString(content, "project", "version");
    if (project && isSemver(project)) return project;
    return tomlGetString(content, "tool.poetry", "version");
  });
}

export async function removeIgnoredFiles(files: Array<string>, cwd?: string): Promise<Array<string>> {
  let result: Result;
  try {
    result = await exec("git", ["check-ignore", "--", ...files], {cwd});
  } catch {
    return files;
  }
  const ignoredFiles = new Set<string>(result.stdout.split(reNewline));
  return files.filter(file => !ignoredFiles.has(file));
}

export type GetFileChangesOpts = {
  file: string,
  baseVersion: string,
  newVersion: string,
  replacements?: Array<{re: RegExp, replacement: string}>,
  date?: string,
};

export function getFileChanges({file, baseVersion, newVersion, replacements, date}: GetFileChangesOpts): [string, string | null, string | null] {
  const fileName = basename(file);

  // unhandled lockfiles: blind search-and-replace would corrupt dependency versions
  if ((/lock/i.test(fileName) || fileName === "go.sum") && fileName !== "package-lock.json" && fileName !== "uv.lock") {
    return [file, null, null];
  }

  const oldData = readFileSync(file, "utf8");

  let newData: string;
  if (fileName === "package.json") {
    newData = oldData.replace(/("version":[^]*?")\d+\.\d+\.\d+(?:[^"\d][^"]*)?(")/,
      (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else if (fileName === "package-lock.json") {
    // regex replace would corrupt nested dependency versions
    const lockFile = JSON.parse(oldData);
    if (lockFile.version) lockFile.version = newVersion; // v1 and v2
    if (lockFile?.packages?.[""]?.version) lockFile.packages[""].version = newVersion; // v2 and v3
    newData = `${JSON.stringify(lockFile, null, 2)}\n`;
  } else if (fileName === "pyproject.toml") {
    newData = oldData.replace(/(^version ?= ?["'])\d+\.\d+\.\d+(?:[^"'\d][^"']*)?(["'].*)/gm,
      (_, p1, p2) => `${p1}${newVersion}${p2}`);
  } else if (fileName === "uv.lock") {
    const projStr = readFileSync(file.replace(/uv\.lock$/, "pyproject.toml"), "utf8");
    const name = tomlGetString(projStr, "project", "name") ?? tomlGetString(projStr, "tool.poetry", "name");
    if (!name) throw new Error(`Could not determine project name from pyproject.toml for ${file}`);
    const re = new RegExp(`(\\[\\[package\\]\\]\r?\nname = "${esc(name)}"\r?\nversion = ").+?(")`);
    newData = oldData.replace(re, `$1${newVersion}$2`);
  } else {
    const re = new RegExp(esc(baseVersion), "g");
    newData = oldData.replace(re, newVersion);
  }

  if (date) {
    newData = newData.replace(reDatePattern, date);
  }

  if (replacements?.length) {
    for (const replacement of replacements) {
      newData = newData.replace(replacement.re, replacement.replacement);
    }
  }

  return [file, newData, oldData];
}

export function write(file: string, content: string): void {
  if (platform === "win32") {
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
export function joinStrings(strings: Array<string | undefined>, separator: string): string {
  return strings.filter(Boolean).join(separator).trim();
}

function end(err?: Error | string | void): void {
  if (!err) return exit(0);
  const msg = err instanceof SubprocessError ? `${err.message}\n${err.output}` :
    err instanceof Error ? (err.stack || err.message).trim() :
      err;
  console.error(msg);
  exit(1);
}

function envTokens(names: string[]): string[] {
  return Array.from(new Set(names.map(n => process.env[n]).filter(Boolean) as string[]));
}

export async function getGithubTokens(): Promise<string[]> {
  const tokens = new Set(envTokens(["VERSIONS_FORGE_TOKEN", "GITHUB_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"]));
  try {
    const {stdout} = await exec("gh", ["auth", "token"]);
    const t = stdout.trim();
    if (t) tokens.add(t);
  } catch {}
  return Array.from(tokens);
}

export function getGiteaTokens(): string[] {
  return envTokens(["VERSIONS_FORGE_TOKEN", "GITEA_API_TOKEN", "GITEA_AUTH_TOKEN", "GITEA_TOKEN"]);
}

export type RepoInfo = {
  owner: string;
  repo: string;
  host: string;
  type: "github" | "gitea";
};

export async function getRepoInfo(cwd?: string, remote: string = "origin"): Promise<RepoInfo | null> {
  try {
    const {stdout} = await exec("git", ["remote", "get-url", remote], {cwd});
    const url = stdout.trim();

    // Parse git URLs: https://[user[:pass]@]host/owner/repo[.git][/] or git@host:owner/repo[.git][/]
    const httpsMatch = /^https:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
    const sshMatch = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);

    const match = httpsMatch || sshMatch;
    if (match) {
      return {
        owner: match[2],
        repo: match[3],
        host: match[1],
        type: match[1] === "github.com" ? "github" : "gitea",
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function createForgeRelease(repoInfo: RepoInfo, tagName: string, body: string, tokens: string[]): Promise<void> {
  const isGithub = repoInfo.type === "github";
  const apiHost = isGithub ? "api.github.com" : `${repoInfo.host}/api/v1`;
  const apiUrl = `https://${apiHost}/repos/${repoInfo.owner}/${repoInfo.repo}/releases`;

  const releaseBody = JSON.stringify({
    tag_name: tagName,
    name: tagName,
    body,
    draft: false,
    prerelease: tagName.includes("-"),
  });

  let lastError: Error | undefined;
  for (const token of tokens) {
    let response: Response;
    logVerbose(`${colorize("POST", "magenta")} ${apiUrl}`);
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": isGithub ? `Bearer ${token}` : `token ${token}`,
        },
        body: releaseBody,
      });
    } catch (err: any) {
      throw new Error(`Failed to create release: ${err.cause?.message || err.message || "Unknown error"}`);
    }
    logVerbose(`${colorize(String(response.status), response.ok ? "green" : "red")} ${apiUrl}`);

    if (response.ok) {
      const result = await response.json();
      if (result.html_url) {
        console.info(`Created release: ${result.html_url}`);
      } else {
        console.info("Created release");
      }
      return;
    }

    const errorText = await response.text();
    lastError = new Error(`Failed to create release: ${response.status} ${response.statusText}\n${errorText}`);
    if (response.status !== 401 && response.status !== 403) throw lastError;
    logVerbose(`auth failed (${response.status}), trying next token`);
  }
  throw lastError ?? new Error("No tokens provided");
}

export function writeResult(result: Result): void {
  for (const s of [result.stdout, result.stderr]) {
    if (s) stdout.write(s.endsWith(EOL) ? s : `${s}${EOL}`);
  }
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
      prefix: {short: "p", type: "boolean"},
      version: {short: "v", type: "boolean"},
      date: {short: "d", type: "boolean"},
      release: {short: "R", type: "boolean"},
      "no-push": {short: "n", type: "boolean"},
      remote: {short: "o", type: "string"},
      branch: {short: "B", type: "string"},
      base: {short: "b", type: "string"},
      command: {short: "c", type: "string"},
      replace: {short: "r", type: "string", multiple: true},
      message: {short: "m", type: "string", multiple: true},
      preid: {short: "i", type: "string"},
      verbose: {short: "V", type: "boolean"},
    },
  });
  const args = result.values;
  let [level, ...files] = result.positionals;
  files = Array.from(new Set(files));

  setVerbose(Boolean(args.verbose));

  if (args.version) {
    console.info(pkg.version);
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
    -i, --preid <id>      Prerelease identifier, e.g., alpha, beta, rc
    -m, --message <str>   Custom tag and commit message
    -r, --replace <str>   Additional replacements in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -D, --dry             Do not create a tag or commit, just print what would be done
    -R, --release         Create a GitHub or Gitea release with the changelog as body
    -n, --no-push         Skip pushing commit and tag
    -o, --remote <name>   Git remote to push to. Default is "origin"
    -B, --branch <name>   Git branch to push. Default is the current branch
    -V, --verbose         Print verbose output to stderr
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Examples:
    $ versions patch
    $ versions prerelease --preid=alpha
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css`);
    end();
  }

  const date = args.date ? new Date().toISOString().substring(0, 10) : "";

  const pwd = cwd();
  const gitDir = findUp(".git", pwd);
  const projectRoot = gitDir ? dirname(gitDir) : pwd;
  const pushRemote = typeof args.remote === "string" ? args.remote : "origin";
  const repoInfoPromise = (!args.gitless && args.release) ? getRepoInfo(undefined, pushRemote) : null;
  const tokensPromise = repoInfoPromise?.then(info =>
    !info ? [] : info.type === "github" ? getGithubTokens() : getGiteaTokens());

  files = files.map(file => relative(pwd, file));

  if (level === "prerelease" && !args.preid) {
    throw new Error("prerelease requires --preid option");
  }
  if (args.gitless && args.release) {
    throw new Error("--gitless and --release are mutually exclusive");
  }
  if (args["no-push"] && args.release) {
    throw new Error("--no-push and --release are mutually exclusive");
  }

  const baseVersionPromise = (async (): Promise<{baseVersion: string, baseSource: string, describeTag: string}> => {
    let baseVersion = "";
    let baseSource = "";
    let describeTag = "";
    if (args.base) {
      const raw = String(args.base);
      if (!isSemver(raw)) throw new Error(`Invalid base version: ${raw}`);
      return {baseVersion: stripV(raw), baseSource: "--base", describeTag};
    }
    if (!args.gitless) {
      try {
        const result = await exec("git", ["describe", "--tags", "--abbrev=0"]);
        describeTag = result.stdout.trim();
        if (isSemver(describeTag)) {
          baseVersion = stripV(describeTag);
          baseSource = "git describe";
        }
      } catch {}
      if (!baseVersion) {
        let stdout = "";
        try {
          ({stdout} = await exec("git", ["tag", "--list", "--sort=-creatordate"]));
        } catch {}
        const tag = stdout.split(reNewline).map(v => v.trim()).find(t => t && isSemver(t));
        if (tag) {
          baseVersion = stripV(tag);
          baseSource = "git tag list";
        }
      }
    }
    if (!baseVersion) {
      baseVersion = readVersionFromPackageJson(projectRoot) || "";
      if (baseVersion) {
        baseSource = "package.json";
      } else {
        baseVersion = readVersionFromPyprojectToml(projectRoot) || "";
        if (baseVersion) baseSource = "pyproject.toml";
      }
      if (!baseVersion && !args.gitless) {
        baseVersion = "0.0.0";
        baseSource = "default";
      }
    }
    return {baseVersion, baseSource, describeTag};
  })();

  // resolve push branch early so detached HEAD fails before commit/tag
  const pushBranchPromise = (!args.gitless && !args.dry && !args["no-push"]) ? (async () => {
    if (typeof args.branch === "string") return args.branch;
    const {stdout: branchOut} = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    return branchOut.trim();
  })() : Promise.resolve("");

  const {baseVersion, baseSource, describeTag} = await baseVersionPromise;
  if (args.gitless && !baseVersion) {
    throw new Error(`--gitless requires --base to be set or a version in package.json or pyproject.toml`);
  }
  logVerbose(`base version ${baseVersion} from ${baseSource}`);

  const pushBranch = await pushBranchPromise;
  if (pushBranch === "HEAD") {
    throw new Error("Cannot push from detached HEAD. Pass --branch <name> or --no-push.");
  }

  const newVersion = incrementSemver(baseVersion, level, typeof args.preid === "string" ? args.preid : undefined);
  logVerbose(`new version ${newVersion}`);

  const replacements: Array<{re: RegExp, replacement: string}> = [];
  if (args.replace?.length) {
    const replace = args.replace.filter(arg => typeof arg === "string");
    for (const replaceStr of replace) {
      let [, re, replacement, flags] = (reReplaceString.exec(replaceStr) || []);

      if (!re || !replacement) {
        throw new Error(`Invalid replace string: ${replaceStr}`);
      }

      replacement = replaceTokens(replacement, newVersion);
      replacements.push({re: new RegExp(re, flags || undefined), replacement});
    }
  }

  const msgs = (args.message || []).filter(msg => typeof msg === "string");
  const tagName = args["prefix"] ? `v${newVersion}` : newVersion;

  const filesToAddPromise = (!args.gitless && !args.all && files.length) ? removeIgnoredFiles(files) : null;
  const changelogPromise = (!args.gitless && !args.dry) ? (async () => {
    let range = "";
    const tagExists = await exec("git", ["rev-parse", "--verify", `refs/tags/${tagName}`]).then(() => true, () => false);
    if (tagExists) {
      range = `${tagName}..HEAD`;
    } else if (describeTag) {
      range = `${describeTag}..HEAD`;
    }
    try {
      const logArgs = ["log"];
      if (range) logArgs.push(range);
      // https://git-scm.com/docs/pretty-formats
      const {stdout} = await exec("git", [...logArgs, `--pretty=format:* %s (%aN)`]);
      return stdout?.length ? stdout : undefined;
    } catch {
      return undefined;
    }
  })() : null;
  // probe remote refs in parallel with file processing and commit; ls-remote needs the push URL
  // explicitly (defaults to fetch URL, which can differ for github.com fetch + local bare push).
  const branchRef = `refs/heads/${pushBranch}`;
  const tagRef = `refs/tags/${tagName}`;
  const remoteProbePromise = (!args.gitless && !args.dry && !args["no-push"]) ? (async () => {
    try {
      const {stdout: pushUrl} = await exec("git", ["remote", "get-url", "--push", pushRemote]);
      const {stdout} = await exec("git", ["ls-remote", pushUrl.trim(), branchRef, tagRef]);
      let branch: string | null = null, tag: string | null = null;
      for (const line of stdout.split(reNewline)) {
        const [oid, ref] = line.split(/\s+/);
        if (ref === branchRef) branch = oid;
        else if (ref === tagRef) tag = oid;
      }
      return {branch, tag, ok: true as const};
    } catch {
      return {branch: null, tag: null, ok: false as const};
    }
  })() : null;

  // drained in reverse on failure to restore working tree, local refs, and remote refs
  const rollbacks: Array<() => Promise<void> | void> = [];

  try {
    if (files.length) {
      const originals = new Map<string, string>();
      rollbacks.push(() => {
        for (const [file, content] of originals) write(file, content);
      });
      for (const file of files) {
        const [filePath, newData, oldData] = getFileChanges({file, baseVersion, newVersion, replacements, date});
        if (newData !== null) {
          if (!originals.has(filePath)) originals.set(filePath, oldData!);
          logVerbose(`writing ${filePath}`);
          write(filePath, newData);
        } else {
          logVerbose(`skipping ${file} (unhandled lockfile)`);
        }
      }
    }

    if (typeof args.command === "string") {
      logVerbose(`running command: ${args.command}`);
      writeResult(await exec(args.command, [], {shell: true}));
    }
    if (args.gitless) {
      logVerbose("gitless — skipping commit, tag, and release");
      return;
    }

    if (args.dry) {
      logVerbose("dry run — skipping commit and tag");
      return console.info(`Would create new tag and commit: ${tagName}`);
    }

    const changelog = (await changelogPromise) ?? undefined;

    // preserve user's staged hunks on rollback (--soft would leave our changes staged)
    const [preIndexTreeOid, priorLocalTagOid] = await Promise.all([
      exec("git", ["write-tree"]).then(r => r.stdout.trim()).catch(() => null),
      exec("git", ["rev-parse", "--verify", tagRef]).then(r => r.stdout.trim()).catch(() => null),
    ]);

    const commitMsg = joinStrings([tagName, ...msgs, changelog], "\n\n");
    let commitArgs: string[];
    if (args.all) {
      commitArgs = ["commit", "-a", "--allow-empty", "-F", "-"];
    } else {
      const filesToAdd = (await filesToAddPromise) ?? [];
      commitArgs = filesToAdd.length ?
        ["commit", "-i", "-F", "-", "--", ...filesToAdd] :
        ["commit", "--allow-empty", "-F", "-"];
    }
    writeResult(await exec("git", commitArgs, {stdin: {string: commitMsg}}));
    rollbacks.push(async () => {
      const hasParent = await exec("git", ["rev-parse", "HEAD^"]).then(() => true, () => false);
      if (hasParent) await exec("git", ["reset", "--soft", "HEAD^"]);
      else await exec("git", ["update-ref", "-d", "HEAD"]);
      if (preIndexTreeOid) await exec("git", ["read-tree", preIndexTreeOid]);
    });

    const tagMsg = joinStrings([...msgs, changelog], "\n\n");
    // adding explicit -a here seems to make git no longer sign the tag
    writeResult(await exec("git", ["tag", "-f", "-F", "-", tagName], {stdin: {string: tagMsg}}));
    rollbacks.push(async () => {
      // update-ref preserves the prior tag's type (annotated vs lightweight); `tag -f <oid>`
      // would create a lightweight tag pointing at the prior tag-object OID.
      if (priorLocalTagOid) await exec("git", ["update-ref", tagRef, priorLocalTagOid]);
      else await exec("git", ["tag", "-d", tagName]);
    });

    if (!args["no-push"]) {
      const probe = await remoteProbePromise!;
      const headOid = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();

      writeResult(await exec("git", ["push", pushRemote, pushBranch, tagName]));

      if (probe.ok) {
        // --force-with-lease guards against concurrent pushes overwriting work
        rollbacks.push(async () => {
          if (probe.branch) {
            await exec("git", ["push", `--force-with-lease=${branchRef}:${headOid}`, pushRemote, `${probe.branch}:${branchRef}`]);
          } else {
            await exec("git", ["push", pushRemote, `:${branchRef}`]);
          }
        });
        rollbacks.push(async () => {
          if (probe.tag) {
            await exec("git", ["push", "--force", pushRemote, `${probe.tag}:${tagRef}`]);
          } else {
            await exec("git", ["push", pushRemote, `:${tagRef}`]);
          }
        });
      } else {
        // probe failed — guessing the prior remote state could destroy refs we don't own
        rollbacks.push(() => {
          console.error(`rollback skipped: could not capture remote state for ${pushRemote} before push; verify branch ${pushBranch} and tag ${tagName} manually`);
        });
      }
    }

    if (repoInfoPromise) {
      const repoInfo = await repoInfoPromise;
      if (!repoInfo) {
        throw new Error("Could not determine repository type from git remote. Only GitHub and Gitea repositories are supported for release creation.");
      }
      const forgeName = repoInfo.type === "github" ? "GitHub" : "Gitea";
      const tokens = await tokensPromise!;
      if (!tokens.length) {
        throw new Error(`${forgeName} release requested but no token found in environment`);
      }
      logVerbose(`creating ${forgeName} release for ${tagName} (${tokens.length} token${tokens.length === 1 ? "" : "s"} to try)`);
      await createForgeRelease(repoInfo, tagName, changelog || tagName, tokens);
    }
  } catch (err) {
    for (const rollback of rollbacks.reverse()) {
      try {
        await rollback();
      } catch (cleanupErr: any) {
        console.error(`rollback failed: ${cleanupErr.message}`);
      }
    }
    throw err;
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  main().then(end).catch(end);
}
