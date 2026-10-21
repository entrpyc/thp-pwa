import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_COMMON_PROPERTIES,
  ANALYTICS_EVENTS,
  ANALYTICS_ROUTES,
  matchesAnalyticsKind,
  sanitiseAnalyticsProperties,
} from '@thp/shared';

/**
 * **Nothing that leaves for analytics is free text** (docs/project/observability.md § 5.5).
 *
 * The vocabulary is a runtime table so this test can walk it: every property is an opaque id, a
 * number, a boolean, or one of a short list of words. There is no string kind, and a property
 * whose name suggests content is refused by name. The sanitiser is tested here too, because it is
 * the same promise at runtime — what the table does not name does not go.
 */

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const KINDS = new Set(['id', 'id?', 'number', 'boolean']);
const CONTENT_WORDS = ['text', 'email', 'name', 'query', 'body', 'title', 'url', 'address', 'content', 'message'];

const UUID = 'a3f1c2d4-0000-4000-8000-000000000001';

describe('the analytics vocabulary', () => {
  it('types every property as an id, a number, a boolean or an enum — never a string', () => {
    for (const [event, properties] of Object.entries(ANALYTICS_EVENTS)) {
      for (const [property, kind] of Object.entries(properties)) {
        const label = `${event}.${property}`;
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

  it('names events and properties in snake_case, with the one PostHog-native name excepted', () => {
    for (const [event, properties] of Object.entries(ANALYTICS_EVENTS)) {
      if (event !== '$pageview') expect(event).toMatch(SNAKE_CASE);
      for (const property of Object.keys(properties)) expect(property).toMatch(SNAKE_CASE);
    }
  });

  it('has no property whose name suggests content', () => {
    for (const [event, properties] of Object.entries(ANALYTICS_EVENTS)) {
      for (const property of Object.keys(properties)) {
        for (const word of CONTENT_WORDS) {
          expect(property.split('_'), `${event}.${property}`).not.toContain(word);
        }
      }
    }
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
