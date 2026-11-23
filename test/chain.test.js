'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { merkleRoot, merkleProof, verifyMerkleProof, generateKeys, sha256, canonical, sign } = require('../ledger/src/crypto');
const { Chain, genesis, makeEntry, verifyProof } = require('../ledger/src/chain');
const { normalizeReading, readingHash, checkDeviceSignature } = require('../ledger/src/reading');
const { Store } = require('../ledger/src/store');

const reading = (i, extra) => ({ instrumentId: 'PZ-01', takenAt: new Date(Date.UTC(2020, 7, 2, 19, i)).toISOString(), value: 40 + i / 10, unit: 'kPa', ...extra });
const clone = (x) => JSON.parse(JSON.stringify(x));

test('canonical JSON does not depend on key order', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), canonical({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
});

test('Merkle proofs verify for every leaf and size, and fail for a wrong leaf', () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = Array.from({ length: n }, (_, i) => sha256('leaf' + i));
    const root = merkleRoot(leaves);
    leaves.forEach((leaf, i) => assert.ok(verifyMerkleProof(leaf, merkleProof(leaves, i), root), `n=${n} i=${i}`));
    assert.equal(verifyMerkleProof(sha256('other'), merkleProof(leaves, 0), root), false);
  }
});

test('readings are normalized and the comma decimal of field data is accepted', () => {
  const r = normalizeReading({ instrumentId: ' PZ-01 ', takenAt: '2020-08-02T19:00:00Z', value: '43,948', unit: 'kPa' });
  assert.deepEqual(r, { instrumentId: 'PZ-01', takenAt: '2020-08-02T19:00:00.000Z', value: 43.948, unit: 'kPa' });
  assert.throws(() => normalizeReading({ instrumentId: 'x', takenAt: 'not a date', value: 1 }), /takenAt/);
  assert.throws(() => normalizeReading({ instrumentId: 'x', takenAt: '2020-01-01', value: NaN }), /value/);
  assert.throws(() => normalizeReading({ takenAt: '2020-01-01', value: 1 }), /instrumentId/);
});

test('device signatures: registered devices must sign, and a forged signature fails', () => {
  const dev = generateKeys();
  const r = normalizeReading(reading(1, { deviceId: 'logger-7' }));
  const good = sign(readingHash(r), dev.privateKey);
  const devices = { 'logger-7': dev.publicKey };
  assert.equal(checkDeviceSignature(r, good, devices).ok, true);
  assert.equal(checkDeviceSignature(r, undefined, devices).ok, false);
  assert.equal(checkDeviceSignature({ ...r, value: 99 }, good, devices).ok, false);
  assert.equal(checkDeviceSignature(normalizeReading(reading(2)), undefined, devices).reason, 'unsigned');
});

function buildChain(nBlocks, perBlock) {
  const a = generateKeys();
  const b = generateKeys();
  const chain = new Chain({ chainId: 'test', authorities: [a.publicKey, b.publicKey] });
  let k = 0;
  for (let i = 0; i < nBlocks; i++) {
    const entries = Array.from({ length: perBlock }, () => makeEntry(reading(k++)));
    chain.seal(entries, i % 2 ? b : a);
  }
  return { chain, a, b };
}

test('a sealed chain validates from scratch and gives a verifiable proof for each reading', () => {
  const { chain, a, b } = buildChain(4, 3);
  const again = Chain.fromBlocks(clone(chain.blocks), { chainId: 'test', authorities: [a.publicKey, b.publicKey] });
  assert.equal(again.height, 4);
  for (const block of chain.blocks.slice(1)) {
    for (const e of block.entries) {
      const p = chain.proof(e.hash);
      assert.equal(verifyProof(clone(p), [a.publicKey, b.publicKey]).ok, true);
    }
  }
  assert.equal(chain.proof(sha256('nope')), null);
});

test('tampering anywhere is detected', () => {
  const { chain, a, b } = buildChain(3, 2);
  const opts = { chainId: 'test', authorities: [a.publicKey, b.publicKey] };
  const cases = {
    'changed reading value': (bl) => { bl[2].entries[0].reading.value = 1; },
    'changed reading hash too': (bl) => { bl[2].entries[0].reading.value = 1; bl[2].entries[0].hash = readingHash(bl[2].entries[0].reading); },
    'removed a reading': (bl) => { bl[2].entries.pop(); },
    'swapped block order': (bl) => { [bl[1], bl[2]] = [bl[2], bl[1]]; },
    'rewritten header': (bl) => { bl[1].header.timestamp = new Date().toISOString(); },
    'forged signature': (bl) => { bl[3].signature = bl[2].signature; },
    'sealed by an outsider': (bl) => { const o = generateKeys(); bl[3].header.sealer = o.publicKey; },
    'other network genesis': (bl) => { bl[0] = genesis('another'); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const blocks = clone(chain.blocks);
    mutate(blocks);
    assert.throws(() => Chain.fromBlocks(blocks, opts), Error, name);
  }
});

test('the same reading cannot be anchored twice', () => {
  const { chain, a } = buildChain(1, 2);
  assert.throws(() => chain.seal([clone(chain.blocks[1].entries[0])], a), /appears twice/);
});

test('a proof is rejected when the reading, the path or the signature is altered', () => {
  const { chain, a, b } = buildChain(2, 5);
  const auth = [a.publicKey, b.publicKey];
  const p = chain.proof(chain.blocks[2].entries[3].hash);
  const bad1 = clone(p); bad1.entry.reading.value = 0;
  const bad2 = clone(p); bad2.merkleProof[0].hash = sha256('x');
  const bad3 = clone(p); bad3.block.signature = clone(chain.proof(chain.blocks[1].entries[0].hash)).block.signature;
  for (const bad of [bad1, bad2, bad3]) assert.equal(verifyProof(bad, auth).ok, false);
  assert.equal(verifyProof(clone(p), [generateKeys().publicKey]).ok, false);
});

test('fork choice is the same on every peer: longer chain, then lower tip hash', () => {
  const x = buildChain(2, 1).chain;
  const y = buildChain(3, 1).chain;
  assert.equal(x.isBetter(y), true);
  assert.equal(y.isBetter(x), false);
  const z = buildChain(3, 1).chain;
  assert.notEqual(y.isBetter(z), z.isBetter(y));
});

test('the store reloads exactly what was written and a tampered file is refused', () => {
  const { chain, a, b } = buildChain(3, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-'));
  const store = new Store(path.join(dir, 'chain.jsonl'));
  chain.blocks.slice(1).forEach((bl) => store.append(bl));
  const opts = { chainId: 'test', authorities: [a.publicKey, b.publicKey] };
  assert.equal(Chain.fromBlocks([genesis('test'), ...store.load()], opts).tip.hash, chain.tip.hash);
  const text = fs.readFileSync(store.file, 'utf8').replace('"value":40.1', '"value":40.2');
  fs.writeFileSync(store.file, text);
  assert.throws(() => Chain.fromBlocks([genesis('test'), ...store.load()], opts), /altered/);
});
