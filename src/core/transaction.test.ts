import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, sha256d, utf8ToBytes } from './hash';
import { generateKeyPair, keyPairFromPrivate } from './keys';
import {
  COIN,
  type StandardTx,
  type TxOutput,
  checkInputAuthorization,
  createCoinbase,
  isCoinbase,
  outPointKey,
  serializeTx,
  signTransaction,
  totalOutputValue,
  txid,
  txidHex,
} from './transaction';

// Fixed keys so serialized bytes and txids are reproducible.
const alice = keyPairFromPrivate(hexToBytes('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725'));
const bob = keyPairFromPrivate(hexToBytes('0000000000000000000000000000000000000000000000000000000000000001'));

const fundingTx = createCoinbase(1, alice.address, 50 * COIN);
const fundingOut: TxOutput = fundingTx.outputs[0];
const prevOut = { txid: txid(fundingTx), index: 0 };

const payBob = (amount = 30 * COIN): StandardTx =>
  signTransaction(
    [{ prevOut, key: alice }],
    [
      { value: amount, address: bob.address },
      { value: 50 * COIN - amount - 1000, address: alice.address }, // change, 1000-unit fee
    ],
  );

describe('coinbase', () => {
  it('has no inputs and pays the miner', () => {
    expect(isCoinbase(fundingTx)).toBe(true);
    expect(fundingTx.outputs).toEqual([{ value: 50 * COIN, address: alice.address }]);
    expect(totalOutputValue(fundingTx)).toBe(50 * COIN);
  });

  it('txid is pinned (regression check on the serialization format)', () => {
    // If this changes, the byte format changed. Update it only on purpose.
    expect(bytesToHex(serializeTx(fundingTx))).toBe(
      '01' + '00000001' + '00000000' + '00000001' + '000000012a05f200' + '00f54a5851e9372b87810a8e60cdd2e7cfd80b6e31',
    );
    expect(txidHex(fundingTx)).toBe(bytesToHex(sha256d(serializeTx(fundingTx))));
  });

  it('height makes otherwise identical coinbases distinct', () => {
    expect(txidHex(createCoinbase(2, alice.address, 50 * COIN))).not.toBe(txidHex(fundingTx));
  });
});

describe('txid', () => {
  it('is sha256d of the witness-free serialization', () => {
    const tx = payBob();
    expect(txid(tx)).toHaveLength(32);
    expect(txidHex(tx)).toBe(bytesToHex(sha256d(serializeTx(tx, { withWitness: false }))));
  });

  it('does not depend on signatures or public keys', () => {
    const tx = payBob();
    const stripped: StandardTx = {
      ...tx,
      inputs: tx.inputs.map((i) => ({ ...i, publicKey: new Uint8Array(), signature: new Uint8Array() })),
    };
    expect(txidHex(stripped)).toBe(txidHex(tx));
    // ...but the full serialization does include them.
    expect(serializeTx(tx).length).toBeGreaterThan(serializeTx(tx, { withWitness: false }).length);
  });

  it('changes when an input or output changes', () => {
    const base = txidHex(payBob());
    expect(txidHex(payBob(29 * COIN))).not.toBe(base);
    const otherInput = signTransaction(
      [{ prevOut: { ...prevOut, index: 1 }, key: alice }],
      payBob().outputs,
    );
    expect(txidHex(otherInput)).not.toBe(base);
  });

  it('a standard tx and a coinbase never share an encoding', () => {
    const emptyStandard: StandardTx = { kind: 'standard', inputs: [], outputs: fundingTx.outputs };
    expect(serializeTx(emptyStandard)[0]).toBe(0);
    expect(serializeTx(fundingTx)[0]).toBe(1);
  });
});

