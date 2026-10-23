import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_PROXY_PATH,
  ANALYTICS_HOST_VARIABLE,
} from '../../packages/web/src/client/observability/config';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const NGINX_CONF = 'deploy/nginx/thp.conf';
const ENV_EXAMPLE = '.env.example';

/**
 * **The browser and nginx agree on where analytics goes** (docs/project/observability.md § 5.5).
 *
 * The client sends PostHog events to a path on its own origin, and nginx forwards that path to the
 * EU host. The path is named in two files that nothing compiles together — a TypeScript constant
 * and an nginx `location` — and a rename on one side would leave every event falling through to
 * Next's 404 page with nothing in any log. This test is what makes the two one thing.
 */
describe('the first-party analytics path', () => {
  const nginx = readFileSync(resolve(REPO_ROOT, NGINX_CONF), 'utf8');

  it('is a bland word that no filter list already matches', () => {
    expect(ANALYTICS_PROXY_PATH).toMatch(/^\/[a-z]+$/);
    for (const blocked of ['analytics', 'ingest', 'posthog', 'track', 'collect', 'telemetry', 'metrics', 'event']) {
      expect(ANALYTICS_PROXY_PATH).not.toContain(blocked);
    }
  });

  it('is the location nginx forwards', () => {
    expect(nginx).toContain(`location ${ANALYTICS_PROXY_PATH}/ {`);
  });

  it('is forwarded to the EU host the environment template names', () => {
    const template = readFileSync(resolve(REPO_ROOT, ENV_EXAMPLE), 'utf8');
    const host = new RegExp(`^${ANALYTICS_HOST_VARIABLE}=(\\S+)`, 'm').exec(template)?.[1];
    expect(host).toBeDefined();
    const block = nginx.slice(nginx.indexOf(`location ${ANALYTICS_PROXY_PATH}/ {`));
    expect(block).toContain(`proxy_pass ${host}/;`);
    expect(block).toContain(`proxy_set_header Host ${new URL(host ?? '').host};`);
  });

  it('strips what the browser attaches to a same-origin request', () => {
    const block = nginx.slice(nginx.indexOf(`location ${ANALYTICS_PROXY_PATH}/ {`));
    expect(block).toContain('proxy_set_header Cookie "";');
    expect(block).toContain('proxy_set_header Referer "";');
    expect(block).not.toContain('X-Forwarded-For');
  });
});
