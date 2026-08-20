import { describe, expect, it } from 'vitest';
import {
  currentCorrelationId,
  resolveCorrelationId,
  withCorrelationId,
} from '@/server/observability/correlation';
import { logger, setLogSink, type LogLine } from '@/server/observability/logger';

describe('resolveCorrelationId', () => {
  it('adopts a usable caller-supplied id', () => {
    expect(resolveCorrelationId('abcdefgh')).toBe('abcdefgh');
    expect(resolveCorrelationId(' trace-1234:ab.cd ')).toBe('trace-1234:ab.cd');
  });

  it('mints a fresh id when none is supplied', () => {
    const first = resolveCorrelationId(null);
    const second = resolveCorrelationId(undefined);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses ids that could corrupt the log stream', () => {
    for (const hostile of ['short', 'has space', 'line\nbreak', 'x'.repeat(129), '']) {
      expect(resolveCorrelationId(hostile)).not.toBe(hostile);
    }
  });
});

describe('the logger stamps the ambient correlation id', () => {
  it('carries the id inside a request and omits it outside one', () => {
    const captured: LogLine[] = [];
    const restore = setLogSink((line) => captured.push(line));
    try {
      logger.info('outside');
      withCorrelationId('inside-request-id-1', () => {
        expect(currentCorrelationId()).toBe('inside-request-id-1');
        logger.info('inside');
      });
    } finally {
      restore();
    }

    expect(captured.map((line) => line.correlationId)).toEqual([undefined, 'inside-request-id-1']);
  });

  it('keeps interleaved async work partitioned by id', async () => {
    const captured: LogLine[] = [];
    const restore = setLogSink((line) => captured.push(line));
    const tick = () => new Promise((done) => setTimeout(done, 5));

    try {
      await Promise.all([
        withCorrelationId('id-alpha-0001', async () => {
          logger.info('a1');
          await tick();
          logger.info('a2');
        }),
        withCorrelationId('id-beta-00002', async () => {
          logger.info('b1');
          await tick();
          logger.info('b2');
        }),
      ]);
    } finally {
      restore();
    }

    const byMessage = new Map(captured.map((line) => [line.message, line.correlationId]));
    expect(byMessage.get('a1')).toBe('id-alpha-0001');
    expect(byMessage.get('a2')).toBe('id-alpha-0001');
    expect(byMessage.get('b1')).toBe('id-beta-00002');
    expect(byMessage.get('b2')).toBe('id-beta-00002');
  });
});