describe('serializeTx input checks', () => {
  const out = (value: number, address = bob.address): StandardTx => ({
    kind: 'standard',
    inputs: [],
    outputs: [{ value, address }],
  });

  it('rejects bad output values', () => {
    expect(() => serializeTx(out(-1))).toThrow(/value/);
    expect(() => serializeTx(out(1.5))).toThrow(/value/);
    expect(() => serializeTx(out(2 ** 53))).toThrow(/value/);
  });

  it('rejects bad addresses', () => {
    expect(() => serializeTx(out(1, 'nope'))).toThrow(/invalid address/);
    expect(() => serializeTx(out(1, bob.address.slice(0, -1) + 'x'))).toThrow(/invalid address/);
  });

  it('rejects malformed outpoints', () => {
    const bad = (txidBytes: Uint8Array, index: number): StandardTx => ({
      kind: 'standard',
      inputs: [{ prevOut: { txid: txidBytes, index }, publicKey: new Uint8Array(), signature: new Uint8Array() }],
      outputs: [],
    });
    expect(() => serializeTx(bad(new Uint8Array(31), 0))).toThrow(/32 bytes/);
    expect(() => serializeTx(bad(new Uint8Array(32), -1))).toThrow(/index/);
    expect(() => serializeTx(bad(new Uint8Array(32), 2 ** 32))).toThrow(/index/);
  });
});

describe('signing and input authorization', () => {
  it('a correctly signed spend is authorized', () => {
    const tx = payBob();
    expect(tx.inputs[0].signature).toHaveLength(64);
    expect(bytesToHex(tx.inputs[0].publicKey)).toBe(bytesToHex(alice.publicKey));
    expect(checkInputAuthorization(tx, 0, fundingOut)).toBeNull();
  });

  it('signs every input over the same txid', () => {
    const second = createCoinbase(2, alice.address, 50 * COIN);
    const tx = signTransaction(
      [
        { prevOut, key: alice },
        { prevOut: { txid: txid(second), index: 0 }, key: alice },
      ],
      [{ value: 99 * COIN, address: bob.address }],
    );
    expect(checkInputAuthorization(tx, 0, fundingOut)).toBeNull();
    expect(checkInputAuthorization(tx, 1, second.outputs[0])).toBeNull();
  });

  it('editing an output after signing breaks the signature', () => {
    const tx = payBob();
    const tampered: StandardTx = { ...tx, outputs: [{ ...tx.outputs[0], value: 49 * COIN }, tx.outputs[1]] };
    expect(checkInputAuthorization(tampered, 0, fundingOut)).toBe('bad-signature');
  });

  it("someone else's key cannot spend Alice's output", () => {
    const mallory = generateKeyPair();
    // Mallory signs with her own key: her public key doesn't hash to Alice's address.
    const theft = signTransaction([{ prevOut, key: mallory }], [{ value: 50 * COIN, address: mallory.address }]);
    expect(checkInputAuthorization(theft, 0, fundingOut)).toBe('wrong-public-key');
    // Mallory copies Alice's public key but can only sign with her own private key.
    const forged: StandardTx = { ...theft, inputs: [{ ...theft.inputs[0], publicKey: alice.publicKey }] };
    expect(checkInputAuthorization(forged, 0, fundingOut)).toBe('bad-signature');
  });

  it('a signature from one transaction cannot be reused on another', () => {
    const tx = payBob();
    const other = payBob(10 * COIN);
    const replayed: StandardTx = { ...other, inputs: [{ ...other.inputs[0], signature: tx.inputs[0].signature }] };
    expect(checkInputAuthorization(replayed, 0, fundingOut)).toBe('bad-signature');
  });

  it('throws for an input index that does not exist', () => {
    expect(() => checkInputAuthorization(payBob(), 1, fundingOut)).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('outPointKey is "txid:index"', () => {
    expect(outPointKey({ txid: sha256d(utf8ToBytes('x')), index: 3 })).toBe(
      `${bytesToHex(sha256d(utf8ToBytes('x')))}:3`,
    );
  });

  it('totalOutputValue sums outputs', () => {
    expect(totalOutputValue(payBob())).toBe(50 * COIN - 1000);
  });
});
