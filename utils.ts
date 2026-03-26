import {execFile as execFileCb} from "node:child_process";

export type Result = {stdout: string; stderr: string};

export class SubprocessError extends Error {
  stdout: string;
  stderr: string;
  output: string;

  constructor(message: string, stdout = "", stderr = "") {
    super(message);
    this.name = "SubprocessError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.output = [stderr, stdout].filter(Boolean).join("\n");
  }
}

type ExecOptions = {
  shell?: boolean;
  stdin?: {string: string};
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function tomlGetString(content: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === "#") continue;
    if (trimmed[0] === "[") {
      const m = /^\[([^[\]]+)\]/.exec(trimmed);
      inSection = m ? m[1].trim() === section : false;
      continue;
    }
    if (inSection) {
      const m = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`).exec(trimmed);
      if (m) return m[1];
    }
  }
  return undefined;
}

export function exec(file: string, args: readonly string[], options?: ExecOptions): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = execFileCb(file, args as string[], {encoding: "utf8", shell: options?.shell, windowsHide: true, cwd: options?.cwd, env: options?.env}, (error, stdout, stderr) => {
      if (error) {
        reject(new SubprocessError(error.message.split(/\r?\n/)[0], stdout, stderr));
      } else {
        resolve({stdout: stdout.trimEnd(), stderr: stderr.trimEnd()});
      }
    });
    if (options?.stdin) {
      child.stdin!.end(options.stdin.string);
    }
  });
}
