import { currentCorrelationId } from './correlation';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  readonly time: string;
  readonly level: LogLevel;
  readonly message: string;
  /** Absent only for lines emitted outside a request — boot, shutdown, background work. */
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

export type LogSink = (line: LogLine) => void;

const defaultSink: LogSink = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

let sink: LogSink = defaultSink;

/** Swap the destination — used by tests to capture what a request emitted. Returns a restore fn. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function emit(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const correlationId = currentCorrelationId();
  sink({
    time: new Date().toISOString(),
    level,
    message,
    ...(correlationId === undefined ? {} : { correlationId }),
    ...fields,
  });
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
};
