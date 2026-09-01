import {
  type Result, detectEol, logVerbose, reNewline, replaceJsonVersion, tomlGetString,
  tomlReplaceFirst, tryExec,
} from "./utils.ts";
import {basename, dirname, join} from "node:path";
import {Buffer} from "node:buffer";
import {env, platform, stderr, stdout} from "node:process";
import {readFileSync, writeFileSync, accessSync, existsSync, truncateSync} from "node:fs";
import {EOL} from "node:os";
import {styleText} from "node:util";

const reEscapeChars = /[|\\{}()[\]^$+*?.-]/g;
const reSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const rePrereleaseIdNum = /^([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)\.(\d+)$/;
const reDateGlobal = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;
const reDate = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/;
// scope to [project] / [tool.poetry], other sections may have unrelated `version` keys
const reTomlVersionLine = /^(\s*version\s*=\s*["'])\d+\.\d+\.\d+(?:[^"'\d][^"']*)?(["'].*)$/;
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
  const [, major, minor, patch] = reSemver.exec(stripV(newVersion))!;
  return str
    .replaceAll("_VER_", newVersion)
    .replaceAll("_MAJOR_", major)
    .replaceAll("_MINOR_", minor)
    .replaceAll("_PATCH_", patch);
}

// checked against the prerelease group, as a bare isSemver would read a `+` as build metadata
function isPrereleaseId(str: string): boolean {
  return reSemver.exec(`0.0.0-${str}`)?.[4] === str;
}

export function incrementSemver(str: string, level: string, preid?: string): string {
  const match = reSemver.exec(stripV(str));
  if (!match) throw new Error(`Invalid semver: ${str}`);
  if (preid && !isPrereleaseId(preid)) throw new Error(`Invalid prerelease identifier: ${preid}`);
  const [, majStr, minStr, patStr, prerelease] = match;
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

export function readVersionFile(filename: string, dir: string, stopDir?: string): string | null {
  const path = findUp(filename, dir, stopDir);
  if (!path) return null;
  try {
    return readDeclaredVersion(path, readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pyprojectGet(content: string, key: string): string | undefined {
  for (const section of pyprojectSections) {
    const version = tomlGetString(content, section, key);
    if (version) return version;
  }
  return undefined;
}

export function readDeclaredVersion(file: string, data: string): string | null {
  const fileName = basename(file);
  try {
    const version = fileName === "package.json" ? JSON.parse(data).version :
      fileName === "pyproject.toml" ? pyprojectGet(data, "version") :
        undefined;
    // JSON.parse yields `any`, and the semver regex would coerce e.g. ["1.2.3"]
    return typeof version === "string" && isSemver(version) ? stripV(version) : null;
  } catch {
    return null;
  }
}

// a Map, not an object: a `packageManager` naming an Object.prototype key would yield a function
const packageManagerLockfiles = new Map<string, readonly string[]>([
  ["npm", ["package-lock.json"]],
  ["pnpm", ["pnpm-lock.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["bun", ["bun.lock", "bun.lockb"]],
]);

// a packageManager pin binds the lockfile to the manifest, both belong in one commit
export function findCompanionLockfile(file: string): string | null {
  if (basename(file) !== "package.json") return null;
  let packageManager: unknown;
  try {
    packageManager = JSON.parse(readFileSync(file, "utf8")).packageManager;
  } catch {
    return null;
  }
  if (typeof packageManager !== "string") return null;
  const dir = dirname(file);
  for (const name of packageManagerLockfiles.get(packageManager.split("@")[0]) ?? []) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

type BaseVersion = {baseVersion: string, baseSource: string, baseTag?: string};

type ResolveBaseVersionOpts = {
  base?: string,
  gitless: boolean,
  lastTag: () => Promise<string>, // a thunk, so an explicit base never runs the slow `git describe`
  projectRoot: string,
  stopDir?: string,
};

export async function resolveBaseVersion({base, gitless, lastTag, projectRoot, stopDir}: ResolveBaseVersionOpts): Promise<BaseVersion> {
  if (base !== undefined) {
    if (!isSemver(base)) throw new Error(`Invalid base version: ${base}`);
    return {baseVersion: stripV(base), baseSource: "--base"};
  }

  if (!gitless) {
    const describeTag = await lastTag();
    if (isSemver(describeTag)) return {baseVersion: stripV(describeTag), baseSource: "git describe", baseTag: describeTag};

    const tagList = await tryExec("git", ["tag", "--list", "--sort=-creatordate"]);
    const tag = tagList?.split(reNewline).find(isSemver);
    if (tag) return {baseVersion: stripV(tag), baseSource: "git tag list", baseTag: tag};
  }

  for (const filename of ["package.json", "pyproject.toml"]) {
    const version = readVersionFile(filename, projectRoot, stopDir);
    if (version) return {baseVersion: version, baseSource: filename};
  }

  if (!gitless) return {baseVersion: "0.0.0", baseSource: "default"};
  return {baseVersion: "", baseSource: ""};
}

const reHeading = /^(#+)\s+(.*?)\s*$/;
// YYYY-MM-DD, xxxx-xx-xx, ????-??-??, DD-MM-YYYY, YYYY/MM/DD
const rePlaceholderDate = /[YMDX?]{2,4}[-/. ][YMDX?]{2,4}[-/. ][YMDX?]{2,4}/i;
const reLinkDefinition = /^\[[^\]]+\]:\s/;

function findVersionHeading(lines: string[], version: string): {index: number, level: number} | null {
  // non-version-char boundaries, so "1.2.3" does not match "1.2.30" or "1.2.3-rc.1"
  const re = new RegExp(`(?<![\\d.-])v?${esc(stripV(version))}(?![\\d.-])`, "i");
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
  const entry = lines.slice(head.index + 1, end);
  // Keep a Changelog trails link definitions below every section, the last entry would swallow them
  while (entry.length && (reLinkDefinition.test(entry.at(-1)!) || !entry.at(-1)!.trim())) entry.pop();
  return entry.join("\n").trim() || null;
}

export function readChangelogEntry(content: string, version: string): string | null {
  const lines = content.split(reNewline);
  const head = findVersionHeading(lines, version);
  return head ? extractEntry(lines, head) : null;
}

function updateChangelogHeadingDateInLines(lines: string[], head: {index: number}, date: string, content: string): string | null {
  const heading = lines[head.index];
  if (rePlaceholderDate.test(heading)) {
    lines[head.index] = heading.replace(rePlaceholderDate, date);
  } else if (reDate.test(heading)) {
    return null; // already dated
  } else {
    lines[head.index] = `${heading.trimEnd()} - ${date}`;
  }
  return lines.join(detectEol(content));
}

export function updateChangelogHeadingDate(content: string, version: string, date: string): string | null {
  const lines = content.split(reNewline);
  const head = findVersionHeading(lines, version);
  return head ? updateChangelogHeadingDateInLines(lines, head, date, content) : null;
}

export function processChangelog(content: string, version: string, date: string): {entry: string, updated: string | null} | null {
  const lines = content.split(reNewline);
  const head = findVersionHeading(lines, version);
  if (!head) return null;
  const entry = extractEntry(lines, head);
  return entry ? {entry, updated: updateChangelogHeadingDateInLines(lines, head, date, content)} : null;
}

export async function removeIgnoredFiles(files: Array<string>, cwd?: string): Promise<Array<string>> {
  // check-ignore exits 1 when nothing is ignored and 128 on error, both meaning "keep everything"
  const ignored = await tryExec("git", ["check-ignore", "--", ...files], {cwd});
  if (!ignored) return files;
  const ignoredFiles = new Set<string>(ignored.split(reNewline));
  return files.filter(file => !ignoredFiles.has(file));
}

type GetFileChangesOpts = {
  file: string,
  baseVersion: string,
  newVersion: string,
  replacements?: Array<{re: RegExp, replacement: string}>,
  date?: string,
};

type FileChanges = {newData: string, oldData: string};

export function getFileChanges({file, baseVersion, newVersion, replacements, date}: GetFileChangesOpts): FileChanges | null {
  const fileName = basename(file);

  // unhandled lockfiles: blind search-and-replace would corrupt dependency versions
  if (!handledLockfiles.has(fileName) && (reLockfileName.test(fileName) || fileName === "go.sum")) {
    return null;
  }

  const oldData = readFileSync(file, "utf8");

  let newData: string;
  if (fileName === "package.json") {
    newData = replaceJsonVersion(oldData, newVersion);
  } else if (fileName === "package-lock.json") {
    const lockFile = JSON.parse(oldData); // regex replace would hit nested dependency versions
    if (lockFile.version) lockFile.version = newVersion; // v1 and v2
    if (lockFile.packages?.[""]?.version) lockFile.packages[""].version = newVersion; // v2 and v3
    newData = `${JSON.stringify(lockFile, null, 2)}\n`;
  } else if (fileName === "pyproject.toml") {
    newData = tomlReplaceFirst(oldData, pyprojectSections, reTomlVersionLine, `$1${newVersion}$2`);
  } else if (fileName === "uv.lock") {
    const projStr = readFileSync(join(dirname(file), "pyproject.toml"), "utf8");
    const name = pyprojectGet(projStr, "name");
    if (!name) throw new Error(`Could not determine project name from pyproject.toml for ${file}`);
    const re = new RegExp(`(\\[\\[package\\]\\]\r?\nname = "${esc(name)}"\r?\nversion = ").+?(")`);
    newData = oldData.replace(re, `$1${newVersion}$2`);
  } else {
    newData = oldData.replaceAll(baseVersion, newVersion);
  }

  if (date) {
    newData = newData.replace(reDateGlobal, date);
  }

  for (const replacement of replacements ?? []) {
    newData = newData.replace(replacement.re, replacement.replacement);
  }

  return {newData, oldData};
}

export function write(file: string, content: string): void {
  if (platform === "win32") {
    try {
      truncateSync(file);
      writeFileSync(file, content, {flag: "r+"});
      return;
    } catch {}
  }
  writeFileSync(file, content);
}

export function joinStrings(strings: Array<string | undefined>, separator: string): string {
  return strings.filter(Boolean).join(separator).trim();
}

export const githubTokenEnvNames = ["VERSIONS_GITHUB_API_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"];
export const giteaTokenEnvNames = ["VERSIONS_GITEA_API_TOKEN", "GITEA_API_TOKEN", "GITEA_AUTH_TOKEN", "GITEA_TOKEN", "FORGEJO_TOKEN"];

function envTokens(names: string[]): string[] {
  return Array.from(new Set(names.map(name => env[name]).filter(Boolean) as string[]));
}

function urlHost(url = ""): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// host may carry a port, so the last colon separates host from token
function pairToken(host: string): string | null {
  for (const entry of (env.VERSIONS_FORGE_TOKENS ?? "").split(",").map(pair => pair.trim())) {
    const sep = entry.lastIndexOf(":");
    if (sep > 0 && entry.slice(0, sep).toLowerCase() === host) return entry.slice(sep + 1);
  }
  return null;
}

const probeTimeout = 5000;
const reExtraheader = /^http\.(\S+)\/\.extraheader AUTHORIZATION:\s*basic\s+(\S+)$/i;

// actions/checkout leaves the CI token in `http.<origin>/.extraheader`, base64 of
// `x-access-token:<token>`. `--local` misses it, the credentials file arrives via includeIf.
async function extraheaderToken(host: string, cwd?: string): Promise<string | null> {
  const config = await tryExec("git", ["config", "--get-regexp", "^http\\..*\\.extraheader$"], {cwd, timeout: probeTimeout});
  for (const line of config?.split(reNewline) ?? []) {
    const match = reExtraheader.exec(line);
    if (!match || urlHost(match[1]) !== host) continue;
    const decoded = Buffer.from(match[2], "base64").toString("utf8");
    const token = decoded.slice(decoded.indexOf(":") + 1);
    if (token) return token;
  }
  return null;
}

export function forgeName(repoInfo: RepoInfo): "GitHub" | "Gitea" {
  return repoInfo.type === "github" ? "GitHub" : "Gitea";
}

// every credential is host-bound: the generic env names mean github.com and the GITEA_URL instance
export async function getForgeTokens(repoInfo: RepoInfo, cwd?: string): Promise<string[]> {
  const pair = pairToken(repoInfo.host);
  if (pair) return [pair];

  const isGithub = repoInfo.host === "github.com";
  const tokens = isGithub ? envTokens(githubTokenEnvNames) :
    repoInfo.host === urlHost(env.GITEA_URL) ? envTokens(giteaTokenEnvNames) : [];

  // appended, not preferred, so a read-only configured token cannot lock out a working one
  const [ghToken, header] = await Promise.all([
    isGithub ? tryExec("gh", ["auth", "token", "--hostname", repoInfo.host], {timeout: probeTimeout}) : null,
    extraheaderToken(repoInfo.host, cwd),
  ]);
  return Array.from(new Set([...tokens, ghToken, header].filter(Boolean) as string[]));
}

export type RepoInfo = {
  owner: string;
  repo: string;
  host: string;
  type: "github" | "gitea";
};

// the scp-style form cannot express a port, so a ported instance needs an https remote
const reHttpsRemote = /^https:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/;
const reSshRemote = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/;
const reGitSuffix = /\.git\/?$/;
const reIpv6Brackets = /^\[|\]$/g;

// parsed rather than matched, so the port is validated and an optional user and IPv6 literals work
function parseSshUrl(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const [owner, ...rest] = parsed.pathname.replace(reGitSuffix, "").split("/").filter(Boolean);
  const repo = rest.join("/");
  // the ssh port is transport-only and the API may sit elsewhere, so it stays out of the host
  return owner && repo ? [parsed.hostname.replace(reIpv6Brackets, ""), owner, repo] : null;
}

export async function getRepoInfo(cwd?: string, remote: string = "origin"): Promise<RepoInfo | null> {
  const url = await tryExec("git", ["remote", "get-url", remote], {cwd});
  if (!url) return null;
  const match = url.startsWith("ssh://") ?
    parseSshUrl(url) :
    (reHttpsRemote.exec(url) ?? reSshRemote.exec(url))?.slice(1);
  if (!match) return null;
  const host = match[0].toLowerCase(); // DNS is case-insensitive, the path segments are not
  return {owner: match[1], repo: match[2], host, type: host === "github.com" ? "github" : "gitea"};
}

async function forgeFetch(method: string, url: string, authHeader: string, label: string, jsonBody?: string): Promise<Response> {
  logVerbose(`${styleText("magenta", method, {stream: stderr})} ${url}`);
  const headers: Record<string, string> = {Authorization: authHeader};
  if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(url, {method, headers, body: jsonBody});
  } catch (err: any) {
    throw new Error(`${label}: ${err.cause?.message || err.message || "Unknown error"}`);
  }
  logVerbose(`${styleText(response.ok ? "green" : "red", String(response.status), {stream: stderr})} ${url}`);
  return response;
}

class AuthRetryable extends Error {} // signals withTokens to try the next token

function forgeApiBase(repoInfo: RepoInfo): string {
  const host = repoInfo.type === "github" ? "api.github.com" : `${repoInfo.host}/api/v1`;
  return `https://${host}/repos/${repoInfo.owner}/${repoInfo.repo}`;
}

async function ensureOk(response: Response, label: string, allow404 = false): Promise<void> {
  if (response.ok || (allow404 && response.status === 404)) return;
  const message = `${label}: ${response.status} ${response.statusText}\n${await response.text()}`;
  throw response.status === 401 || response.status === 403 ? new AuthRetryable(message) : new Error(message);
}

async function withTokens<T>(
  repoInfo: RepoInfo,
  tokens: string[],
  attempt: (authHeader: string) => Promise<T>,
): Promise<T> {
  let lastError: Error | undefined;
  for (const token of tokens) {
    const authHeader = repoInfo.type === "github" ? `Bearer ${token}` : `token ${token}`;
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

async function deleteMatchingDrafts(apiUrl: string, authHeader: string, tagName: string): Promise<boolean> {
  const listLabel = "Failed to list releases";
  const listResponse = await forgeFetch("GET", `${apiUrl}?draft=true&limit=50&per_page=100`, authHeader, listLabel);
  await ensureOk(listResponse, listLabel);
  const releases = await listResponse.json() as Array<{id: number; tag_name: string; draft: boolean}>;
  const drafts = releases.filter(release => release.draft && release.tag_name === tagName);
  for (const draft of drafts) {
    const label = `Failed to delete draft release ${draft.id}`;
    const deleteResponse = await forgeFetch("DELETE", `${apiUrl}/${draft.id}`, authHeader, label);
    await ensureOk(deleteResponse, label, true);
    console.info(`Deleted stale draft release for ${tagName}`);
  }
  return drafts.length > 0;
}

export async function createForgeRelease(repoInfo: RepoInfo, tagName: string, body: string, tokens: string[]): Promise<void> {
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

  await withTokens(repoInfo, tokens, async (authHeader) => {
    let response = await post(authHeader);

    // a stale draft for the same tag blocks creation, Gitea 409 and GitHub 422
    if (response.status === 409 || response.status === 422) {
      const cleaned = await deleteMatchingDrafts(apiUrl, authHeader, tagName);
      if (cleaned) response = await post(authHeader);
    }

    await ensureOk(response, label);
    const result = await response.json();
    console.info(result.html_url ? `Created release: ${result.html_url}` : "Created release");
  });
}

export function writeResult(result: Result): void {
  for (const output of [result.stdout, result.stderr]) {
    if (output) stdout.write(`${output}${EOL}`);
  }
}

type RemoteState = {branch: string | null; tag: string | null};

const reWhitespace = /\s+/;

// ls-remote needs the push URL, which can differ from the fetch URL it defaults to
export async function probeRemote(pushRemote: string, branchRef: string, tagRef: string): Promise<RemoteState | null> {
  const pushUrl = await tryExec("git", ["remote", "get-url", "--push", pushRemote]);
  if (pushUrl === null) return null;
  const refs = await tryExec("git", ["ls-remote", pushUrl, branchRef, tagRef]);
  if (refs === null) return null;
  let branch: string | null = null, tag: string | null = null;
  for (const line of refs.split(reNewline)) {
    const [oid, ref] = line.split(reWhitespace);
    if (ref === branchRef) branch = oid;
    else if (ref === tagRef) tag = oid;
  }
  return {branch, tag};
}

// verify the forge before the push, so create-release after a landed push is unlikely to fail
export async function pingForge(repoInfo: RepoInfo, tokens: string[]): Promise<string | null> {
  const url = forgeApiBase(repoInfo);
  const label = "forge ping";
  try {
    await withTokens(repoInfo, tokens, async (authHeader) => {
      const response = await forgeFetch("GET", url, authHeader, label);
      // both forges 404 rather than 403 on a private repo the token cannot read, so retry like 401/403
      if (response.status === 404) {
        throw new AuthRetryable(`404 (token may lack access to ${repoInfo.owner}/${repoInfo.repo})`);
      }
      await ensureOk(response, label);
      // installation tokens report every permission false, so only a `pull: true` body is worth gating on
      // https://github.com/orgs/community/discussions/73397
      // https://github.com/orgs/community/discussions/159031
      let body: any = null;
      try {
        body = await response.json();
      } catch {}
      const perms = body?.permissions;
      if (perms?.pull === true && perms.push !== true && perms.admin !== true) {
        throw new AuthRetryable(`token lacks push permission on ${repoInfo.owner}/${repoInfo.repo}`);
      }
      // Gitea 403s every /releases route with a token-shaped message when the Releases unit is off,
      // admins bypass that check and GitHub never sends the field
      if (body?.has_releases === false && perms?.admin !== true) {
        throw new AuthRetryable(`the Releases unit is disabled on ${repoInfo.owner}/${repoInfo.repo}; enable it in the repository settings`);
      }
    });
    return null;
  } catch (err: any) {
    return err.message || "unknown error";
  }
}
