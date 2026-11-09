/**
 * Base58 and Base58Check encoding, as used for Bitcoin addresses.
 *
 * Base58 is the base-64 alphabet minus the six characters that are easy to
 * misread (0, O, I, l, +, /). Each leading zero byte becomes a leading '1', so the
 * version byte 0x00 of a mainnet address is why addresses start with '1'.
 *
 * Base58Check appends a 4-byte checksum = first 4 bytes of sha256d(payload),
 * so a mistyped address is detected before any coins are sent to it.
 */
import { concatBytes, sha256d } from './hash';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Treat the bytes as one big-endian number and repeatedly divide by 58.
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;

  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET_INDEX.get(c);
    if (digit === undefined) throw new Error(`invalid Base58 character '${c}'`);
    n = n * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

function checksum(payload: Uint8Array): Uint8Array {
  return sha256d(payload).slice(0, 4);
}

/** Base58Check(payload) = Base58(payload ‖ first4(sha256d(payload))). */
export function base58CheckEncode(payload: Uint8Array): string {
  return base58Encode(concatBytes(payload, checksum(payload)));
}

/** Inverse of base58CheckEncode. Throws if the checksum does not match. */
export function base58CheckDecode(text: string): Uint8Array {
  const raw = base58Decode(text);
  if (raw.length < 4) throw new Error('Base58Check string too short');
  const payload = raw.slice(0, -4);
  const expected = checksum(payload);
  const actual = raw.slice(-4);
  if (!expected.every((b, i) => b === actual[i])) throw new Error('Base58Check checksum mismatch');
  return payload;
}
