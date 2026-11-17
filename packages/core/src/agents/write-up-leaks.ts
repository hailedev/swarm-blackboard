// What a final write-up must not say (prompts/write-up.md, "Who reads it"): where its
// content came from, and how sure its writer is. The prompt carries the instruction, and
// on the passes of 2026-11-17 two answers of three broke it all the same ("Confidence is
// moderate: …", "Confidence is held below 0.8 because …"); an earlier one said "which the
// board does not establish". This module finds such sentences so the controller can ask
// for the answer once more (controller.ts, ADR-0016). It never edits an answer.
//
// The words themselves are honest ones in the problems the swarm is given: a reading
// programme has "board games" and a "confidence survey", an API has a "User-Agent". So
// the patterns are phrases, not words: the board as something that knows or holds things,
// agents as the ones who did the work, confidence as the writer's own. And a word the
// problem statement itself uses is never held against the answer.

const SENTENCE_END = /(?<=[.!?])\s+/;

// "the board does not establish", "the board holds no evidence": a board that knows things.
const BOARD_AS_SOURCE =
  /\bthe board(?:'s)?\s+(?:does|did|do|shows?|showed|holds?|held|contains?|records?|lacks?|leaves?|left|has|had|is|was|establish(?:es|ed)?|suggests?|indicates?|says?|said|notes?|lists?|offers?|gives?|provides?)\b/i;
const BLACKBOARD = /\bblackboard\b/i;

// The prompt calls the board "the working notes"; an answer that reports on them leaks too.
const WORKING_NOTES = /\bworking notes\b/i;
const NOTES_AS_SOURCE =
  /\bthe notes\s+(?:do|does|did|show|say|hold|establish|leave|lack|contain|suggest|indicate|are|were|have|had|offer|give|provide)\b/i;

const AGENTS =
  /\bthe agents\b|\b(?:an|one|another|each|every|no) agent\b|\bagents\s+(?:disagree\w*|agree\w*|propos\w*|suggest\w*|found|raised|argu\w*|conclud\w*|did|do|were|are|have|had)\b|\bmulti-agent\b|\bswarm\b/i;

// The writer's own confidence. A sentence or clause that opens on it and grades it
// ("Confidence is moderate", "Overall confidence remains fairly low", "Confidence: 0.7"),
// a possessive, or a graded confidence anywhere. "Reading confidence is measured in week
// 1" and "a rise in the confidence items" are neither.
const GRADE = String.raw`(?:low|moderate|medium|high|limited|modest|held|kept|capped|reduced|tempered|lower|higher|below|above|around|about|at|\d|0?\.\d)`;
const CONFIDENCE_OPENS = new RegExp(
  String.raw`(?:^|[;:(]\s*)(?:overall,?\s+)?(?:the\s+)?(?:overall\s+)?confidence(?:\s+level)?\s*(?:(?:is|remains|stays|was)\s+(?:\w+ly\s+)?${GRADE}|[:=(]\s*${GRADE})`,
  'i',
);
const CONFIDENCE_OWN =
  /\b(?:my|our)\s+(?:own\s+|overall\s+)?confidence\b|\boverall\s+confidence\b|\bconfidence\s+in\s+this\s+(?:answer|recommendation|plan|proposal|assessment|approach|conclusion|design|estimate)\b/i;
const CONFIDENCE_GRADED = /\b(?:low|moderate|medium|high)[\s-]confidence\b/i;

interface Family {
  /** The word that, used by the problem statement, makes the family's phrases honest. */
  word: RegExp;
  patterns: readonly RegExp[];
}

const FAMILIES: readonly Family[] = [
  { word: /\b(?:black)?boards?\b/i, patterns: [BOARD_AS_SOURCE, BLACKBOARD] },
  { word: /\bnotes\b/i, patterns: [WORKING_NOTES, NOTES_AS_SOURCE] },
  { word: /\bagents?\b|\bswarms?\b/i, patterns: [AGENTS] },
  {
    word: /\bconfiden(?:ce|t)\b/i,
    patterns: [CONFIDENCE_OPENS, CONFIDENCE_OWN, CONFIDENCE_GRADED],
  },
];

/** The most sentences a retry is shown or an event records. */
export const MAX_LEAKS_REPORTED = 5;
const MAX_SENTENCE_CHARS = 240;

const clip = (sentence: string): string =>
  sentence.length <= MAX_SENTENCE_CHARS
    ? sentence
    : `${sentence.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…`;

/**
 * The sentences of an answer that mention the board, the agents or the writer's own
 * confidence, in the order they appear, each once and clipped, at most
 * `MAX_LEAKS_REPORTED`. Empty when the answer is clean. `problemText` is the statement
 * with its constraints and success criteria: a family of phrases whose word the problem
 * itself uses is not looked for.
 */
export const findLeaks = (paragraphs: readonly string[], problemText: string): string[] => {
  const patterns = FAMILIES.filter((family) => !family.word.test(problemText)).flatMap(
    (family) => family.patterns,
  );
  const found: string[] = [];
  for (const paragraph of paragraphs) {
    for (const raw of paragraph.split(SENTENCE_END)) {
      const sentence = raw.trim();
      if (sentence.length === 0) continue;
      if (!patterns.some((pattern) => pattern.test(sentence))) continue;
      const clipped = clip(sentence);
      if (!found.includes(clipped)) found.push(clipped);
      if (found.length === MAX_LEAKS_REPORTED) return found;
    }
  }
  return found;
};
