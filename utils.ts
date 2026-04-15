import {execFile as execFileCb} from "node:child_process";
import {stderr} from "node:process";
import {styleText} from "node:util";

export type Result = {stdout: string; stderr: string};

let verbose = false;
const useColor = stderr.isTTY;

export function setVerbose(value: boolean): void {
  verbose = value;
}

const pad = (value: number, len = 2) => String(value).padStart(len, "0");

function timestamp(): string {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function logVerbose(message: string): void {
  if (!verbose) return;
  console.error(`${timestamp()} ${message}`);
}

export function colorize(text: string, color: "magenta" | "green" | "red"): string {
  return useColor ? styleText(color, text) : text;
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

export class SubprocessError extends Error {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number | null;

  constructor(message: string, stdout = "", stderr = "", exitCode: number | null = null) {
    super(message);
    this.name = "SubprocessError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.output = [stderr, stdout].filter(Boolean).join("\n");
    this.exitCode = exitCode;
  }
}

type ExecOptions = {
  shell?: boolean;
  stdin?: {string: string};
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export const reNewline = /\r?\n/;

export function tomlGetString(content: string, section: string, key: string): string | undefined {
  let inSection = false;
  const keyRe = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`);
  for (const line of content.split(reNewline)) {
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

export function exec(file: string, args: readonly string[], options?: ExecOptions): Promise<Result> {
  if (verbose) logVerbose(`$ ${args.length ? `${file} ${args.map(quoteArg).join(" ")}` : file}`);
  return new Promise((resolve, reject) => {
    const child = execFileCb(file, args as string[], {encoding: "utf8", shell: options?.shell, windowsHide: true, cwd: options?.cwd, env: options?.env}, (error, stdout, stderr) => {
      if (error) {
        reject(new SubprocessError(error.message.split(/\r?\n/)[0], stdout, stderr, typeof error.code === "number" ? error.code : null));
      } else {
        resolve({stdout: stdout.trimEnd(), stderr: stderr.trimEnd()});
      }
    });
    if (options?.stdin) {
      child.stdin!.end(options.stdin.string);
    }
  });
}
