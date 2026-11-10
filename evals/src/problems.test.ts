import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseProblemFile, problemText, rubricMaximum } from './problems';

const PROBLEMS = fileURLToPath(new URL('../problems', import.meta.url));

const file = (frontMatter: string, body = 'Statement.'): string =>
  `---\n${frontMatter}\n---\n${body}\n`;

const RUBRIC = `rubric:
  - { id: a, weight: 3, criterion: A, scale: "0 = none; 3 = all" }
  - { id: b, weight: 2, criterion: B, scale: "0 = none; 3 = all" }
  - { id: c, weight: 1, criterion: C, scale: "0 = none; 3 = all" }`;

describe('parseProblemFile', () => {
  it('reads the front matter and keeps the body as the statement', () => {
    const parsed = parseProblemFile(
      file(
        `id: demo\ntitle: Demo\ndomain: test\nconstraints: [one]\nsuccessCriteria: [two, three]\n${RUBRIC}`,
        'First line.\n\nSecond paragraph.',
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      id: 'demo',
      constraints: ['one'],
      successCriteria: ['two', 'three'],
      statement: 'First line.\n\nSecond paragraph.',
    });
    expect(parsed.value.rubric.map((c) => c.weight)).toEqual([3, 2, 1]);
    expect(rubricMaximum(parsed.value.rubric)).toBe(18);
    expect(problemText(parsed.value)).toBe(
      'First line.\n\nSecond paragraph.\n\n## Constraints\n- one\n\n## Success criteria\n- two\n- three',
    );
  });

  it('accepts Windows line endings', () => {
    const text = file(
      `id: demo\ntitle: Demo\ndomain: t\nconstraints: []\nsuccessCriteria: []\n${RUBRIC}`,
    ).replace(/\n/g, '\r\n');
    expect(parseProblemFile(text).ok).toBe(true);
  });

  it('names the file and the field when something is missing or wrong', () => {
    const missing = parseProblemFile(
      file(`id: demo\ndomain: t\nconstraints: []\nsuccessCriteria: []\n${RUBRIC}`),
      'x.md',
    );
    expect(!missing.ok && missing.error).toContain('x.md: title');
    const weight = parseProblemFile(
      file(
        `id: demo\ntitle: D\ndomain: t\nconstraints: []\nsuccessCriteria: []\nrubric:\n  - { id: a, weight: 9, criterion: A, scale: s }\n  - { id: b, weight: 1, criterion: B, scale: s }\n  - { id: c, weight: 1, criterion: C, scale: s }`,
      ),
    );
    expect(!weight.ok && weight.error).toContain('rubric.0.weight');
    const duplicate = parseProblemFile(
      file(
        `id: demo\ntitle: D\ndomain: t\nconstraints: []\nsuccessCriteria: []\nrubric:\n  - { id: a, weight: 1, criterion: A, scale: s }\n  - { id: a, weight: 1, criterion: B, scale: s }\n  - { id: c, weight: 1, criterion: C, scale: s }`,
      ),
    );
    expect(!duplicate.ok && duplicate.error).toContain('unique');
    expect(parseProblemFile('no front matter').ok).toBe(false);
    expect(parseProblemFile('---\nid: x\n').ok).toBe(false);
    expect(parseProblemFile('---\n- a list\n---\nbody').ok).toBe(false);
    expect(parseProblemFile('---\nid: [unclosed\n---\nbody').ok).toBe(false);
    expect(parseProblemFile(file('id: Demo Problem')).ok).toBe(false);
  });
});

describe('the committed problems', () => {
  it('all parse, have unique ids and rubrics that weigh something', async () => {
    const names = (await readdir(PROBLEMS)).filter((n) => n.endsWith('.md')).sort();
    expect(names.length).toBeGreaterThanOrEqual(10);
    const ids = new Set<string>();
    for (const name of names) {
      const parsed = parseProblemFile(await readFile(join(PROBLEMS, name), 'utf8'), name);
      expect(parsed.ok, name).toBe(true);
      if (!parsed.ok) continue;
      expect(ids.has(parsed.value.id), name).toBe(false);
      ids.add(parsed.value.id);
      expect(parsed.value.constraints.length, name).toBeGreaterThan(0);
      expect(parsed.value.successCriteria.length, name).toBeGreaterThan(0);
      expect(rubricMaximum(parsed.value.rubric), name).toBeGreaterThan(0);
      for (const c of parsed.value.rubric) expect(c.scale, `${name} ${c.id}`).toContain('3 =');
    }
  });
});
