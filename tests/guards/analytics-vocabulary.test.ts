import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_COMMON_PROPERTIES,
  ANALYTICS_EVENTS,
  ANALYTICS_ROUTES,
  MAX_ANALYTICS_TITLE_LENGTH,
  matchesAnalyticsKind,
  sanitiseAnalyticsProperties,
} from '@thp/shared';
import {
  EXCEPTION_PROPERTY_NAMES,
  exceptionProperties,
} from '@thp/shared/observability/exceptions';

/**
 * **Nothing that leaves for analytics is free text** (docs/project/observability.md § 5.5).
 *
 * The vocabulary is a runtime table so this test can walk it: every property is an opaque id, a
 * number, a boolean, or one of a short list of words. There is no string kind, and a property
 * whose name suggests content is refused by name. The sanitiser is tested here too, because it is
 * the same promise at runtime — what the table does not name does not go.
 */

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const KINDS = new Set(['id', 'id?', 'number', 'boolean', 'title']);
const CONTENT_WORDS = ['text', 'email', 'name', 'query', 'body', 'title', 'url', 'address', 'content', 'message'];

/**
 * **The one exception to "no free text"**: a published teaching's title, which the catalogue
 * shows every member and which an insight is read by. It is public content, not a member's, and
 * it is allowed on exactly these properties — adding a `'title'` elsewhere fails here, so the
 * exception cannot quietly widen into a string kind.
 */
const TITLE_PROPERTIES = new Set(['playback_started.recording_title']);

const UUID = 'a3f1c2d4-0000-4000-8000-000000000001';

describe('the analytics vocabulary', () => {
  it('types every property as an id, a number, a boolean or an enum — never a string', () => {
    for (const [event, properties] of Object.entries(ANALYTICS_EVENTS)) {
      for (const [property, kind] of Object.entries(properties)) {
        const label = `${event}.${property}`;
        if (kind === 'title') {
          expect(TITLE_PROPERTIES.has(label), `${label} is a title the exception does not cover`).toBe(true);
          continue;
        }
        if (Array.isArray(kind)) {
          expect(kind.length, label).toBeGreaterThan(0);
          for (const word of kind) {
            expect(typeof word, label).toBe('string');
            // A route pattern is the one enum whose words are not words; the routes test below
            // holds it to its own shape.
            if (!word.startsWith('/')) expect(word, label).toMatch(SNAKE_CASE);
          }
        } else {
          expect(KINDS.has(kind as string), `${label} is "${String(kind)}"`).toBe(true);
        }
      }
    }
  });

  it('names events and properties in snake_case, with the two PostHog-native names excepted', () => {
    for (const [event, properties] of Object.entries(ANALYTICS_EVENTS)) {
      if (event !== '$pageview' && event !== '$pageleave') expect(event).toMatch(SNAKE_CASE);
      for (const property of Object.keys(properties)) expect(property).toMatch(SNAKE_CASE);
    }
  });

  it('has no property whose name suggests content, the titled exception apart', () => {
    for (const [event, properties] of Object.entries(ANALYTICS_EVENTS)) {
      for (const property of Object.keys(properties)) {
        if (TITLE_PROPERTIES.has(`${event}.${property}`)) continue;
        for (const word of CONTENT_WORDS) {
          expect(property.split('_'), `${event}.${property}`).not.toContain(word);
        }
      }
    }
  });

  it('holds a title to a bound and to a teaching, never to a member', () => {
    expect(matchesAnalyticsKind('Grace, part one', 'title')).toBe(true);
    expect(matchesAnalyticsKind('   ', 'title')).toBe(false);
    expect(matchesAnalyticsKind(null, 'title')).toBe(false);
    const long = 'x'.repeat(MAX_ANALYTICS_TITLE_LENGTH + 50);
    const clean = sanitiseAnalyticsProperties('playback_started', {
      recording_id: UUID,
      recording_title: `  ${long}  `,
      series_id: null,
      resumed: false,
      speed: 1,
    });
    expect(clean?.['recording_title']).toBe('x'.repeat(MAX_ANALYTICS_TITLE_LENGTH));
  });

  it('holds the common properties to the same rule', () => {
    for (const [property, kind] of Object.entries(ANALYTICS_COMMON_PROPERTIES)) {
      expect(property).toMatch(SNAKE_CASE);
      expect(Array.isArray(kind) || kind === 'version', property).toBe(true);
    }
  });

  it('names page views by route pattern, never by a URL with a value in it', () => {
    for (const route of ANALYTICS_ROUTES) {
      expect(route.startsWith('/')).toBe(true);
      for (const segment of route.split('/').filter((part) => part !== '')) {
        expect(segment).toMatch(/^(\[[a-zA-Z]+\]|[a-z-]+)$/);
      }
    }
  });
});

