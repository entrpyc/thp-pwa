import { describe, expect, it } from 'vitest';
import { MIND_MAP_MAX_POINTS, MIND_MAP_MAX_THEMES } from '@thp/shared';
import { DRAFT_FIELD_INSTRUCTIONS, OFFSET_NOTE, buildUserPrompt } from '../../src/generate/prompt';

/**
 * **What a drafting request says**, and in particular what a chapter-scoped one says
 * ([3.8.1](docs/project/prd.md)): the mind map is asked for one chapter at a time, and the model
 * has to be told it is reading a chapter rather than the teaching, or it will name themes for a
 * whole it cannot see.
 */

const LINES = [
  { startMs: 0, text: 'Good morning.' },
  { startMs: 4000, text: 'We are in the second chapter.' },
];

describe('the drafting prompt', () => {
  it('names the teaching, the offsets, what is wanted and the transcript, in that order', () => {
    const prompt = buildUserPrompt({
      title: 'A teaching',
      lines: LINES,
      kinds: ['summary', 'mind_map'],
      steeringPrompt: null,
    });

    expect(prompt.startsWith('Teaching title: A teaching\n\n')).toBe(true);
    expect(prompt.indexOf(OFFSET_NOTE)).toBeLessThan(prompt.indexOf('Write the following:'));
    expect(prompt).toContain(`- summary: ${DRAFT_FIELD_INSTRUCTIONS.summary}`);
    expect(prompt).toContain(`- mindMap: ${DRAFT_FIELD_INSTRUCTIONS.mind_map}`);
    expect(prompt.endsWith('Transcript:\n[0] Good morning.\n[4000] We are in the second chapter.')).toBe(true);
    // A whole-teaching request says nothing about a chapter.
    expect(prompt).not.toContain('Chapter:');
  });

  it('introduces a chapter request as one chapter of the teaching, by title and summary', () => {
    const prompt = buildUserPrompt({
      title: 'A teaching',
      lines: LINES.slice(1),
      kinds: ['mind_map'],
      steeringPrompt: null,
      chapter: { title: 'The second chapter', summary: 'Where the letter goes next.' },
    });

    expect(prompt).toContain('Teaching title: A teaching\nChapter: The second chapter\n');
    expect(prompt).toContain('About this chapter: Where the letter goes next.');
    expect(prompt).toContain('this one chapter of the teaching, not the whole of it');
    // Only the chapter's lines travel.
    expect(prompt).not.toContain('[0] Good morning.');
    expect(prompt).toContain('[4000] We are in the second chapter.');
  });

  it('asks for themes and the concepts under them, with the caps named', () => {
    expect(DRAFT_FIELD_INSTRUCTIONS.mind_map).toContain(`${MIND_MAP_MAX_THEMES} themes`);
    expect(DRAFT_FIELD_INSTRUCTIONS.mind_map).toContain(`${MIND_MAP_MAX_POINTS} concepts`);
  });

  it('puts the admin’s steering sentence last, labelled as theirs', () => {
    const prompt = buildUserPrompt({
      title: 'A teaching',
      lines: LINES,
      kinds: ['summary'],
      steeringPrompt: 'Shorter.',
    });
    const steering = prompt.indexOf('asked for this specifically');
    expect(steering).toBeGreaterThan(prompt.indexOf('Write the following:'));
    expect(steering).toBeLessThan(prompt.indexOf('Transcript:'));
    expect(prompt).toContain('Shorter.');
  });
});
