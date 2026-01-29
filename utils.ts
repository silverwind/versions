import type {SubprocessError} from "nano-spawn";

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
