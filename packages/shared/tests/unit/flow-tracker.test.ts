import { describe, expect, it } from 'vitest';
import {
  FLOW_ANSWERS,
  FLOW_ANSWER_LABEL,
  FLOW_SESSION_IN_PROGRESS_MESSAGE,
  MAX_FLOW_QUESTION_LENGTH,
  flowSessionItemDonePath,
  flowSessionItemPath,
  flowSessionPath,
  gapItems,
  isFlowAnswer,
  isGapAnswer,
  nextUnanswered,
  type FlowSessionItemView,
} from '@thp/shared';

/**
 * **The Flow Tracker's vocabulary** ([3.14.6](docs/project/prd.md), [3.14.9](docs/project/prd.md))
 * — the rules both sides compute, asserted without a browser or a database.
 */

function item(id: string, answer: FlowSessionItemView['answer']): FlowSessionItemView {
  return {
    id,
    position: Number(id),
    kind: 'chapter',
    question: `Q${id}`,
    recording: null,
    chapter: { id: `c${id}`, title: `Chapter ${id}`, summary: null, startMs: 0 },
    tag: null,
    answer,
    answeredAt: answer === null ? null : '2026-10-24T10:00:00.000Z',
    done: false,
  };
}

describe('the five answers (3.14.6)', () => {
  it('offers exactly five, in the order the screen draws them, each with a label', () => {
    expect(FLOW_ANSWERS).toEqual([
      'dont_remember',
      'recall_slightly',
      'remember_well',
      'not_embodied',
      'experience_daily',
    ]);
    for (const answer of FLOW_ANSWERS) expect(FLOW_ANSWER_LABEL[answer].length).toBeGreaterThan(0);
  });

  it('treats the bottom three as gaps, and the top two as not', () => {
    expect(FLOW_ANSWERS.filter(isGapAnswer)).toEqual(['dont_remember', 'recall_slightly', 'remember_well']);
    expect(isGapAnswer('not_embodied')).toBe(false);
    expect(isGapAnswer('experience_daily')).toBe(false);
  });

  it('recognises an answer and refuses anything else', () => {
    expect(isFlowAnswer('not_embodied')).toBe(true);
    expect(isFlowAnswer('yes')).toBe(false);
    expect(isFlowAnswer(3)).toBe(false);
  });
});

describe('what a session computes (3.14.5, 3.14.9)', () => {
  it('finds the next unanswered question in asking order, or none', () => {
    const items = [item('1', 'remember_well'), item('2', null), item('3', null)];
    expect(nextUnanswered(items)?.id).toBe('2');
    expect(nextUnanswered([item('1', 'remember_well')])).toBeNull();
  });

  it('keeps only the gaps, in the order they were asked', () => {
    const items = [
      item('1', 'not_embodied'),
      item('2', 'dont_remember'),
      item('3', null),
      item('4', 'remember_well'),
      item('5', 'experience_daily'),
    ];
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
