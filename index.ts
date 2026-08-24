#!/usr/bin/env node
import {
  findUp, resolveBaseVersion, incrementSemver, replaceTokens, getFileChanges, readDeclaredVersion,
  findCompanionLockfile,
  readChangelogEntry, updateChangelogHeadingDate, removeIgnoredFiles, joinStrings,
  write, writeResult, getRepoInfo, getForgeTokens, forgeName, probeRemote,
  pingForge, createForgeRelease,
} from "./api.ts";
import {SubprocessError, exec, logVerbose, setVerbose, tryExec} from "./utils.ts";
import {parseArgs} from "node:util";
import {dirname, relative} from "node:path";
import {cwd, exit, stdout, stderr} from "node:process";
import {readFileSync} from "node:fs";
import pkg from "./package.json" with {type: "json"};

const reReplaceString = /^s#([^#]+)#([^#]*)#(.*)$/; // an empty replacement deletes, as in sed
const commands = new Set(["patch", "minor", "major", "prerelease"]);

function end(err?: unknown): void {
  if (!err) return exit(0);
  if (err instanceof Error) {
    if (err.stack) logVerbose(err.stack);
    console.error(err instanceof SubprocessError ? `${err.message}\n${err.output}` : err.message);
  } else {
    console.error(err);
  }
  exit(1);
}

// parseArgs `strict: false` lets a bare `-r`/`-m` flag through as `true`; keep strings only.
function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArgs(values: unknown): string[] {
  return Array.isArray(values) ? values.filter(value => typeof value === "string") : [];
}

