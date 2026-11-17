import { describe, expect, it } from 'vitest';

import { findLeaks, MAX_LEAKS_REPORTED } from './write-up-leaks';

const PROBLEM =
  'A public library branch wants to run a six-week programme for 13-to-17-year-olds on $500.';

const leaks = (text: string, problem: string = PROBLEM): string[] => findLeaks([text], problem);

describe('findLeaks', () => {
  // The three sentences the passes of November 2026 produced, as they stood in the answers.
  it.each([
    'Confidence is moderate: the algorithm choice is well supported, while the cross-region accuracy bound and the account-abuse control are the parts most likely to change.',
    'Confidence is held below 0.8 because the format-acceptance test in Phase 1 has not yet been verified, so the recommendation is conditional on it.',
    'The follow-up count depends on the school term dates, which the board does not establish.',
  ])('finds a leak the swarm really wrote: %s', (sentence) => {
    expect(leaks(`The plan runs for six weeks. ${sentence} The budget is $500.`)).toEqual([
      sentence,
    ]);
  });

  it.each([
    ['the board as a source', 'The board holds no evidence on volunteer numbers.'],
    ['the blackboard by name', 'Entries on the blackboard point to a peer-recruiter scheme.'],
    ['the working notes', 'The working notes leave the venue open.'],
    ['the notes as a source', 'The notes do not establish how many volunteers can be found.'],
    ['the agents', 'The agents disagreed on the session length.'],
    ['one agent', 'One agent proposed a four-week pilot instead.'],
    ['the swarm', 'The swarm converged on a weekly session.'],
    ['a graded confidence after a colon', 'Recommendation stands; confidence: 0.7.'],
    ['confidence that remains', 'Overall confidence remains fairly low until week 2.'],
    ['a possessive', 'Our confidence in the budget is limited by the missing quotes.'],
    ['confidence in this plan', 'Confidence in this plan rests on the school partnership.'],
    ['a graded confidence', 'This is a moderate-confidence recommendation.'],
    ['high confidence', 'The attendance target can be met with high confidence.'],
  ])('finds %s', (_label, sentence) => {
    expect(leaks(sentence)).toEqual([sentence]);
  });

  // Honest sentences from the baselines and write-ups on disk, and the words ADR-0014 named.
  it.each([
    'Success is a visible rise in the welcome and confidence items, and a meaningful number of new card holders.',
    'A three-item pre and post survey covers confidence in using library resources, intention to return and belonging.',
    'Reading confidence is measured in week 1 and again in week 6.',
    'Confidence is one of three items on the survey.',
    'Week 3 is a board games evening, with the board games borrowed from the youth centre.',
    'The rule is applied across the board, to every client tier.',
    'Clients are identified by API key, never by the User-Agent header.',
    'Support agents answer the tickets the new flow generates.',
    'The release notes are published with every build.',
    'The team reviews the figures at the end of every quarter.',
    'Assumption: both schools agree to host a sign-up table; if one declines, sign-up moves to the branch.',
  ])('leaves an honest sentence alone: %s', (sentence) => {
    expect(leaks(sentence)).toEqual([]);
  });

  it('never holds a word the problem statement uses against the answer', () => {
    const board = 'The board has to approve the budget before week 1.';
    expect(leaks(board)).toEqual([board]);
    expect(leaks(board, 'The library board must approve any spend over $200.')).toEqual([]);

    const agents = 'The agents are trained on the new flow before launch.';
    expect(leaks(agents)).toEqual([agents]);
    expect(leaks(agents, 'Support agents handle 400 tickets a week.')).toEqual([]);

    // In a problem about a notes app "the notes" are the user's; anywhere else they are ours.
    const notes = 'The notes are merged field by field.';
    expect(leaks(notes)).toEqual([notes]);
    expect(leaks(notes, 'A note-taking app syncs notes between devices.')).toEqual([]);
    const source = 'The notes do not say which device wins.';
    expect(leaks(source)).toEqual([source]);
    expect(leaks(source, 'A note-taking app syncs notes between devices.')).toEqual([]);

    const confidence = 'Confidence is high that the pilot will fill.';
    expect(leaks(confidence)).toEqual([confidence]);
    expect(leaks(confidence, 'How confident can the manager be in the result?')).toEqual([]);
    // One family is excused, not all of them.
    expect(
      leaks('The board does not establish this.', 'How confident can the manager be?'),
    ).toEqual(['The board does not establish this.']);
  });

  it('returns each offending sentence once, in order, clipped, and no more than it reports', () => {
    const first = 'Confidence is moderate.';
    const second = 'The board does not establish the term dates.';
    expect(findLeaks([`Run it weekly. ${first}`, `${second} ${first}`], PROBLEM)).toEqual([
      first,
      second,
    ]);

    const long = `The agents found ${'a very long list of things, '.repeat(20)}and stopped.`;
    const [clipped] = leaks(long);
    expect(clipped?.length).toBe(240);
    expect(clipped?.endsWith('…')).toBe(true);

    const many = Array.from(
      { length: MAX_LEAKS_REPORTED + 3 },
      (_, i) => `The board does not establish point ${String(i + 1)}.`,
    );
    expect(findLeaks(many, PROBLEM)).toHaveLength(MAX_LEAKS_REPORTED);
  });

  it('finds nothing in an empty answer', () => {
    expect(findLeaks([], PROBLEM)).toEqual([]);
    expect(findLeaks(['   '], PROBLEM)).toEqual([]);
  });
});
