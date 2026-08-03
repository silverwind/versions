#!/usr/bin/env node
// CLI macro-benchmark. Pass `--before <path>` and `--after <path>` pointing at
// two built `dist/index.js` bundles to compare end-to-end runs.
import {parseArgs} from "node:util";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const ITERATIONS_MACRO = 30;

const formatMs = (ms: number) => `${ms.toFixed(2)}ms`;
const delta = (before: number, after: number) => `${((1 - after / before) * 100).toFixed(1)}% faster`;

function stats(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
  return {mean, min: sorted[0], p50: sorted[Math.floor(sorted.length / 2)]};
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {cwd: dir, stdio: "ignore"});
}

function setupRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "bench@example.com"]);
  git(dir, ["config", "user.name", "bench"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "tag.gpgsign", "false"]);
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(dir, `file${i}.txt`), `version 1.0.0 line ${i}\n`);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({name: "bench", version: "1.0.0"}, null, 2));
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["tag", "1.0.0"]);
  for (let i = 1; i < 5; i++) {
    git(dir, ["commit", "--allow-empty", "-q", "-m", `c${i}`]);
    git(dir, ["tag", `1.0.${i}`]);
  }
}

function resetRepo(dir: string): void {
  git(dir, ["reset", "--hard", "-q", "HEAD"]);
  git(dir, ["clean", "-fdq"]);
}

function runOnce(binary: string, dir: string, files: string[]): number {
  const start = performance.now();
  const result = spawnSync("node", [binary, "patch", ...files, "--dry", "--no-push"], {cwd: dir, encoding: "utf8"});
  const ms = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`bench run failed (exit ${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return ms;
}

function benchCli(before: string, after: string): void {
  const dir = mkdtempSync(join(tmpdir(), "versions-bench-"));
  try {
    setupRepo(dir);
    const files = Array.from({length: 30}, (_, i) => `file${i}.txt`).concat("package.json");

    for (let i = 0; i < 3; i++) {
      runOnce(before, dir, files); resetRepo(dir);
      runOnce(after, dir, files); resetRepo(dir);
    }

    const beforeSamples: number[] = [];
    const afterSamples: number[] = [];
    for (let i = 0; i < ITERATIONS_MACRO; i++) {
      beforeSamples.push(runOnce(before, dir, files)); resetRepo(dir);
      afterSamples.push(runOnce(after, dir, files)); resetRepo(dir);
    }

    const beforeStats = stats(beforeSamples);
    const afterStats = stats(afterSamples);
    console.info(`\nCLI run (${ITERATIONS_MACRO} iter, \`patch\` with ${files.length} files, --dry --no-push):`);
    console.info(`  before:  mean ${formatMs(beforeStats.mean)}  min ${formatMs(beforeStats.min)}  p50 ${formatMs(beforeStats.p50)}`);
    console.info(`  after:   mean ${formatMs(afterStats.mean)}  min ${formatMs(afterStats.min)}  p50 ${formatMs(afterStats.p50)}`);
    console.info(`  delta:   mean ${delta(beforeStats.mean, afterStats.mean)}  (p50 ${delta(beforeStats.p50, afterStats.p50)})`);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

const {values} = parseArgs({
  options: {
    before: {type: "string"},
    after: {type: "string"},
  },
});

if (values.before && values.after) {
  benchCli(values.before, values.after);
} else {
  console.info("pass --before and --after paths to two built dist/index.js bundles");
}
