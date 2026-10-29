import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, mediaOrigin } from '@/proxy';

/**
 * The policy's shape (security audit, finding 6): scripts run only with the nonce, the media
 * store is the one second origin, frames and objects are closed, and development's allowances
 * never reach a production build.
 */
describe('the Content-Security-Policy', () => {
  const production = contentSecurityPolicy('abc123', {
    mediaOrigin: 'https://media.example.test',
    development: false,
  });
  const directives = Object.fromEntries(
    production.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name, values];
    }),
  );

  it('allows scripts by nonce and strict-dynamic only', () => {
    expect(directives['script-src']).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(production).not.toContain("'unsafe-eval'");
  });

  it('names the media store wherever bytes are fetched from it', () => {
    for (const name of ['img-src', 'media-src', 'connect-src']) {
      expect(directives[name], name).toContain('https://media.example.test');
    }
    expect(production).not.toContain('ws:');
  });

  it('closes frames, objects, base and form targets', () => {
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    expect(directives['form-action']).toEqual(["'self'"]);
  });

  it('allows the dev bundler only in development', () => {
    const development = contentSecurityPolicy('n', { mediaOrigin: null, development: true });
    expect(development).toContain("'unsafe-eval'");
    expect(development).toContain('ws: wss:');
  });

  it('reads the media origin off the configured endpoint, and copes without one', () => {
    expect(mediaOrigin('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(mediaOrigin('https://abc.r2.cloudflarestorage.com/')).toBe(
      'https://abc.r2.cloudflarestorage.com',
    );
    expect(mediaOrigin(undefined)).toBeNull();
    expect(mediaOrigin('')).toBeNull();
    expect(mediaOrigin('not a url')).toBeNull();
    expect(contentSecurityPolicy('n', { mediaOrigin: null, development: false })).toContain(
      "connect-src 'self';",
    );
  });
});

describe('the API origin', () => {
  it('is named in connect-src when configured, and absent otherwise', () => {
    const named = contentSecurityPolicy('n', {
      mediaOrigin: null,
      apiOrigin: 'http://localhost:3002',
      development: false,
    });
    expect(named).toContain("connect-src 'self' http://localhost:3002;");
    expect(named).not.toContain("img-src 'self' blob: data: http://localhost:3002");
  });
});
