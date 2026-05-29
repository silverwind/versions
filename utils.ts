import {execFile as execFileCb} from "node:child_process";
import {stderr} from "node:process";
import {styleText} from "node:util";

export type Result = {stdout: string; stderr: string};

let verbose = false;

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
  return styleText(color, text, {stream: stderr});
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
const reTomlSection = /^\[([^[\]]+)\]/;

export function detectEol(s: string): string {
  return reNewline.exec(s)?.[0] ?? "\n";
}

type TomlVisitor = (line: string, lineIndex: number, lines: string[]) => boolean | void;

function visitTomlSection(content: string, sections: readonly string[], visit: TomlVisitor): string[] {
  const lines = content.split(reNewline);
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed[0] === "#") continue;
    if (trimmed[0] === "[") {
      section = reTomlSection.exec(trimmed)?.[1].trim() ?? null;
      continue;
    }
    if (section && sections.includes(section) && visit(lines[i], i, lines)) break;
  }
  return lines;
}

export function tomlGetString(content: string, section: string, key: string): string | undefined {
  const keyRe = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`);
  let value: string | undefined;
  visitTomlSection(content, [section], line => {
    const m = keyRe.exec(line.trim());
    if (!m) return false;
    value = m[1];
    return true;
  });
  return value;
}

export function tomlReplaceFirst(content: string, sections: readonly string[], lineRe: RegExp, replacement: string): string {
  let changed = false;
  const lines = visitTomlSection(content, sections, (line, i, ls) => {
    if (!lineRe.test(line)) return false;
    ls[i] = line.replace(lineRe, replacement);
    changed = true;
    return true;
  });
  return changed ? lines.join(detectEol(content)) : content;
}

const reJsonWhitespace = /[ \t\n\r]/;

// Replace the top-level "version" value in a JSON document, preserving all other bytes (works on
// minified manifests too). Brace/bracket depth skips nested "version" keys; the trailing `:`
// distinguishes a key from a value equal to "version". Returns input unchanged if none found.
export function replaceJsonVersion(data: string, newVersion: string): string {
  const stack: string[] = [];
  let inString = false;
  let stringStart = -1;
  for (let pos = 0; pos < data.length; pos++) {
    const char = data[pos];
    if (inString) {
      if (char === "\\") {
        pos++; // skip the escaped character
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

export function exec(file: string, args: readonly string[], options?: ExecOptions): Promise<Result> {
  if (verbose) logVerbose(`$ ${args.length ? `${file} ${args.map(quoteArg).join(" ")}` : file}`);
  return new Promise((resolve, reject) => {
    const child = execFileCb(file, args as string[], {encoding: "utf8", shell: options?.shell, windowsHide: true, cwd: options?.cwd, env: options?.env}, (error, stdout, stderr) => {
      if (error) {
        reject(new SubprocessError(error.message.split(reNewline)[0], stdout, stderr, typeof error.code === "number" ? error.code : null));
      } else {
        resolve({stdout: stdout.trimEnd(), stderr: stderr.trimEnd()});
      }
    });
    if (options?.stdin) {
      child.stdin!.end(options.stdin.string);
    }
  });
}
