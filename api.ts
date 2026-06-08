import {type Result, colorize, detectEol, exec, logVerbose, reNewline, replaceJsonVersion, tomlGetString, tomlReplaceFirst} from "./utils.ts";
import {basename, dirname, join} from "node:path";
import {platform, stdout} from "node:process";
import {readFileSync, writeFileSync, accessSync, truncateSync} from "node:fs";

export type SemverLevel = "patch" | "minor" | "major" | "prerelease";

const EOL = platform === "win32" ? "\r\n" : "\n";
const reEscapeChars = /[|\\{}()[\]^$+*?.-]/g;
const reSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const rePrereleaseVersion = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?/;
const rePrereleaseIdNum = /^([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)\.(\d+)$/;
const reDatePattern = /(?<=[^0-9]|^)[0-9]{4}-[0-9]{2}-[0-9]{2}(?=[^0-9]|$)/g;
const reDate = new RegExp(reDatePattern.source);
const pyprojectSections: readonly string[] = ["project", "tool.poetry"];
const handledLockfiles = new Set(["package-lock.json", "uv.lock"]);
const reLockfileName = /(?:^|[.-])lock/i;

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
    if (idNum && (idNum[1] === preid || idNum[1].startsWith(`${preid}.`))) {
      return `${major}.${minor}.${patch}-${idNum[1]}.${Number(idNum[2]) + 1}`;
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

function pyprojectGet(content: string, key: string): string | undefined {
  for (const section of pyprojectSections) {
    const v = tomlGetString(content, section, key);
    if (v) return v;
  }
  return undefined;
}

export function readVersionFromPyprojectToml(projectRoot: string): string | null {
  return readVersionFile("pyproject.toml", projectRoot, content => pyprojectGet(content, "version"));
}

type BaseVersion = {baseVersion: string, baseSource: string, describeTag: string};

export async function resolveBaseVersion(base: string | undefined, gitless: boolean, projectRoot: string): Promise<BaseVersion> {
  if (base) {
    if (!isSemver(base)) throw new Error(`Invalid base version: ${base}`);
    return {baseVersion: stripV(base), baseSource: "--base", describeTag: ""};
  }

  let describeTag = "";
  if (!gitless) {
    try {
      const {stdout} = await exec("git", ["describe", "--tags", "--abbrev=0"]);
      describeTag = stdout.trim();
      if (isSemver(describeTag)) {
        return {baseVersion: stripV(describeTag), baseSource: "git describe", describeTag};
      }
    } catch {}

    try {
      const {stdout} = await exec("git", ["tag", "--list", "--sort=-creatordate"]);
      const tag = stdout.split(reNewline).map(v => v.trim()).find(t => t && isSemver(t));
      if (tag) return {baseVersion: stripV(tag), baseSource: "git tag list", describeTag};
    } catch {}
  }

  const pkgVer = readVersionFromPackageJson(projectRoot);
  if (pkgVer) return {baseVersion: pkgVer, baseSource: "package.json", describeTag};

  const pyVer = readVersionFromPyprojectToml(projectRoot);
  if (pyVer) return {baseVersion: pyVer, baseSource: "pyproject.toml", describeTag};

  if (!gitless) return {baseVersion: "0.0.0", baseSource: "default", describeTag};
  return {baseVersion: "", baseSource: "", describeTag};
}

const reHeading = /^(#+)\s+(.*?)\s*$/;
// Three groups of 2-4 chars from Y/M/D/X/? separated by `-`, `/`, `.`, or whitespace.
// Covers YYYY-MM-DD, xxxx-xx-xx, ????-??-??, DD-MM-YYYY, YYYY/MM/DD etc.
const rePlaceholderDate = /[YMDX?]{2,4}[-/. ][YMDX?]{2,4}[-/. ][YMDX?]{2,4}/i;

function findVersionHeading(lines: string[], version: string): {index: number, level: number} | null {
  // Non-version-char boundaries so "1.2.3" doesn't match "1.2.30" or "1.2.3-rc.1".
  const re = new RegExp(`(?:^|[^\\d.\\-])v?${esc(stripV(version))}(?:[^\\d.\\-]|$)`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = reHeading.exec(lines[i]);
    if (m && re.test(m[2])) return {index: i, level: m[1].length};
  }
  return null;
}

function extractEntry(lines: string[], head: {index: number, level: number}): string | null {
  let end = lines.length;
  for (let i = head.index + 1; i < lines.length; i++) {
    const m = reHeading.exec(lines[i]);
    if (m && m[1].length <= head.level) {
      end = i;
      break;
    }
  }
  return lines.slice(head.index + 1, end).join("\n").trim() || null;
}

function updateHeadingDateInLines(lines: string[], index: number, date: string, eol: string): string | null {
  const heading = lines[index];
  if (rePlaceholderDate.test(heading)) {
    lines[index] = heading.replace(rePlaceholderDate, date);
  } else if (reDate.test(heading)) {
    return null;
  } else {
    lines[index] = `${heading.trimEnd()} - ${date}`;
  }
  return lines.join(eol);
}

// Lenient about heading shape: matches "# 1.2.3", "## v1.2.3", "## [1.2.3]",
// "## [1.2.3] - 2024-01-15", "## 1.2.3 (2024-01-15)", etc.
export function readChangelogEntry(content: string, version: string): string | null {
  const lines = content.split(reNewline);
  const head = findVersionHeading(lines, version);
  return head ? extractEntry(lines, head) : null;
}

export function updateChangelogHeadingDate(content: string, version: string, date: string): string | null {
  const lines = content.split(reNewline);
  const head = findVersionHeading(lines, version);
  return head ? updateHeadingDateInLines(lines, head.index, date, detectEol(content)) : null;
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

export function getFileChanges({file, baseVersion, newVersion, replacements, date}: GetFileChangesOpts): [string | null, string | null] {
  const fileName = basename(file);

  // unhandled lockfiles: blind search-and-replace would corrupt dependency versions
  if (!handledLockfiles.has(fileName) && (reLockfileName.test(fileName) || fileName === "go.sum")) {
    return [null, null];
  }

  const oldData = readFileSync(file, "utf8");

  let newData: string;
  if (fileName === "package.json") {
    newData = replaceJsonVersion(oldData, newVersion);
  } else if (fileName === "package-lock.json") {
    // regex replace would corrupt nested dependency versions
    const lockFile = JSON.parse(oldData);
    if (lockFile.version) lockFile.version = newVersion; // v1 and v2
    if (lockFile?.packages?.[""]?.version) lockFile.packages[""].version = newVersion; // v2 and v3
    newData = `${JSON.stringify(lockFile, null, 2)}\n`;
  } else if (fileName === "pyproject.toml") {
    // scope to [project] / [tool.poetry] — other sections may have unrelated `version` keys
    const versionLine = /^(version\s*=\s*["'])\d+\.\d+\.\d+(?:[^"'\d][^"']*)?(["'].*)$/;
    newData = tomlReplaceFirst(oldData, pyprojectSections, versionLine, `$1${newVersion}$2`);
  } else if (fileName === "uv.lock") {
    const projStr = readFileSync(file.replace(/uv\.lock$/, "pyproject.toml"), "utf8");
    const name = pyprojectGet(projStr, "name");
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

  return [newData, oldData];
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

function envTokens(names: string[]): string[] {
  return Array.from(new Set(names.map(n => process.env[n]).filter(Boolean) as string[]));
}

export async function getGithubTokens(): Promise<string[]> {
  const tokens = envTokens(["VERSIONS_FORGE_TOKEN", "GITHUB_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"]);
  try {
    const {stdout} = await exec("gh", ["auth", "token"]);
    const t = stdout.trim();
    if (t && !tokens.includes(t)) tokens.push(t);
  } catch {}
  return tokens;
}

export function getGiteaTokens(): string[] {
  return envTokens(["VERSIONS_FORGE_TOKEN", "GITEA_API_TOKEN", "GITEA_AUTH_TOKEN", "GITEA_TOKEN"]);
}

export function forgeName(repoInfo: RepoInfo): "GitHub" | "Gitea" {
  return repoInfo.type === "github" ? "GitHub" : "Gitea";
}

export async function getForgeTokens(repoInfo: RepoInfo): Promise<string[]> {
  return repoInfo.type === "github" ? getGithubTokens() : getGiteaTokens();
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

async function forgeFetch(method: string, url: string, authHeader: string, label: string, jsonBody?: string): Promise<Response> {
  logVerbose(`${colorize(method, "magenta")} ${url}`);
  const headers: Record<string, string> = jsonBody !== undefined ?
    {Authorization: authHeader, "Content-Type": "application/json"} :
    {Authorization: authHeader};
  let response: Response;
  try {
    response = await fetch(url, {method, headers, body: jsonBody});
  } catch (err: any) {
    throw new Error(`${label}: ${err.cause?.message || err.message || "Unknown error"}`);
  }
  logVerbose(`${colorize(String(response.status), response.ok ? "green" : "red")} ${url}`);
  return response;
}

// Thrown by attempt callbacks of withTokens to signal that the next token should be tried.
class AuthRetryable extends Error {}

function authOrError(status: number, message: string): Error {
  return status === 401 || status === 403 ? new AuthRetryable(message) : new Error(message);
}

function forgeApiBase(repoInfo: RepoInfo): string {
  const host = repoInfo.type === "github" ? "api.github.com" : `${repoInfo.host}/api/v1`;
  return `https://${host}/repos/${repoInfo.owner}/${repoInfo.repo}`;
}

async function ensureOk(response: Response, label: string, allow404 = false): Promise<void> {
  if (response.ok || (allow404 && response.status === 404)) return;
  throw authOrError(response.status, `${label}: ${response.status} ${response.statusText}\n${await response.text()}`);
}

async function withTokens<T>(
  isGithub: boolean,
  tokens: string[],
  attempt: (authHeader: string) => Promise<T>,
): Promise<T> {
  let lastError: Error | undefined;
  for (const token of tokens) {
    const authHeader = isGithub ? `Bearer ${token}` : `token ${token}`;
    try {
      return await attempt(authHeader);
    } catch (err: any) {
      if (!(err instanceof AuthRetryable)) throw err;
      lastError = err;
      logVerbose(`auth failed, trying next token`);
    }
  }
  throw lastError ?? new Error("No tokens provided");
}

async function deleteMatchingDrafts(apiUrl: string, authHeader: string, tagName: string): Promise<number> {
  const listLabel = "Failed to list releases";
  const listResponse = await forgeFetch("GET", `${apiUrl}?draft=true&limit=50&per_page=100`, authHeader, listLabel);
  await ensureOk(listResponse, listLabel);
  const releases = await listResponse.json() as Array<{id: number; tag_name: string; draft: boolean}>;
  const drafts = releases.filter(r => r.draft && r.tag_name === tagName);
  for (const draft of drafts) {
    const label = `Failed to delete draft release ${draft.id}`;
    const deleteResponse = await forgeFetch("DELETE", `${apiUrl}/${draft.id}`, authHeader, label);
    await ensureOk(deleteResponse, label, true);
    console.info(`Deleted stale draft release for ${tagName}`);
  }
  return drafts.length;
}

export type CreatedRelease = {id: number; html_url?: string};

export async function deleteForgeRelease(repoInfo: RepoInfo, releaseId: number, tokens: string[]): Promise<void> {
  const url = `${forgeApiBase(repoInfo)}/releases/${releaseId}`;
  const label = `Failed to delete release ${releaseId}`;

  await withTokens(repoInfo.type === "github", tokens, async (authHeader) => {
    const response = await forgeFetch("DELETE", url, authHeader, label);
    await ensureOk(response, label, true);
  });
}

export async function createForgeRelease(repoInfo: RepoInfo, tagName: string, body: string, tokens: string[]): Promise<CreatedRelease | null> {
  const apiUrl = `${forgeApiBase(repoInfo)}/releases`;
  const label = "Failed to create release";
  const releaseBody = JSON.stringify({
    tag_name: tagName,
    name: tagName,
    body,
    draft: false,
    prerelease: tagName.includes("-"),
  });

  const post = (authHeader: string) => forgeFetch("POST", apiUrl, authHeader, label, releaseBody);

  return withTokens(repoInfo.type === "github", tokens, async (authHeader) => {
    let response = await post(authHeader);

    // Stale draft for the same tag blocks creation: Gitea returns 409 "Release is has no Tag",
    // GitHub returns 422 "already_exists". Clean up matching drafts and retry once.
    if (response.status === 409 || response.status === 422) {
      const cleaned = await deleteMatchingDrafts(apiUrl, authHeader, tagName);
      if (cleaned > 0) response = await post(authHeader);
    }

    await ensureOk(response, label);
    const result = await response.json();
    console.info(result.html_url ? `Created release: ${result.html_url}` : "Created release");
    return typeof result.id === "number" ? {id: result.id, html_url: result.html_url} : null;
  });
}

export function writeResult(result: Result): void {
  for (const s of [result.stdout, result.stderr]) {
    if (s) stdout.write(`${s}${EOL}`);
  }
}

type RemoteState = {branch: string | null; tag: string | null};

// ls-remote needs the push URL explicitly: the default fetch URL can differ from the push URL.
export async function probeRemote(pushRemote: string, branchRef: string, tagRef: string): Promise<RemoteState | null> {
  try {
    const {stdout: pushUrl} = await exec("git", ["remote", "get-url", "--push", pushRemote]);
    const {stdout} = await exec("git", ["ls-remote", pushUrl.trim(), branchRef, tagRef]);
    let branch: string | null = null, tag: string | null = null;
    for (const line of stdout.split(reNewline)) {
      const [oid, ref] = line.split(/\s+/);
      if (ref === branchRef) branch = oid;
      else if (ref === tagRef) tag = oid;
    }
    return {branch, tag};
  } catch {
    return null;
  }
}

// Authenticated GET on the forge repo endpoint — verifies host reachability, token validity,
// and (where the forge exposes it) the token's push permission. Catches the common failure
// modes before the push so create-release after a successful push is unlikely to fail.
export async function pingForge(repoInfo: RepoInfo, tokens: string[]): Promise<string | null> {
  const url = forgeApiBase(repoInfo);
  const label = "forge ping";
  try {
    await withTokens(repoInfo.type === "github", tokens, async (authHeader) => {
      const response = await forgeFetch("GET", url, authHeader, label);
      // Both GitHub and Gitea return 404 (not 403) for private repos when the token
      // lacks read access, to avoid leaking repo existence; treat it like 401/403 so
      // withTokens falls through to the next token.
      if (response.status === 404) {
        throw new AuthRetryable(`${label}: 404 (token may lack access to ${repoInfo.owner}/${repoInfo.repo})`);
      }
      await ensureOk(response, label);
      // Both GitHub and Gitea return `permissions: {push, admin, pull, ...}` on authenticated
      // repo GETs. If the field is present and push/admin are both false, release creation
      // will 403 — abort now rather than after the push has landed. Throw `AuthRetryable`
      // so `withTokens` falls through to the next token: a different token may have push.
      const body = await response.json().catch(() => null);
      const perms = body?.permissions;
      if (perms && perms.push !== true && perms.admin !== true) {
        throw new AuthRetryable(`${label}: token lacks push permission on ${repoInfo.owner}/${repoInfo.repo}`);
      }
    });
    return null;
  } catch (err: any) {
    return err?.message || "unknown error";
  }
}
