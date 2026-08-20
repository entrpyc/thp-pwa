import { readFileSync, statSync } from 'node:fs';

export interface AppLogLine {
  readonly time: string;
  readonly level: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

/** Byte offset to read the next slice of the log from. */
export function logOffset(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isAppLogLine(value: unknown): value is AppLogLine {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppLogLine).level === 'string' &&
    typeof (value as AppLogLine).message === 'string' &&
    typeof (value as AppLogLine).time === 'string'
  );
}

/**
 * Structured lines the application logger wrote after `offset`. Everything the framework prints is
 * plain text and is filtered out by the JSON parse.
 */
export function readAppLogLines(path: string, offset = 0): AppLogLine[] {
  // Slice as bytes, not as decoded characters: `logOffset` is a byte count, and the framework's
  // startup banner is multi-byte, so a string slice would silently swallow whole lines.
  const raw = readFileSync(path).subarray(offset).toString('utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter(isAppLogLine);
}

/** Poll until `predicate` is satisfied — the server writes its log asynchronously. */
export async function waitForLogLines(
  path: string,
  offset: number,
  predicate: (lines: AppLogLine[]) => boolean,
  timeoutMs = 15_000,
): Promise<AppLogLine[]> {
  const deadline = Date.now() + timeoutMs;
  let lines: AppLogLine[] = [];
  while (Date.now() < deadline) {
    lines = readAppLogLines(path, offset);
    if (predicate(lines)) return lines;
    await new Promise((done) => setTimeout(done, 100));
  }
  return lines;
}