describe('the sanitiser', () => {
  it('keeps what the table names and matches, and drops the rest', () => {
    expect(
      sanitiseAnalyticsProperties('note_created', {
        recording_id: UUID,
        visibility: 'private',
        is_reply: false,
        // The thing the rule exists for, arriving by mistake.
        text: 'what the member wrote',
      }),
    ).toEqual({ recording_id: UUID, visibility: 'private', is_reply: false });
  });

  it('drops a value that is not what its kind says, rather than sending it', () => {
    expect(
      sanitiseAnalyticsProperties('note_created', {
        recording_id: 'not an id',
        visibility: 'everyone',
        is_reply: 'yes',
      }),
    ).toEqual({});
  });

  it('sends nothing at all for an event the table does not know', () => {
    expect(sanitiseAnalyticsProperties('member_searched', { query: 'grace' })).toBeNull();
  });

  it('reads each kind the way the table means it', () => {
    expect(matchesAnalyticsKind(UUID, 'id')).toBe(true);
    expect(matchesAnalyticsKind('alice@example.com', 'id')).toBe(false);
    expect(matchesAnalyticsKind(null, 'id')).toBe(false);
    expect(matchesAnalyticsKind(null, 'id?')).toBe(true);
    expect(matchesAnalyticsKind(1.5, 'number')).toBe(true);
    expect(matchesAnalyticsKind(Number.NaN, 'number')).toBe(false);
    expect(matchesAnalyticsKind('1', 'number')).toBe(false);
    expect(matchesAnalyticsKind(true, 'boolean')).toBe(true);
    expect(matchesAnalyticsKind('public', ['public', 'private'])).toBe(true);
    expect(matchesAnalyticsKind('secret', ['public', 'private'])).toBe(false);
  });
});

describe('the exception context', () => {
  // Exceptions travel outside the event table (observability.md § 5.6) but under the same rule:
  // every property an adapter may attach to a report is an id, an enum, a count or a route
  // pattern, and none of them is named for content.
  it('names no property that could carry content', () => {
    for (const property of EXCEPTION_PROPERTY_NAMES) {
      expect(property, property).toMatch(SNAKE_CASE);
      for (const word of CONTENT_WORDS) {
        expect(property.split('_'), `${property} names content`).not.toContain(word);
      }
    }
  });

  it('attaches only what the context declares, with nothing undefined', () => {
    const properties = exceptionProperties({
      process: 'api',
      correlation_id: 'req-1234-abcd',
      method: 'POST',
      route: '/api/v1/recordings/[id]/notes',
      status: 500,
    });
    expect(properties).toEqual({
      process: 'api',
      correlation_id: 'req-1234-abcd',
      method: 'POST',
      route: '/api/v1/recordings/[id]/notes',
      status: 500,
    });
    // A caller that smuggles a field in past the type gets nothing for it.
    const widened = { process: 'client', note_text: 'private' } as unknown as Parameters<typeof exceptionProperties>[0];
    expect(exceptionProperties(widened)).toEqual({ process: 'client' });
  });
});
