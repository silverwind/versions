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
import {readTokens} from "./tokens.ts";

const reEscapeChars = /[|\\{}()[\]^$+*?.-]/g;
const reSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const rePrereleaseIdNum = /^([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)\.(\d+)$/;
const reDate = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/;
// scope to [project] / [tool.poetry], other sections may have unrelated `version` keys
const reTomlVersionLine = /^(\s*version\s*=\s*["'])\d+\.\d+\.\d+(?:[^"'\d][^"']*)?(["'].*)$/;
const pyprojectSections: readonly string[] = ["project", "tool.poetry"];
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
  const [major, minor, patch] = reSemver.exec(stripV(newVersion))!.slice(1);
  return str
    .replaceAll("_VER_", newVersion)
    .replaceAll("_MAJOR_", major)
    .replaceAll("_MINOR_", minor)
    .replaceAll("_PATCH_", patch);
}

export function incrementSemver(str: string, level: string, preid?: string): string {
  const match = reSemver.exec(stripV(str));
  if (!match) throw new Error(`Invalid semver: ${str}`);
  // checked against the prerelease group, as a bare isSemver would read a `+` as build metadata
  if (preid && reSemver.exec(`0.0.0-${preid}`)?.[4] !== preid) throw new Error(`Invalid prerelease identifier: ${preid}`);
  const [majStr, minStr, patStr, prerelease] = match.slice(1);
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
  try {
    return path && readDeclaredVersion(path, readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pyprojectGet(content: string, key: string): string | undefined {
  return pyprojectSections.map(section => tomlGetString(content, section, key)).find(Boolean);
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
  try {
    const {packageManager} = JSON.parse(readFileSync(file, "utf8"));
    if (typeof packageManager !== "string") return null;
    for (const name of packageManagerLockfiles.get(packageManager.split("@")[0]) ?? []) {
      const path = join(dirname(file), name);
      if (existsSync(path)) return path;
    }
  } catch {}
  return null;
}

export async function resolveBaseVersion({base, gitless, lastTag, projectRoot, stopDir}: {
  base?: string,
  gitless: boolean,
  lastTag: () => Promise<string>, // a thunk, so an explicit base never runs the slow `git describe`
  projectRoot: string,
  stopDir?: string,
}): Promise<{baseVersion: string, baseSource: string, baseTag?: string}> {
  if (base !== undefined) {
    if (!isSemver(base)) throw new Error(`Invalid base version: ${base}`);
    return {baseVersion: stripV(base), baseSource: "--base"};
  }

  if (!gitless) {
    const describeTag = await lastTag();
    if (isSemver(describeTag)) {
      // describe picks among same-commit tags by date, not version
      const commitTags = await tryExec("git", ["-c", "versionsort.suffix=-", "tag", "--list", "--points-at", `${describeTag}^{commit}`, "--sort=-v:refname"]);
      const baseTag = commitTags?.split(reNewline).find(isSemver) ?? describeTag;
      return {baseVersion: stripV(baseTag), baseSource: "git describe", baseTag};
    }

    const tag = (await tryExec("git", ["tag", "--list", "--sort=-creatordate"]))?.split(reNewline).find(isSemver);
    if (tag) return {baseVersion: stripV(tag), baseSource: "git tag list", baseTag: tag};
  }

  for (const filename of ["package.json", "pyproject.toml"]) {
    const version = readVersionFile(filename, projectRoot, stopDir);
    if (version) return {baseVersion: version, baseSource: filename};
  }

  return gitless ? {baseVersion: "", baseSource: ""} : {baseVersion: "0.0.0", baseSource: "default"};
}

const reHeading = /^(#+)\s+(.*?)\s*$/;
// YYYY-MM-DD, xxxx-xx-xx, ????-??-??, DD-MM-YYYY, YYYY/MM/DD
const rePlaceholderDate = /[YMDX?]{2,4}[-/. ][YMDX?]{2,4}[-/. ][YMDX?]{2,4}/i;
const reLinkDefinition = /^\[[^\]]+\]:\s/;

export function processChangelog(content: string, version: string, date: string): {entry: string, updated: string | null} | null {
  const lines = content.split(reNewline);
  const reVersion = new RegExp(`(?<![\\d.-])${esc(stripV(version))}(?![\\d.-])`, "i");
  const index = lines.findIndex(line => reVersion.test(reHeading.exec(line)?.[2] ?? ""));
  if (index === -1) return null;
  const level = reHeading.exec(lines[index])![1].length;
  const end = lines.findIndex((line, i) => i > index && (reHeading.exec(line)?.[1].length ?? Infinity) <= level);
  const entryLines = lines.slice(index + 1, end === -1 ? lines.length : end);
  // Keep a Changelog trails link definitions below every section, the last entry would swallow them
  while (entryLines.length && (reLinkDefinition.test(entryLines.at(-1)!) || !entryLines.at(-1)!.trim())) entryLines.pop();
  const entry = entryLines.join("\n").trim();
  if (!entry) return null;
  const heading = lines[index];
  if (rePlaceholderDate.test(heading)) {
    lines[index] = heading.replace(rePlaceholderDate, date);
  } else if (reDate.test(heading)) {
    return {entry, updated: null};
  } else {
    lines[index] = `${heading.trimEnd()} - ${date}`;
  }
  return {entry, updated: lines.join(detectEol(content))};
}

export async function removeIgnoredFiles(files: Array<string>, cwd?: string): Promise<Array<string>> {
  // check-ignore exits 1 when nothing is ignored and 128 on error, both meaning "keep everything"
  const ignored = await tryExec("git", ["check-ignore", "--", ...files], {cwd});
  if (!ignored) return files;
  const ignoredFiles = new Set<string>(ignored.split(reNewline));
  return files.filter(file => !ignoredFiles.has(file));
}

export function getFileChanges({file, baseVersion, newVersion, replacements, date}: {
  file: string,
  baseVersion: string,
  newVersion: string,
  replacements?: Array<{re: RegExp, replacement: string}>,
  date?: string,
}): {newData: string, oldData: string} | null {
  const fileName = basename(file);

  // unhandled lockfiles: blind search-and-replace would corrupt dependency versions
  if (!["package-lock.json", "uv.lock"].includes(fileName) && (reLockfileName.test(fileName) || fileName === "go.sum")) return null;

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
    const name = pyprojectGet(readFileSync(join(dirname(file), "pyproject.toml"), "utf8"), "name");
    if (!name) throw new Error(`Could not determine project name from pyproject.toml for ${file}`);
    const re = new RegExp(`(\\[\\[package\\]\\]\r?\nname = "${esc(name)}"\r?\nversion = ").+?(")`);
    newData = oldData.replace(re, `$1${newVersion}$2`);
  } else {
    newData = oldData.replaceAll(baseVersion, newVersion);
  }

  if (date) newData = newData.replace(new RegExp(reDate, "g"), date);
  for (const {re, replacement} of replacements ?? []) newData = newData.replace(re, replacement);
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

export const githubTokenEnvNames = ["VERSIONS_GITHUB_API_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN"];
export const giteaTokenEnvNames = ["VERSIONS_GITEA_API_TOKEN", "GITEA_API_TOKEN", "GITEA_AUTH_TOKEN", "GITEA_TOKEN", "FORGEJO_TOKEN"];

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

const reExtraheader = /^http\.(\S+)\/\.extraheader AUTHORIZATION:\s*basic\s+(\S+)$/i;

// actions/checkout leaves the CI token in `http.<origin>/.extraheader`, base64 of
// `x-access-token:<token>`. `--local` misses it, the credentials file arrives via includeIf.
async function extraheaderToken(host: string, cwd?: string): Promise<string | null> {
  const config = await tryExec("git", ["config", "--get-regexp", "^http\\..*\\.extraheader$"], {cwd, timeout: 5000});
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

  const stored = (await readTokens())[repoInfo.host];
  const tokens = (repoInfo.host === "github.com" ? githubTokenEnvNames :
    repoInfo.host === urlHost(env.GITEA_URL) ? giteaTokenEnvNames : []).map(name => env[name]);

  // appended, not preferred, so a read-only configured token cannot lock out a working one
  const header = await extraheaderToken(repoInfo.host, cwd);
  return Array.from(new Set([stored, ...tokens, header].filter(Boolean) as string[]));
}

export type RepoInfo = {owner: string; repo: string; host: string; type: "github" | "gitea"};

// the scp-style form cannot express a port, so a ported instance needs an https remote
const reHttpsRemote = /^https:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/;
const reSshRemote = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/;
const reGitSuffix = /\.git\/?$/;
const reIpv6Brackets = /^\[|\]$/g;

// parsed rather than matched, so the port is validated and an optional user and IPv6 literals work
function parseSshUrl(url: string): string[] | null {
  try {
    const {hostname, pathname} = new URL(url);
    const [owner, ...rest] = pathname.replace(reGitSuffix, "").split("/").filter(Boolean);
    const repo = rest.join("/");
    // the ssh port is transport-only and the API may sit elsewhere, so it stays out of the host
    return owner && repo ? [hostname.replace(reIpv6Brackets, ""), owner, repo] : null;
  } catch {
    return null;
  }
}

export async function getRepoInfo(cwd?: string, remote: string = "origin"): Promise<RepoInfo | null> {
  const url = await tryExec("git", ["remote", "get-url", remote], {cwd});
  if (!url) return null;
  const match = url.startsWith("ssh://") ? parseSshUrl(url) : (reHttpsRemote.exec(url) ?? reSshRemote.exec(url))?.slice(1);
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
class RejectedToken extends AuthRetryable {}

function forgeApiRoot(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v1`;
}

function forgeApiBase(repoInfo: RepoInfo): string {
  return `${forgeApiRoot(repoInfo.host)}/repos/${repoInfo.owner}/${repoInfo.repo}`;
}

function forgeAuthHeader(host: string, token: string): string {
  return host === "github.com" ? `Bearer ${token}` : `token ${token}`;
}

async function ensureOk(response: Response, label: string, allow404 = false): Promise<void> {
  if (response.ok || (allow404 && response.status === 404)) return;
  const message = `${label}: ${response.status} ${response.statusText}\n${await response.text()}`;
  throw response.status === 401 ? new RejectedToken(message) :
    response.status === 403 ? new AuthRetryable(message) : new Error(message);
}

const rejectedTokens = new Set<string>();

async function withTokens<T>(repoInfo: RepoInfo, tokens: string[], attempt: (authHeader: string) => Promise<T>): Promise<T> {
  let lastError: Error | undefined;
  for (const token of tokens) {
    if (rejectedTokens.has(token)) continue;
    try {
      return await attempt(forgeAuthHeader(repoInfo.host, token));
    } catch (err: any) {
      if (!(err instanceof AuthRetryable)) throw err;
      lastError = err;
      if (err instanceof RejectedToken && !rejectedTokens.has(token)) {
        rejectedTokens.add(token);
        if ((await readTokens())[repoInfo.host] === token) {
          console.error(`stored token for ${repoInfo.host} was rejected, run "versions --login ${repoInfo.host}" to replace it`);
        }
      }
      logVerbose(`auth failed, trying next token`);
    }
  }
  throw lastError ?? new Error("No tokens provided");
}

export async function verifyToken(host: string, token: string): Promise<string> {
  const label = `token verification for ${host}`;
  const response = await forgeFetch("GET", `${forgeApiRoot(host)}/user`, forgeAuthHeader(host, token), label);
  if (response.status === 401) throw new Error(`token for ${host} was rejected`);
  if (!response.ok) throw new Error(`${label} failed with status ${response.status}`);
  return (await response.json()).login;
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
  const releaseBody = JSON.stringify({tag_name: tagName, name: tagName, body, draft: false, prerelease: tagName.includes("-")});

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

type RemoteState = {branch: string | null; tag: string | null; head: string | null};

// ls-remote needs the push URL, which can differ from the fetch URL it defaults to
export async function probeRemote(pushRemote: string, branchRef: string, tagRef: string): Promise<RemoteState | null> {
  const pushUrl = await tryExec("git", ["remote", "get-url", "--push", pushRemote]);
  if (pushUrl === null) return null;
  const refs = await tryExec("git", ["ls-remote", "--symref", pushUrl, "HEAD", branchRef, tagRef]);
  if (refs === null) return null;
  let branch: string | null = null, tag: string | null = null, head: string | null = null;
  for (const line of refs.split(reNewline)) {
    const [oid, ref] = line.split("\t");
    if (oid.startsWith("ref: ")) {
      if (ref === "HEAD") head = oid.slice("ref: ".length);
    } else if (ref === branchRef) branch = oid;
    else if (ref === tagRef) tag = oid;
  }
  return {branch, tag, head};
}

// verify the forge before the push, so create-release after a landed push is unlikely to fail
export async function pingForge(repoInfo: RepoInfo, tokens: string[]): Promise<string | null> {
  const url = forgeApiBase(repoInfo);
  const label = "forge ping";
  try {
    await withTokens(repoInfo, tokens, async (authHeader) => {
      const response = await forgeFetch("GET", url, authHeader, label);
      // both forges 404 rather than 403 on a private repo the token cannot read, so retry like 401/403
      if (response.status === 404) throw new AuthRetryable(`404 (token may lack access to ${repoInfo.owner}/${repoInfo.repo})`);
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