async function main(): Promise<void> {
  // exit() discards queued writes on a non-blocking stream, losing diagnostics under CI pipes
  for (const stream of [stdout, stderr]) {
    (stream as any)._handle?.setBlocking?.(true);
  }

  const {values: args, positionals} = parseArgs({
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
  let [level, ...files] = positionals;

  setVerbose(Boolean(args.verbose));

  if (args.version) {
    console.info(pkg.version);
    end();
  }

  if (!level || args.help) {
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
    -D, --dry             Change nothing, just print what would be done
    -R, --release         Create a GitHub or Gitea release with the changelog as body
    -n, --no-push         Skip pushing commit and tag
    -o, --remote <name>   Git remote to push to. Default is "origin"
    -B, --branch <name>   Remote branch to push HEAD to. Default is the current branch
    -V, --verbose         Print verbose output to stderr
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  If files are given, at least one must contain the version.

  Examples:
    $ versions patch package.json
    $ versions prerelease --preid=alpha package.json
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css`);
    end();
  }

  if (!commands.has(level)) {
    throw new Error(`invalid level: ${level}`);
  }

  if (level === "prerelease" && !args.preid) {
    throw new Error("prerelease requires --preid option");
  }
  if (args.gitless && args.release) {
    throw new Error("--gitless and --release are mutually exclusive");
  }
  if (args["no-push"] && args.release) {
    throw new Error("--no-push and --release are mutually exclusive");
  }

  // === GATHER === pure reads + computation, no side effects.
  const today = new Date().toISOString().substring(0, 10);

  const pwd = cwd();
  const gitDir = findUp(".git", pwd);
  // bound version-file lookup at the repo root so a stray parent manifest can't set the base
  const repoRoot = gitDir ? dirname(gitDir) : undefined;
  const projectRoot = repoRoot ?? pwd;
  const pushRemote = stringArg(args.remote) ?? "origin";

  files = Array.from(new Set(files.map(file => relative(pwd, file)))); // so `foo` and `./foo` dedupe

  const wantRelease = Boolean(args.release);
  const willCommit = !args.gitless && !args.dry;
  const willPush = willCommit && !args["no-push"];

  let lastTagP: Promise<string> | undefined;
  // memoized: --base needs it only for the changelog fallback, --gitless/--dry never ask at all
  const lastTag = (): Promise<string> =>
    lastTagP ??= (async () => await tryExec("git", ["describe", "--tags", "--abbrev=0"]) ?? "")();
  const baseVersionP = resolveBaseVersion({
    base: stringArg(args.base),
    gitless: Boolean(args.gitless),
    lastTag,
    projectRoot,
    stopDir: repoRoot,
  });
  // --show-current is empty on detached HEAD, unlike rev-parse which fails on an unborn HEAD
  const pushBranchP = willPush ?
    (async () => stringArg(args.branch) ?? (await exec("git", ["branch", "--show-current"])).stdout)() :
    Promise.resolve("");
  const identityOkP = (async () => !willCommit || await tryExec("git", ["var", "GIT_AUTHOR_IDENT"]) !== null)();
  const forgeP = (async () => {
    const repoInfo = wantRelease && willCommit ? await getRepoInfo(undefined, pushRemote) : null;
    const tokens = repoInfo ? await getForgeTokens(repoInfo) : [];
    const pingResult = repoInfo && tokens.length ? await pingForge(repoInfo, tokens) : null;
    return {repoInfo, tokens, pingResult};
  })();

  // not deferred to the errors[] list: incrementSemver needs a base and branchRef needs a branch
  const [{baseVersion, baseSource, baseTag}, pushBranch] = await Promise.all([baseVersionP, pushBranchP]);
  if (args.gitless && !baseVersion) {
    throw new Error(`--gitless requires --base to be set or a version in package.json or pyproject.toml`);
  }
  if (willPush && !pushBranch) {
    throw new Error("Cannot push from detached HEAD. Pass --branch <name> or --no-push.");
  }
  logVerbose(`base version ${baseVersion} from ${baseSource}`);

  const newVersion = incrementSemver(baseVersion, level, stringArg(args.preid));
  logVerbose(`new version ${newVersion}`);

  const replacements = stringArgs(args.replace).map(replaceStr => {
    const match = reReplaceString.exec(replaceStr);
    if (!match) throw new Error(`Invalid replace string: ${replaceStr}`);
    const [, re, replacement, flags] = match;
    try {
      return {re: new RegExp(re, flags), replacement: replaceTokens(replacement, newVersion)};
    } catch (err: any) {
      throw new Error(`Invalid replace string: ${replaceStr}: ${err.message}`);
    }
  });

  const msgs = stringArgs(args.message).map(msg => replaceTokens(msg, newVersion));
  const tagName = args.prefix ? `v${newVersion}` : newVersion;
  const branchRef = `refs/heads/${pushBranch}`;
  const tagRef = `refs/tags/${tagName}`;

  const remoteStateP = willPush ? probeRemote(pushRemote, branchRef, tagRef) : Promise.resolve(null);
  const mergeBaseOkP = (async () => {
    const state = await remoteStateP;
    return !state?.branch || await tryExec("git", ["merge-base", "--is-ancestor", state.branch, "HEAD"]) !== null;
  })();

  const changelogPath = findUp("CHANGELOG.md", projectRoot, repoRoot);
  const changelogInfo = (() => {
    if (!changelogPath) return null;
    try {
      const original = readFileSync(changelogPath, "utf8");
      const entry = readChangelogEntry(original, newVersion);
      return entry ? {original, entry, updated: updateChangelogHeadingDate(original, newVersion, today)} : null;
    } catch {
      return null;
    }
  })();

  const changelogRel = changelogPath ? relative(pwd, changelogPath) : null;
  // it is found on its own, so naming it without a matching entry is a mistake, not a no-op
  const namedChangelogUnused = !changelogInfo && changelogRel !== null && files.includes(changelogRel);
  files = files.filter(file => file !== changelogRel); // generic replacement would rewrite prior version headings

  // built here so neither the changelog nor a companion lockfile counts as specified
  const specifiedFiles = new Set(files);

  files = Array.from(new Set(files.flatMap(file => {
    const lockfile = findCompanionLockfile(file);
    if (!lockfile) return [file];
    logVerbose(`including ${lockfile}`);
    return [file, lockfile];
  })));

  type FileChange = {path: string; oldData: string; newData: string; changed: boolean; specified: boolean};
  const fileChanges: FileChange[] = [];
  for (const file of files) {
    const changes = getFileChanges({file, baseVersion, newVersion, replacements, date: args.date ? today : ""});
    if (!changes) {
      logVerbose(`skipping ${file} (unhandled lockfile)`);
      continue;
    }
    fileChanges.push({path: file, ...changes, changed: changes.newData !== changes.oldData, specified: specifiedFiles.has(file)});
  }

  // === VALIDATE === single await collects every probe, the checks below are pure.
  const [remoteState, {repoInfo, tokens, pingResult}, identityOk, mergeBaseOk] = await Promise.all([
    remoteStateP, forgeP, identityOkP, mergeBaseOkP,
  ]);

  // manifest rewrites set the version outright, so the no-diff check below can never catch a wrong base
  if (baseSource !== "--base") { // an explicit base overrides detection on purpose
    for (const change of fileChanges) {
      const declared = readDeclaredVersion(change.path, change.oldData);
      // only a warning, a deliberately out-of-sync manifest is a legitimate setup
      if (declared && declared !== baseVersion) {
        console.error(`warning: ${change.path} declares ${declared} but the base version is ${baseVersion} (from ${baseSource})`);
      }
    }
  }

  const errors: string[] = [];

  // no files is a tag-only release, a lockfile is not a bump, and --gitless has no commit to be empty
  if (!args.gitless && specifiedFiles.size > 0 && fileChanges.every(change => !change.changed || !change.specified)) {
    errors.push(`bumping ${baseVersion} → ${newVersion} would not change any of the specified files; the base version is likely wrong`);
  }
  if (namedChangelogUnused) {
    errors.push(`${changelogRel} has no entry for ${newVersion}`);
  }
  if (!identityOk) {
    errors.push("git author identity unavailable; configure user.name + user.email or set GIT_AUTHOR_NAME + GIT_AUTHOR_EMAIL");
  }
  if (willPush) {
    if (!remoteState) {
      errors.push(`could not query remote ${pushRemote} (not configured or unreachable)`);
    } else {
      if (remoteState.tag) {
        errors.push(`tag ${tagName} already exists on remote ${pushRemote} at ${remoteState.tag.slice(0, 8)}; delete it or choose a different version`);
      }
      if (remoteState.branch && !mergeBaseOk) {
        errors.push(`local HEAD is not a descendant of ${pushRemote}/${pushBranch} (${remoteState.branch.slice(0, 8)}); fetch and integrate before bumping`);
      }
    }
  }
  if (wantRelease && willCommit) {
    if (!repoInfo) {
      errors.push("--release: could not detect a forge from the git remote URL");
    } else if (!tokens.length) {
      errors.push(`--release: no ${forgeName(repoInfo)} token found for ${repoInfo.host}, set VERSIONS_FORGE_TOKENS=${repoInfo.host}:<token>`);
    } else if (pingResult) {
      errors.push(`--release: ${pingResult}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    exit(1);
  }

  const writes: Array<Pick<FileChange, "path" | "oldData" | "newData">> = fileChanges.filter(change => change.changed);
  if (changelogInfo?.updated) {
    writes.push({path: changelogRel!, oldData: changelogInfo.original, newData: changelogInfo.updated});
  }

  if (args.dry) {
    for (const update of writes) console.info(`Would update ${update.path}`);
    if (!args.gitless) console.info(`Would create new tag and commit: ${tagName}`);
    return;
  }

  // === EXECUTE === mutations only, every realistic failure mode was caught above.
  // preserve user's staged hunks on rollback (--soft would leave our changes staged)
  const [preIndexTreeOid, priorLocalTagOid] = willCommit ? await Promise.all([
    tryExec("git", ["write-tree"]),
    tryExec("git", ["rev-parse", "--verify", tagRef]),
  ]) : [null, null];

  // Pre-push rollback only, once the atomic push lands we leave the remote alone.
  const rollbacks: Array<() => Promise<void> | void> = [];
  let pushed = false;

  try {
    rollbacks.push(() => {
      for (const update of writes) write(update.path, update.oldData);
    });

    for (const update of writes) {
      logVerbose(`writing ${update.path}`);
      write(update.path, update.newData);
    }

    if (typeof args.command === "string") {
      writeResult(await exec(args.command, [], {shell: true}));
    }

    if (args.gitless) {
      logVerbose("gitless, skipping commit and tag");
      return;
    }

    const allFiles = changelogInfo?.updated ? [...files, changelogRel!] : files;
    const filesToAdd = !args.all && allFiles.length ? await removeIgnoredFiles(allFiles) : [];
    const changelogBody = await (async () => {
      if (changelogInfo) {
        logVerbose(`using changelog entry from ${changelogPath}`);
        return changelogInfo.entry;
      }
      // the tag is created further down, so priorLocalTagOid still reflects a pre-existing one
      const since = priorLocalTagOid ? tagName : baseTag ?? await lastTag();
      return await tryExec("git", ["log", ...since ? [`${since}..HEAD`] : [], "--pretty=format:* %s (%aN)"]) || undefined;
    })();
    const message = joinStrings([tagName, ...msgs, changelogBody], "\n\n");
    const commitArgs = args.all ?
      ["commit", "-a", "--allow-empty", "-F", "-"] :
      filesToAdd.length ?
        ["commit", "-o", "-F", "-", "--", ...filesToAdd] :
        ["commit", "--allow-empty", "-F", "-"];

    writeResult(await exec("git", commitArgs, {stdin: message}));
    rollbacks.push(async () => {
      if (await tryExec("git", ["rev-parse", "HEAD^"]) !== null) await exec("git", ["reset", "--soft", "HEAD^"]);
      else await exec("git", ["update-ref", "-d", "HEAD"]);
      if (preIndexTreeOid) await exec("git", ["read-tree", preIndexTreeOid]);
    });

    // adding explicit -a here seems to make git no longer sign the tag
    writeResult(await exec("git", ["tag", "-f", "-F", "-", tagName], {stdin: message}));
    rollbacks.push(async () => {
      if (priorLocalTagOid) await exec("git", ["update-ref", tagRef, priorLocalTagOid]);
      else await exec("git", ["tag", "-d", tagName]);
    });

    if (!willPush) return;

    // --atomic: both refs update or neither, so no orphan tag
    writeResult(await exec("git", ["push", "--atomic", pushRemote, `HEAD:${branchRef}`, tagRef]));
    pushed = true;

    if (wantRelease) {
      logVerbose(`creating ${forgeName(repoInfo!)} release for ${tagName} (${tokens.length} token${tokens.length === 1 ? "" : "s"} to try)`);
      try {
        await createForgeRelease(repoInfo!, tagName, changelogBody || tagName, tokens);
      } catch (err: any) {
        // the tag is pushed and shared, so recover forward instead of rewriting remote history
        console.error(`Tag ${tagName} was pushed to ${pushRemote} but release creation failed: ${err.message}`);
        console.error(`To finish the release, create it manually on ${forgeName(repoInfo!)} for the existing tag (e.g. via the web UI, \`gh release create ${tagName}\`, or \`tea release create --tag ${tagName}\`). Rerunning versions for this version would be rejected because the tag already exists on the remote.`);
        throw err;
      }
    }
  } catch (err) {
    if (!pushed) {
      for (const rollback of rollbacks.reverse()) {
        try {
          await rollback();
        } catch (cleanupErr: any) {
          console.error(`rollback failed: ${cleanupErr.message}`);
        }
      }
    }
    throw err;
  }
}

try {
  await main();
  end();
} catch (err) {
  end(err);
}
