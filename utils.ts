import {execFile as execFileCb} from "node:child_process";

export type Result = {stdout: string; stderr: string};

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function logVerbose(message: string): void {
  if (!verbose) return;
  const date = new Date();
  date.setTime(date.getTime() - date.getTimezoneOffset() * 60000);
  console.error(`${date.toISOString().slice(0, 23).replace("T", " ")} ${message}`);
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
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

export const reNewline = /\r?\n/;

function redactCredentials(message: string): string {
  return message.replace(/(\/\/)[^/\s@]+@/g, "$1***@");
}

// anchored so a bracketed element of a multi-line array is not read as a table header
const reTomlSection = /^\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/;

export function detectEol(content: string): string {
  return reNewline.exec(content)?.[0] ?? "\n";
}

function* tomlSectionLines(lines: string[], sections: readonly string[]): Generator<[number, string]> {
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed[0] === "#") continue;
    const header = trimmed[0] === "[" ? reTomlSection.exec(trimmed) : null;
    if (header) section = header[1].trim();
    else if (section && sections.includes(section)) yield [i, section];
  }
}

export function tomlGetString(content: string, section: string, key: string): string | undefined {
  const keyRe = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`);
  const lines = content.split(reNewline);
  for (const [i] of tomlSectionLines(lines, [section])) {
    const value = keyRe.exec(lines[i].trim())?.[1];
    if (value !== undefined) return value;
  }
  return undefined;
}

// first match per section, as a pyproject may carry the version in both
export function tomlReplaceFirst(content: string, sections: readonly string[], lineRe: RegExp, replacement: string): string {
  const lines = content.split(reNewline);
  const done = new Set<string>();
  for (const [i, section] of tomlSectionLines(lines, sections)) {
    if (done.has(section) || !lineRe.test(lines[i])) continue;
    lines[i] = lines[i].replace(lineRe, replacement);
    done.add(section);
    if (done.size === sections.length) break;
  }
  return done.size ? lines.join(detectEol(content)) : content;
}

// replaces the top-level "version" byte-for-byte, so formatting and minification survive
export function replaceJsonVersion(data: string, newVersion: string): string {
  let depth = 0;
  let rootIsObject = false;
  let inString = false;
  let stringStart = -1;
  for (let pos = 0; pos < data.length; pos++) {
    const char = data[pos];
    if (inString) {
      if (char === "\\") {
        pos++;
      } else if (char === '"') {
        inString = false;
        if (depth === 1 && rootIsObject && pos === stringStart + 8 && data.startsWith("version", stringStart + 1)) {
          const reJsonValueStart = /[ \t\n\r]*:[ \t\n\r]*"/y;
          reJsonValueStart.lastIndex = pos + 1;
          if (!reJsonValueStart.test(data)) continue;
          const valueStart = reJsonValueStart.lastIndex;
          let valueEnd = valueStart;
          while (valueEnd < data.length && data[valueEnd] !== '"') valueEnd += data[valueEnd] === "\\" ? 2 : 1;
          return `${data.slice(0, valueStart)}${newVersion}${data.slice(valueEnd)}`;
        }
      }
    } else if (char === '"') {
      inString = true;
      stringStart = pos;
    } else if (char === "{" || char === "[") {
      if (depth === 0) rootIsObject = char === "{";
      depth++;
    } else if ((char === "}" || char === "]") && depth > 0) {
      depth--;
    }
  }
  return data;
}

// null on failure, "" on success with no output, so callers must test against null
export async function tryExec(file: string, args: readonly string[], options?: ExecOptions): Promise<string | null> {
  try {
    return (await exec(file, args, options)).stdout.trim();
  } catch {
    return null;
  }
}

export function exec(file: string, args: readonly string[], options?: ExecOptions): Promise<Result> {
  if (verbose) logVerbose(redactCredentials(`$ ${[file, ...args.map(quoteArg)].join(" ")}`));
  return new Promise((resolve, reject) => {
    // must stay under MAX_STRING_LENGTH: node throws RangeError inside its own exit handler,
    // so the callback never fires and the promise never settles
    const child = execFileCb(file, args, {encoding: "utf8", shell: options?.shell, windowsHide: true, cwd: options?.cwd, env: options?.env, timeout: options?.timeout, maxBuffer: 256 * 1024 * 1024}, (error, stdout, stderr) => {
      if (error) {
        // node puts the full argv in the message, so this is the second place a credential escapes
        reject(new SubprocessError(redactCredentials(error.message.split(reNewline, 1)[0]), stdout, stderr, typeof error.code === "number" ? error.code : null));
      } else {
        resolve({stdout: stdout.trimEnd(), stderr: stderr.trimEnd()});
      }
    });
    const stdin = child.stdin!;
    stdin.on("error", () => {}); // EPIPE when the child already exited, its exit code reports that
    stdin.end(options?.stdin ?? ""); // always close, or a command reading stdin hangs forever
  });
}
