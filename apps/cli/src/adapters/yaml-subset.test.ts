import { describe, expect, it } from 'vitest';

import { parseYamlSubset, YamlSubsetError } from './yaml-subset';

describe('parseYamlSubset', () => {
  it('reads the agents.yaml shape: nested mappings, flow mappings, comments and scalars', () => {
    const source = [
      '# agents.yaml',
      'defaultProfile: dev',
      '',
      'models:',
      '  sonnet: { provider: anthropic, model: claude-sonnet-5-5 }',
      '  local:  { provider: ollama, model: qwen3.6:35b-mlx, think: false }',
      '  local-think: { provider: ollama, model: qwen3.6:35b-mlx, think: true }',
      '',
      'profiles:',
      '  dev:                         # zero API spend; the default',
      '    fallback: none             # schema failure → repair once → discard and log',
      '    roles:',
      '      planner: local',
      '      solver: local-think',
      '  cheap:',
      '    fallback: sonnet',
      '    roles:',
      '      planner: sonnet',
      '',
      'agents:',
      '  planner:     { prompt: prompts/planner.md }',
      'misc:',
      '  count: 3',
      '  ratio: 0.8',
      '  quoted: "a: b # not a comment"',
      "  single: 'x'",
      '  empty:',
      '  nothing: ~',
    ].join('\n');

    expect(parseYamlSubset(source)).toEqual({
      defaultProfile: 'dev',
      models: {
        sonnet: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        local: { provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false },
        'local-think': { provider: 'ollama', model: 'qwen3.6:35b-mlx', think: true },
      },
      profiles: {
        dev: { fallback: 'none', roles: { planner: 'local', solver: 'local-think' } },
        cheap: { fallback: 'sonnet', roles: { planner: 'sonnet' } },
      },
      agents: { planner: { prompt: 'prompts/planner.md' } },
      misc: {
        count: 3,
        ratio: 0.8,
        quoted: 'a: b # not a comment',
        single: 'x',
        empty: null,
        nothing: null,
      },
    });
  });

  it('accepts Windows line endings and an empty document', () => {
    expect(parseYamlSubset('a: 1\r\nb:\r\n  c: two\r\n')).toEqual({ a: 1, b: { c: 'two' } });
    expect(parseYamlSubset('')).toEqual({});
    expect(parseYamlSubset('# only a comment\n')).toEqual({});
  });

  it.each([
    ['tabs', 'a:\n\tb: 1', 'tabs are not allowed'],
    ['sequences', 'a:\n  - one', 'sequences are not supported'],
    ['an unterminated flow mapping', 'a: { b: 1', 'unterminated flow mapping'],
    ['nested flow collections', 'a: { b: { c: 1 } }', 'nested flow collections are not supported'],
    ['a flow sequence value', 'a: [1, 2]', 'unsupported value'],
    ['a duplicate key', 'a: 1\na: 2', 'duplicate key "a"'],
    ['a line without a key', 'a:\n  just text', 'expected "key: value"'],
  ])('rejects %s with the line number', (_label, source, message) => {
    expect(() => parseYamlSubset(source)).toThrow(YamlSubsetError);
    expect(() => parseYamlSubset(source)).toThrow(message);
    expect(() => parseYamlSubset(source)).toThrow(/^line \d+:/);
  });
});
