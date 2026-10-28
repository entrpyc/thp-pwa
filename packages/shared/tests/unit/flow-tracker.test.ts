import { describe, expect, it } from 'vitest';
import {
  FLOW_ANSWERS,
  FLOW_RATINGS,
  FLOW_RATING_ENDS,
  FLOW_SESSION_IN_PROGRESS_MESSAGE,
  GAP_RATING_MAX,
  MAX_FLOW_QUESTION_LENGTH,
  answerToRating,
  flowSessionItemDonePath,
  flowSessionItemPath,
  flowSessionPath,
  gapItems,
  isFlowAnswer,
  isFlowRating,
  isGapAnswer,
  isGapRating,
  nextUnanswered,
  ratingToAnswer,
  type FlowSessionItemView,
} from '@thp/shared';

/**
 * **The Flow Tracker's vocabulary** ([3.14.6](docs/project/prd.md), [3.14.9](docs/project/prd.md))
 * — the rules both sides compute, asserted without a browser or a database.
 */

function item(id: string, rating: FlowSessionItemView['rating']): FlowSessionItemView {
  return {
    id,
    position: Number(id),
    kind: 'chapter',
    question: `Q${id}`,
    recording: null,
    chapter: { id: `c${id}`, title: `Chapter ${id}`, summary: null, startMs: 0 },
    tag: null,
    rating,
    answeredAt: rating === null ? null : '2026-10-24T10:00:00.000Z',
    done: false,
  };
}

describe('the scale (3.14.6)', () => {
  it('runs from 1 to 5, with only its two ends worded', () => {
    expect(FLOW_RATINGS).toEqual([1, 2, 3, 4, 5]);
    expect(FLOW_RATING_ENDS.low).toBe('I have not engaged with that yet');
    expect(FLOW_RATING_ENDS.high).toBe("I've experienced transformation");
  });

  it('puts 3 and below on the list, and 4 and 5 off it', () => {
    expect(GAP_RATING_MAX).toBe(3);
    expect(FLOW_RATINGS.filter(isGapRating)).toEqual([1, 2, 3]);
  });

  it('stores each rung as one of the five tokens, in rung order, and reads it back', () => {
    expect(FLOW_ANSWERS).toHaveLength(5);
    for (const rating of FLOW_RATINGS) {
      expect(ratingToAnswer(rating)).toBe(FLOW_ANSWERS[rating - 1]);
      expect(answerToRating(ratingToAnswer(rating))).toBe(rating);
      expect(isGapAnswer(ratingToAnswer(rating))).toBe(isGapRating(rating));
    }
  });

  it('recognises a rating and refuses anything else', () => {
    expect(isFlowRating(3)).toBe(true);
    expect(isFlowRating(0)).toBe(false);
    expect(isFlowRating(6)).toBe(false);
    expect(isFlowRating(2.5)).toBe(false);
    expect(isFlowRating('3')).toBe(false);
    expect(isFlowAnswer('not_embodied')).toBe(true);
    expect(isFlowAnswer('yes')).toBe(false);
  });
});

describe('what a session computes (3.14.5, 3.14.9)', () => {
  it('finds the next unanswered question in asking order, or none', () => {
    const items = [item('1', 4), item('2', null), item('3', null)];
    expect(nextUnanswered(items)?.id).toBe('2');
    expect(nextUnanswered([item('1', 4)])).toBeNull();
  });

  it('keeps only the gaps, in the order they were asked', () => {
    const items = [item('1', 4), item('2', 1), item('3', null), item('4', 3), item('5', 5)];
    expect(gapItems(items).map((one) => one.id)).toEqual(['2', '4']);
  });
});

describe('the wire contract', () => {
  it('keeps every session route under the caller’s own account (3.14.8)', () => {
    expect(flowSessionPath('s1')).toBe('/users/me/flow-sessions/s1');
    expect(flowSessionItemPath('s1', 'i1')).toBe('/users/me/flow-sessions/s1/items/i1');
    expect(flowSessionItemDonePath('s1', 'i1')).toBe('/users/me/flow-sessions/s1/items/i1/done');
  });

  it('bounds a question, and says what to do about a session already running', () => {
    expect(MAX_FLOW_QUESTION_LENGTH).toBe(500);
    expect(FLOW_SESSION_IN_PROGRESS_MESSAGE).toContain('abandon');
  });
});
