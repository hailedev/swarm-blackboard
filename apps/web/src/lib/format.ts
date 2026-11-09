// Plain formatting helpers. Nothing here depends on the viewer's locale except the two
// clock functions, which tests therefore leave alone.

/** Dollars with four decimals by default: a run costs cents, and the cap is a quarter. */
export const usd = (amount: number, digits = 4): string => `$${amount.toFixed(digits)}`;

export const percent = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;

/** 950 → "950", 12 940 → "12.9K", 154 447 → "154K", 1 250 000 → "1.3M". */
export const compact = (n: number): string => {
  if (n < 1_000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000) return `${String(Math.round(n / 1_000))}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

const two = (n: number): string => String(n).padStart(2, '0');

/** 42 000 → "42s", 185 000 → "3m 05s", 3 720 000 → "1h 02m". */
export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${two(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${two(minutes % 60)}m`;
};

/** One line, cut at `max` characters with an ellipsis. */
export const excerpt = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

export const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
