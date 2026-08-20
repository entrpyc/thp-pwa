import { afterEach, describe, expect, it } from 'vitest';
import { API_PREFIX } from '@thp/shared';
import { buildApiUrl } from '@/client/api-client';
import { readApiOrigin } from '@/client/config';

const ORIGINAL = process.env.NEXT_PUBLIC_API_ORIGIN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_API_ORIGIN;
  else process.env.NEXT_PUBLIC_API_ORIGIN = ORIGINAL;
});

describe('the client calls an absolute API origin read from configuration', () => {
  it('builds the request URL from the configured origin', () => {
    process.env.NEXT_PUBLIC_API_ORIGIN = 'https://api.example.org';
    const url = buildApiUrl('/health');
    expect(url).toBe(`https://api.example.org${API_PREFIX}/health`);
    expect(new URL(url).origin).toBe('https://api.example.org');
  });

  it('never produces a relative path', () => {
    const url = buildApiUrl('/health', 'https://elsewhere.example.org/');
    expect(url.startsWith('/')).toBe(false);
    expect(new URL(url).origin).toBe('https://elsewhere.example.org');
  });

  it('a different configured origin changes the URL — the value is read, not baked in', () => {
    process.env.NEXT_PUBLIC_API_ORIGIN = 'https://one.example.org';
    const first = buildApiUrl('/health');
    process.env.NEXT_PUBLIC_API_ORIGIN = 'https://two.example.org';
    const second = buildApiUrl('/health');
    expect(first).not.toBe(second);
  });

  it('refuses to fall back to the current host when unconfigured', () => {
    delete process.env.NEXT_PUBLIC_API_ORIGIN;
    expect(() => readApiOrigin()).toThrowError(/NEXT_PUBLIC_API_ORIGIN/);
  });
});
