import type { Clock, IdGenerator } from '@team/core';

export type RandomFill = (bytes: Uint8Array) => Uint8Array;

const defaultFill: RandomFill = (bytes) => globalThis.crypto.getRandomValues(bytes);

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// RFC 9562 UUID version 7: 48-bit millisecond timestamp, version and variant
// bits, 74 random bits. Time-ordered across milliseconds; Postgres-portable.
export const createUuidV7Generator = (
  clock: Clock,
  fill: RandomFill = defaultFill,
): IdGenerator => ({
  next(): string {
    const bytes = fill(new Uint8Array(16));
    const ms = clock.nowMs();
    const high = Math.floor(ms / 0x1_0000_0000); // top 16 bits of the 48-bit timestamp
    const low = ms % 0x1_0000_0000; // low 32 bits
    bytes[0] = (high >>> 8) & 0xff;
    bytes[1] = high & 0xff;
    bytes[2] = (low >>> 24) & 0xff;
    bytes[3] = (low >>> 16) & 0xff;
    bytes[4] = (low >>> 8) & 0xff;
    bytes[5] = low & 0xff;
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
    const h = hex(bytes);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
});
