#!/usr/bin/env node
import {
  findUp, resolveBaseVersion, incrementSemver, replaceTokens, getFileChanges,
  readChangelogEntry, updateChangelogHeadingDate, removeIgnoredFiles, joinStrings,
  write, writeResult, getRepoInfo, getForgeTokens, forgeName, probeRemote,
  pingForge, createForgeRelease, type RepoInfo,
} from "./api.ts";
import {SubprocessError, exec, logVerbose, setVerbose} from "./utils.ts";
import {parseArgs} from "node:util";
import {dirname, relative, resolve} from "node:path";
import {cwd, exit} from "node:process";
import {readFileSync} from "node:fs";
import pkg from "./package.json" with {type: "json"};

const reReplaceString = /^s#([^#]+)#([^#]+)#(.*)$/;

function end(err?: Error | string | void): void {
  if (!err) return exit(0);
  const msg = err instanceof SubprocessError ? `${err.message}\n${err.output}` :
    err instanceof Error ? (err.stack || err.message).trim() :
      err;
  console.error(msg);
  exit(1);
}

// parseArgs `strict: false` lets a bare `-r`/`-m` flag through as `true`; keep strings only.
function stringArgs<T>(values: T[] | undefined): string[] {
  return (values ?? []).filter((v): v is string & T => typeof v === "string");
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

  if (level === "prerelease" && !args.preid) {
    throw new Error("prerelease requires --preid option");
  }
  if (args.gitless && args.release) {
    throw new Error("--gitless and --release are mutually exclusive");
  }
  if (args["no-push"] && args.release) {
    throw new Error("--no-push and --release are mutually exclusive");
  }

  // === GATHER === pure reads + computation; no side effects.
  const today = new Date().toISOString().substring(0, 10);
  const date = args.date ? today : "";

  const pwd = cwd();
  const gitDir = findUp(".git", pwd);
  const projectRoot = gitDir ? dirname(gitDir) : pwd;
  const pushRemote = typeof args.remote === "string" ? args.remote : "origin";

  files = files.map(file => relative(pwd, file));

  const wantRelease = Boolean(args.release);
  const willCommit = !args.gitless && !args.dry;
  const willPush = willCommit && !args["no-push"];

  // Fire every independent I/O probe in parallel. Each resolves to a value validate awaits;
  // the chain repoInfo → tokens → pingForge is the only inherently sequential one.
  const baseVersionP = resolveBaseVersion(
    typeof args.base === "string" ? args.base : undefined,
    Boolean(args.gitless),
    projectRoot,
  );
  const pushBranchP: Promise<string> = willPush ? (async () => {
    if (typeof args.branch === "string") return args.branch;
    const {stdout} = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  })() : Promise.resolve("");
  const identityOkP: Promise<boolean> = willCommit ?
    (async () => {
      try {
        await exec("git", ["var", "GIT_AUTHOR_IDENT"]);
        return true;
      } catch {
        return false;
      }
    })() :
    Promise.resolve(true);
  const repoInfoP: Promise<RepoInfo | null> = wantRelease && willCommit ?
    getRepoInfo(undefined, pushRemote) :
    Promise.resolve(null);
  const tokensP: Promise<string[]> = (async () => {
    const info = await repoInfoP;
    return info ? getForgeTokens(info) : [];
  })();
  const pingResultP: Promise<string | null> = (async () => {
    const [info, toks] = await Promise.all([repoInfoP, tokensP]);
    if (!info || !toks.length) return null;
    return pingForge(info, toks);
  })();

  // baseVersion + pushBranch unblock tagRef/branchRef computation; throw the two fatal
  // configuration errors that can't sensibly be deferred to validate (incrementSemver
  // would otherwise blow up on an empty base).
  const [{baseVersion, baseSource, describeTag}, pushBranch] = await Promise.all([baseVersionP, pushBranchP]);
  if (args.gitless && !baseVersion) {
    throw new Error(`--gitless requires --base to be set or a version in package.json or pyproject.toml`);
  }
  if (willPush && pushBranch === "HEAD") {
    throw new Error("Cannot push from detached HEAD. Pass --branch <name> or --no-push.");
  }
  logVerbose(`base version ${baseVersion} from ${baseSource}`);

  const newVersion = incrementSemver(baseVersion, level, typeof args.preid === "string" ? args.preid : undefined);
  logVerbose(`new version ${newVersion}`);

  const replacements: Array<{re: RegExp, replacement: string}> = [];
  for (const replaceStr of stringArgs(args.replace)) {
    let [, re, replacement, flags] = (reReplaceString.exec(replaceStr) || []);
    if (!re || !replacement) {
      throw new Error(`Invalid replace string: ${replaceStr}`);
    }
    replacement = replaceTokens(replacement, newVersion);
    replacements.push({re: new RegExp(re, flags || undefined), replacement});
  }

  const msgs = stringArgs(args.message).map(msg => replaceTokens(msg, newVersion));
  const tagName = args.prefix ? `v${newVersion}` : newVersion;
  const branchRef = `refs/heads/${pushBranch}`;
  const tagRef = `refs/tags/${tagName}`;

  // probeRemote + the ancestor check are the second slow chain; kick them off now and
  // do the sync work below in the meantime.
  const remoteStateP = willPush ? probeRemote(pushRemote, branchRef, tagRef) : Promise.resolve(null);
  const mergeBaseOkP: Promise<boolean> = (async () => {
    const state = await remoteStateP;
    if (!state || !state.branch) return true;
    try {
      await exec("git", ["merge-base", "--is-ancestor", state.branch, "HEAD"]);
      return true;
    } catch {
      return false;
    }
  })();

  const changelogInfo = (() => {
    const path = findUp("CHANGELOG.md", projectRoot);
    if (!path) return null;
    let original: string;
    try {
      original = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    const entry = readChangelogEntry(original, newVersion);
    if (!entry) return null;
    return {path, original, entry, updated: updateChangelogHeadingDate(original, newVersion, today)};
  })();

  // generic baseVersion replacement would rewrite prior version headings in CHANGELOG.md
  const changelogRel = changelogInfo ? relative(pwd, changelogInfo.path) : null;
  if (changelogRel) files = files.filter(file => file !== changelogRel);

  // Compute file changes WITHOUT writing — pure dry-run of the replacement pipeline.
  type FileChange = {path: string; oldData: string; newData: string; changed: boolean};
  const fileChanges: FileChange[] = [];
  for (const file of files) {
    const [newData, oldData] = getFileChanges({file, baseVersion, newVersion, replacements, date});
    if (newData === null) {
      logVerbose(`skipping ${file} (unhandled lockfile)`);
      continue;
    }
    fileChanges.push({path: file, oldData: oldData!, newData, changed: newData !== oldData});
  }

  const allFiles = changelogInfo?.updated ? [...files, changelogRel!] : files;

  // === VALIDATE === single await collects every probe; checks below are pure.
  const [remoteState, repoInfo, tokens, identityOk, pingResult, mergeBaseOk] = await Promise.all([
    remoteStateP, repoInfoP, tokensP, identityOkP, pingResultP, mergeBaseOkP,
  ]);

  const errors: string[] = [];

  // If files were specified (and not -a), at least one must produce a diff — otherwise
  // git commit -i with unchanged files would fail "nothing to commit". Use the raw input
  // count (`files`), not `fileChanges`, so a run that only specified unhandled lockfiles
  // also aborts. Skipped in --gitless because nothing will commit anyway.
  if (!args.gitless && files.length > 0 && !args.all && fileChanges.every(f => !f.changed)) {
    errors.push(`bumping ${baseVersion} → ${newVersion} would not change any of the specified files; the base version is likely wrong`);
  }
  if (willCommit && !identityOk) {
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
      errors.push(`--release: no ${forgeName(repoInfo)} token found in environment`);
    } else if (pingResult) {
      errors.push(`--release: forge unreachable or token rejected: ${pingResult}`);
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    exit(1);
  }

  // === EXECUTE === mutations only — every realistic failure mode was caught above.
  // preserve user's staged hunks on rollback (--soft would leave our changes staged)
  const [preIndexTreeOid, priorLocalTagOid] = willCommit ? await Promise.all([
    (async () => {
      try {
        return (await exec("git", ["write-tree"])).stdout.trim();
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        return (await exec("git", ["rev-parse", "--verify", tagRef])).stdout.trim();
      } catch {
        return null;
      }
    })(),
  ]) : [null, null];

  // Pre-push rollback only — once the atomic push lands, we leave the remote alone.
  const rollbacks: Array<() => Promise<void> | void> = [];
  let pushed = false;

  try {
    const originals = new Map<string, string>();
    rollbacks.push(() => {
      for (const [path, content] of originals) write(path, content);
    });

    for (const f of fileChanges) {
      if (!f.changed) continue;
      originals.set(f.path, f.oldData);
      logVerbose(`writing ${f.path}`);
      write(f.path, f.newData);
    }
    if (changelogInfo?.updated) {
      originals.set(changelogInfo.path, changelogInfo.original);
      logVerbose(`updating heading date in ${changelogInfo.path}`);
      write(changelogInfo.path, changelogInfo.updated);
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
      console.info(`Would create new tag and commit: ${tagName}`);
      return;
    }

    // Commit-specific data — resolved here so dry/gitless paths skip the work entirely.
    const filesToAdd = !args.all && allFiles.length ? await removeIgnoredFiles(allFiles) : [];
    const changelogBody = await (async () => {
      if (changelogInfo) {
        logVerbose(`using changelog entry from ${changelogInfo.path}`);
        return changelogInfo.entry;
      }
      let range = "";
      let tagExists: boolean;
      try {
        await exec("git", ["rev-parse", "--verify", tagRef]);
        tagExists = true;
      } catch {
        tagExists = false;
      }
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
    })();
    const commitMsg = joinStrings([tagName, ...msgs, changelogBody], "\n\n");
    const tagMsg = joinStrings([...msgs, changelogBody], "\n\n");
    const commitArgs = args.all ?
      ["commit", "-a", "--allow-empty", "-F", "-"] :
      filesToAdd.length ?
        ["commit", "-i", "-F", "-", "--", ...filesToAdd] :
        ["commit", "--allow-empty", "-F", "-"];

    writeResult(await exec("git", commitArgs, {stdin: {string: commitMsg}}));
    rollbacks.push(async () => {
      let hasParent: boolean;
      try {
        await exec("git", ["rev-parse", "HEAD^"]);
        hasParent = true;
      } catch {
        hasParent = false;
      }
      if (hasParent) await exec("git", ["reset", "--soft", "HEAD^"]);
      else await exec("git", ["update-ref", "-d", "HEAD"]);
      if (preIndexTreeOid) await exec("git", ["read-tree", preIndexTreeOid]);
    });

    // adding explicit -a here seems to make git no longer sign the tag
    writeResult(await exec("git", ["tag", "-f", "-F", "-", tagName], {stdin: {string: tagMsg}}));
    rollbacks.push(async () => {
      // update-ref preserves the prior tag's type (annotated vs lightweight); `tag -f <oid>`
      // would create a lightweight tag pointing at the prior tag-object OID.
      if (priorLocalTagOid) await exec("git", ["update-ref", tagRef, priorLocalTagOid]);
      else await exec("git", ["tag", "-d", tagName]);
    });

    if (!willPush) return;

    // --atomic: server-side all-or-nothing. Either both refs update or neither does;
    // partial state (the orphan-tag bug) is impossible.
    writeResult(await exec("git", ["push", "--atomic", pushRemote, pushBranch, tagName]));
    pushed = true;

    if (wantRelease) {
      logVerbose(`creating ${forgeName(repoInfo!)} release for ${tagName} (${tokens.length} token${tokens.length === 1 ? "" : "s"} to try)`);
      try {
        await createForgeRelease(repoInfo!, tagName, changelogBody || tagName, tokens);
      } catch (err: any) {
        // Validate confirmed the forge was reachable with push permission, so reaching here
        // means a transient failure during create. The tag is pushed and shared — leave it
        // and tell the user how to recover rather than force-pushing remote history.
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

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  try {
    await main();
    end();
  } catch (err) {
    end(err as Error);
  }
}
