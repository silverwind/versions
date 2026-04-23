#!/usr/bin/env node
// Microbenchmarks for performance-sensitive paths. Compares the current
// implementation against an inlined prior version so regressions in these
// paths are visible. Run via `node bench.ts`.
//
// Optional CLI macro-bench: pass `--before <path>` and `--after <path>`
// pointing at two built `dist/index.js` bundles to compare end-to-end runs.
import {parseArgs} from "node:util";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {tomlGetString} from "./utils.ts";

const ITERATIONS_MICRO = 20_000;
const ITERATIONS_MACRO = 30;

function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function stats(samples: number[]): {mean: number, min: number, p50: number} {
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {mean, min: sorted[0], p50: sorted[Math.floor(sorted.length / 2)]};
}

function delta(before: number, after: number): string {
  return `${((1 - after / before) * 100).toFixed(1)}% faster`;
}

// prior tomlGetString, without the early-exit on leaving the target section.
function tomlGetStringPrior(content: string, section: string, key: string): string | undefined {
  let inSection = false;
  const keyRe = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`);
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === "#") continue;
    if (trimmed[0] === "[") {
      const m = /^\[([^[\]]+)\]/.exec(trimmed);
      inSection = m ? m[1].trim() === section : false;
      continue;
    }
    if (inSection) {
      const m = keyRe.exec(trimmed);
      if (m) return m[1];
    }
  }
  return undefined;
}

function benchTomlGetString(): void {
  const content = readFileSync("fixtures/uv/uv.lock", "utf8");
  const cases = [
    {label: "key found early", section: "project", key: "name"},
    {label: "key missing", section: "project", key: "nonexistent"},
  ];

  for (const c of cases) {
    for (let i = 0; i < 1000; i++) {
      tomlGetStringPrior(content, c.section, c.key);
      tomlGetString(content, c.section, c.key);
    }

    const priorStart = performance.now();
    for (let i = 0; i < ITERATIONS_MICRO; i++) tomlGetStringPrior(content, c.section, c.key);
    const priorMs = performance.now() - priorStart;

    const currStart = performance.now();
    for (let i = 0; i < ITERATIONS_MICRO; i++) tomlGetString(content, c.section, c.key);
    const currMs = performance.now() - currStart;

    console.info(`\ntomlGetString [${c.label}] (${ITERATIONS_MICRO} iter, ${content.length} byte file):`);
    console.info(`  prior:   ${formatMs(priorMs)}  (${(priorMs / ITERATIONS_MICRO * 1000).toFixed(2)}µs/op)`);
    console.info(`  current: ${formatMs(currMs)}  (${(currMs / ITERATIONS_MICRO * 1000).toFixed(2)}µs/op)`);
    console.info(`  delta:   ${delta(priorMs, currMs)}`);
  }
}

// compares the prior pattern — read once for the transform, read again for
// rollback snapshot — against the current pattern that reuses the first read.
function benchDoubleRead(): void {
  const dir = mkdtempSync(join(tmpdir(), "versions-read-"));
  try {
    const files: string[] = [];
    for (let i = 0; i < 20; i++) {
      const file = join(dir, `f${i}.txt`);
      writeFileSync(file, `version 1.0.0 ${"x".repeat(4096)}\n`);
      files.push(file);
    }

    for (let i = 0; i < 50; i++) {
      for (const f of files) { readFileSync(f, "utf8"); readFileSync(f, "utf8"); }
    }

    const iterations = 500;
    let acc = 0;

    const priorStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      for (const f of files) {
        const data = readFileSync(f, "utf8");
        acc += data.replace(/1\.0\.0/g, "1.0.1").length;
        acc += readFileSync(f, "utf8").length;
      }
    }
    const priorMs = performance.now() - priorStart;

    const currStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      for (const f of files) {
        const data = readFileSync(f, "utf8");
        acc += data.replace(/1\.0\.0/g, "1.0.1").length;
        acc += data.length;
      }
    }
    const currMs = performance.now() - currStart;

    console.info(`\nfile read path (${iterations} iter × ${files.length} files, ~4KB each):`);
    console.info(`  prior:   ${formatMs(priorMs)}`);
    console.info(`  current: ${formatMs(currMs)}`);
    console.info(`  delta:   ${delta(priorMs, currMs)}`);
    if (acc < 0) console.info(acc); // defeat DCE
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

function setupRepo(dir: string): void {
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, {cwd: dir, stdio: "ignore"});
  run("git", ["init", "-q", "-b", "main"]);
  run("git", ["config", "user.email", "bench@example.com"]);
  run("git", ["config", "user.name", "bench"]);
  run("git", ["config", "commit.gpgsign", "false"]);
  run("git", ["config", "tag.gpgsign", "false"]);
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(dir, `file${i}.txt`), `version 1.0.0 line ${i}\n`);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({name: "bench", version: "1.0.0"}, null, 2));
  run("git", ["add", "."]);
  run("git", ["commit", "-q", "-m", "init"]);
  run("git", ["tag", "1.0.0"]);
  for (let i = 1; i < 5; i++) {
    run("git", ["commit", "--allow-empty", "-q", "-m", `c${i}`]);
    run("git", ["tag", `1.0.${i}`]);
  }
}

function resetRepo(dir: string): void {
  execFileSync("git", ["reset", "--hard", "-q", "HEAD"], {cwd: dir, stdio: "ignore"});
  execFileSync("git", ["clean", "-fdq"], {cwd: dir, stdio: "ignore"});
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

    const b = stats(beforeSamples);
    const a = stats(afterSamples);
    console.info(`\nCLI run (${ITERATIONS_MACRO} iter, \`patch\` with ${files.length} files, --dry --no-push):`);
    console.info(`  before:  mean ${formatMs(b.mean)}  min ${formatMs(b.min)}  p50 ${formatMs(b.p50)}`);
    console.info(`  after:   mean ${formatMs(a.mean)}  min ${formatMs(a.min)}  p50 ${formatMs(a.p50)}`);
    console.info(`  delta:   mean ${delta(b.mean, a.mean)}  (p50 ${delta(b.p50, a.p50)})`);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

function main(): void {
  const {values} = parseArgs({
    options: {
      before: {type: "string"},
      after: {type: "string"},
    },
  });

  benchTomlGetString();
  benchDoubleRead();
  if (values.before && values.after) {
    benchCli(values.before, values.after);
  } else {
    console.info("\n(skipping CLI macro-bench — pass --before and --after paths to enable)");
  }
}

try { main(); } catch (err) { console.error(err); process.exit(1); }
