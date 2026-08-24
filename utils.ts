import {execFile as execFileCb} from "node:child_process";

export type Result = {stdout: string; stderr: string};

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

function timestamp(): string {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace("T", " ");
}

export function logVerbose(message: string): void {
  if (!verbose) return;
  console.error(`${timestamp()} ${message}`);
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
const reUrlCredential = /(\/\/)[^/\s@]+@/g;

function redactCredentials(message: string): string {
  return message.replace(reUrlCredential, "$1***@");
}
// anchored so a bracketed element of a multi-line array is not read as a table header
const reTomlSection = /^\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/;

export function detectEol(content: string): string {
  return reNewline.exec(content)?.[0] ?? "\n";
}

type TomlVisitor = (line: string, lineIndex: number, lines: string[], section: string) => boolean | void;

function visitTomlSection(content: string, sections: readonly string[], visit: TomlVisitor): string[] {
  const lines = content.split(reNewline);
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed[0] === "#") continue;
    const header = reTomlSection.exec(trimmed);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section && sections.includes(section) && visit(lines[i], i, lines, section)) break;
  }
  return lines;
}

export function tomlGetString(content: string, section: string, key: string): string | undefined {
  const keyRe = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`);
  let value: string | undefined;
  visitTomlSection(content, [section], line => {
    value = keyRe.exec(line.trim())?.[1];
    return value !== undefined;
  });
  return value;
}

// first match per section, as a pyproject may carry the version in both
export function tomlReplaceFirst(content: string, sections: readonly string[], lineRe: RegExp, replacement: string): string {
  const done = new Set<string>();
  const lines = visitTomlSection(content, sections, (line, i, ls, section) => {
    if (done.has(section) || !lineRe.test(line)) return;
    ls[i] = line.replace(lineRe, replacement);
    done.add(section);
  });
  return done.size ? lines.join(detectEol(content)) : content;
}

const reJsonWhitespace = /[ \t\n\r]/;

// replaces the top-level "version" byte-for-byte, so formatting and minification survive
export function replaceJsonVersion(data: string, newVersion: string): string {
  const stack: string[] = [];
  let inString = false;
  let stringStart = -1;
  for (let pos = 0; pos < data.length; pos++) {
    const char = data[pos];
    if (inString) {
      if (char === "\\") {
        pos++;
      } else if (char === '"') {
        inString = false;
        const atTopLevel = stack.length === 1 && stack[0] === "{";
        if (atTopLevel && data.slice(stringStart + 1, pos) === "version") {
          let valuePos = pos + 1;
          while (valuePos < data.length && reJsonWhitespace.test(data[valuePos])) valuePos++;
          if (data[valuePos] !== ":") continue;
          valuePos++;
          while (valuePos < data.length && reJsonWhitespace.test(data[valuePos])) valuePos++;
          if (data[valuePos] !== '"') continue;
          const valueStart = valuePos + 1;
          let valueEnd = valueStart;
          while (valueEnd < data.length && data[valueEnd] !== '"') {
            if (data[valueEnd] === "\\") valueEnd++;
            valueEnd++;
          }
          return `${data.slice(0, valueStart)}${newVersion}${data.slice(valueEnd)}`;
        }
      }
    } else if (char === '"') {
      inString = true;
      stringStart = pos;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
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
    // must stay under MAX_STRING_LENGTH: above it node throws RangeError inside its own exit
    // handler, so the callback never fires and the promise never settles
    const child = execFileCb(file, args as string[], {encoding: "utf8", shell: options?.shell, windowsHide: true, cwd: options?.cwd, env: options?.env, timeout: options?.timeout, maxBuffer: 256 * 1024 * 1024}, (error, stdout, stderr) => {
      if (error) {
        // node puts the full argv in the message, so this is the second place a credential escapes
        reject(new SubprocessError(redactCredentials(error.message.split(reNewline)[0]), stdout, stderr, typeof error.code === "number" ? error.code : null));
      } else {
        resolve({stdout: stdout.trimEnd(), stderr: stderr.trimEnd()});
      }
    });
    const stdin = child.stdin!;
    stdin.on("error", () => {}); // EPIPE when the child already exited, its exit code reports that
    stdin.end(options?.stdin ?? ""); // always close, or a command reading stdin hangs forever
  });
}
