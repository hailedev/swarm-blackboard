// A deliberately small YAML reader for agents.yaml: block mappings by indentation, single-
// line flow mappings `{ k: v, k2: v2 }`, scalars, and `#` comments. It refuses anything
// else (sequences, multi-line strings, anchors) with a line number rather than guessing,
// which for a config file we author ourselves is safer than a permissive parser.
//
// It exists so that Phase 2 does not add a YAML dependency that docs/PLAN.md does not
// name. Swapping it for the `yaml` package is a one-file change.

export type YamlScalar = string | number | boolean | null;
export type YamlMapping = { [key: string]: YamlValue };
export type YamlValue = YamlScalar | YamlMapping;

export class YamlSubsetError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${String(line)}: ${message}`);
    this.name = 'YamlSubsetError';
    this.line = line;
  }
}

// Drop a `#` comment that starts the line or follows whitespace, outside quotes.
const stripComment = (raw: string): string => {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || raw[i - 1] === ' ')) return raw.slice(0, i);
  }
  return raw;
};

const scalar = (text: string, line: number): YamlScalar => {
  const value = text.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  if (quoted !== null) return quoted[1] ?? '';
  if (value.startsWith('[') || value.startsWith('{')) {
    throw new YamlSubsetError(line, `unsupported value "${value}"`);
  }
  return value;
};

// `key: value` → [key, rest]. Splits on the first ": " (or a trailing ":") so values
// such as `qwen3.6:35b-mlx` keep their colon.
const splitKey = (text: string, line: number): [string, string] => {
  const match = /^([A-Za-z0-9_.\-"']+)\s*:(?:\s+(.*)|\s*)$/.exec(text.trim());
  if (match === null)
    throw new YamlSubsetError(line, `expected "key: value", got "${text.trim()}"`);
  const key = (match[1] ?? '').replace(/^["']|["']$/g, '');
  return [key, (match[2] ?? '').trim()];
};

const flowMapping = (text: string, line: number): YamlMapping => {
  if (!text.endsWith('}')) throw new YamlSubsetError(line, 'unterminated flow mapping');
  const inner = text.slice(1, -1).trim();
  const result: YamlMapping = {};
  if (inner === '') return result;
  for (const part of inner.split(',')) {
    if (part.trim() === '') throw new YamlSubsetError(line, 'empty entry in flow mapping');
    const [key, rest] = splitKey(part, line);
    if (rest.startsWith('{') || rest.startsWith('[')) {
      throw new YamlSubsetError(line, 'nested flow collections are not supported');
    }
    if (key in result) throw new YamlSubsetError(line, `duplicate key "${key}"`);
    result[key] = scalar(rest, line);
  }
  return result;
};

const value = (rest: string, line: number): YamlValue =>
  rest.startsWith('{') ? flowMapping(rest, line) : scalar(rest, line);

interface Frame {
  indent: number;
  node: YamlMapping;
}

interface PendingKey {
  frame: Frame;
  key: string;
  indent: number;
}

export const parseYamlSubset = (source: string): YamlMapping => {
  const root: YamlMapping = {};
  const stack: Frame[] = [{ indent: -1, node: root }];
  let pending: PendingKey | null = null;

  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = index + 1;
    if (raw.includes('\t')) throw new YamlSubsetError(line, 'tabs are not allowed');
    const text = stripComment(raw);
    const body = text.trim();
    if (body === '') continue;
    if (body === '-' || body.startsWith('- ')) {
      throw new YamlSubsetError(line, 'sequences are not supported');
    }
    const indent = text.length - text.trimStart().length;

    // A key with nothing after the colon owns the more-indented lines that follow it.
    if (pending !== null) {
      if (indent > pending.indent) {
        const child: YamlMapping = {};
        pending.frame.node[pending.key] = child;
        stack.push({ indent: pending.indent, node: child });
      } else {
        pending.frame.node[pending.key] = null;
      }
      pending = null;
    }

    while (stack.length > 1 && indent <= (stack.at(-1)?.indent ?? -1)) stack.pop();
    const frame = stack.at(-1);
    if (frame === undefined) throw new YamlSubsetError(line, 'internal: empty frame stack');

    const [key, rest] = splitKey(body, line);
    if (key in frame.node) throw new YamlSubsetError(line, `duplicate key "${key}"`);
    if (rest === '') pending = { frame, key, indent };
    else frame.node[key] = value(rest, line);
  }

  if (pending !== null) pending.frame.node[pending.key] = null;
  return root;
};
