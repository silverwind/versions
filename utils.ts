import spawn, {SubprocessError} from "nano-spawn";
import type {Options} from "nano-spawn";

/**
 * Enhances a SubprocessError with detailed stderr/stdout information while preserving the stack trace.
 * @param err - The error to enhance
 * @returns An enhanced Error with detailed output information
 */
export function enhanceSubprocessError(err: SubprocessError): Error {
  const errorMsg = [
    err.message,
    err.stderr ? `stderr: ${err.stderr}` : "",
    err.stdout ? `stdout: ${err.stdout}` : "",
  ].filter(Boolean).join("\n");
  const enhancedError = new Error(errorMsg);
  enhancedError.stack = err.stack;
  return enhancedError;
}

/**
 * Helper function to run spawn with better error messages.
 * Wraps spawn calls to enhance SubprocessError with detailed stderr/stdout information.
 * @param file - Command to execute
 * @param args - Arguments for the command
 * @param options - Spawn options
 * @returns Promise that resolves with the spawn result
 */
export async function spawnEnhanced(file: string, args?: readonly string[], options?: Options) {
  try {
    return await spawn(file, args, options);
  } catch (err) {
    if (err instanceof SubprocessError) {
      throw enhanceSubprocessError(err);
    }
    throw err;
  }
}
