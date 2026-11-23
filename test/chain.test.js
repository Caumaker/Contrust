'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { merkleRoot, merkleProof, verifyMerkleProof, generateKeys, sha256, canonical, sign } = require('../ledger/src/crypto');
const { Chain, genesis, makeEntry, verifyProof, sanitizeBlock } = require('../ledger/src/chain');
const { normalizeReading, readingHash, checkDeviceSignature } = require('../ledger/src/reading');
const { Store } = require('../ledger/src/store');
const { sameToken } = require('../ledger/src/peer');

const reading = (i, extra) => ({ instrumentId: 'PZ-01', takenAt: new Date(Date.UTC(2020, 7, 2, 19, i)).toISOString(), value: 40 + i / 10, unit: 'kPa', ...extra });
const clone = (x) => JSON.parse(JSON.stringify(x));

// three authorities; each block proposed by the leader and signed by `signers` of them (2 = quorum)
function network() {
  const keys = [generateKeys(), generateKeys(), generateKeys()];
  const byPub = Object.fromEntries(keys.map((k) => [k.publicKey, k]));
  const opts = { chainId: 'test', authorities: keys.map((k) => k.publicKey) };
  return { keys, byPub, opts };
}
function certified(chain, net, entries, signers = 2) {
  const leader = net.byPub[chain.leaderFor(chain.height + 1)];
  const p = chain.propose(entries, leader);
  for (const k of net.keys.filter((x) => x !== leader).slice(0, signers - 1)) p.signatures.push({ signer: k.publicKey, signature: sign(p.hash, k.privateKey) });
  return p;
}
function buildChain(nBlocks, perBlock) {
  const net = network();
  const chain = new Chain(net.opts);
  let k = 0;
  for (let i = 0; i < nBlocks; i++) chain.append(certified(chain, net, Array.from({ length: perBlock }, () => makeEntry(reading(k++)))));
  return { chain, net };
}

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

test('readings: strict about values and time zones, tolerant of the comma decimal of field data', () => {
  assert.deepEqual(normalizeReading({ instrumentId: ' PZ-01 ', takenAt: '2020-08-02T16:00:00-03:00', value: '43,948', unit: 'kPa' }),
    { instrumentId: 'PZ-01', takenAt: '2020-08-02T19:00:00.000Z', value: 43.948, unit: 'kPa' });
  for (const [bad, msg] of [
    [{ takenAt: 'not a date', value: 1 }, /takenAt/], [{ takenAt: '2020-08-02T19:00', value: 1 }, /time zone/], [{ takenAt: null, value: 1 }, /takenAt/],
    [{ takenAt: '2020-01-01T00:00Z', value: '' }, /value/], [{ takenAt: '2020-01-01T00:00Z', value: '0x1A' }, /value/], [{ takenAt: '2020-01-01T00:00Z', value: NaN }, /value/],
  ]) assert.throws(() => normalizeReading({ instrumentId: 'x', ...bad }), msg);
  assert.throws(() => normalizeReading({ takenAt: '2020-01-01T00:00Z', value: 1 }), /instrumentId/);
});

test('device signatures: registered devices must sign, a forged one fails, and the format is checked', () => {
  const dev = generateKeys();
  const r = normalizeReading(reading(1, { deviceId: 'logger-7' }));
  const good = sign(readingHash(r), dev.privateKey);
  const devices = { 'logger-7': dev.publicKey };
  assert.equal(checkDeviceSignature(r, good, devices).ok, true);
  assert.equal(checkDeviceSignature(r, undefined, devices).ok, false);
  assert.equal(checkDeviceSignature({ ...r, value: 99 }, good, devices).ok, false);
  assert.throws(() => makeEntry(r, 'x'.repeat(5000)), /base64 Ed25519/);
});

test('a certified chain validates from scratch and every reading has a proof checked against our own authority list', () => {
  const { chain, net } = buildChain(4, 3);
  const again = Chain.fromBlocks(clone(chain.blocks), net.opts);
  assert.equal(again.height, 4);
  for (const block of chain.blocks.slice(1)) {
    for (const e of block.entries) {
      const v = verifyProof(clone(chain.proof(e.hash)), net.opts.authorities, { hash: e.hash, chainId: 'test' });
      assert.equal(v.ok, true, v.reason);
    }
  }
  assert.equal(chain.proof(sha256('nope')), null);
});

test('ONE authority alone cannot make a block, nor a longer history offline', () => {
  const { chain, net } = buildChain(2, 1);
  const solo = certified(chain, net, [makeEntry(reading(50))], 1);
  assert.throws(() => chain.append(solo), /1 valid authority signature\(s\), needs 2/);
  // the same authority signing twice does not count twice
  solo.signatures.push(clone(solo.signatures[0]));
  assert.throws(() => chain.append(solo), /needs 2/);
  // a rival history built alone from genesis is refused whatever its length
  const rogue = new Chain(net.opts);
  const fake = [genesis('test')];
  for (let i = 0; i < 5; i++) {
    const p = rogue.propose([makeEntry(reading(100 + i, { value: 12 }))], net.keys[0]);
    fake.push(p);
    rogue.commit(p);
  }
  assert.throws(() => Chain.fromBlocks(clone(fake), net.opts), /needs 2/);
});

test('tampering anywhere is detected, including the device signature and the block signatures', () => {
  const dev = generateKeys();
  const net = network();
  const chain = new Chain(net.opts);
  const r = normalizeReading(reading(1, { deviceId: 'd' }));
  chain.append(certified(chain, net, [makeEntry(r, sign(readingHash(r), dev.privateKey)), makeEntry(reading(2))]));
  chain.append(certified(chain, net, [makeEntry(reading(3)), makeEntry(reading(4))]));
  chain.append(certified(chain, net, [makeEntry(reading(5))]));
  const cases = {
    'changed reading value': (bl) => { bl[2].entries[0].reading.value = 1; },
    'changed reading hash too': (bl) => { bl[2].entries[0].reading.value = 1; bl[2].entries[0].hash = readingHash(bl[2].entries[0].reading); },
    'changed device signature': (bl) => { bl[1].entries[0].deviceSignature = sign('x', dev.privateKey); },
    'removed device signature': (bl) => { delete bl[1].entries[0].deviceSignature; },
    'removed a reading': (bl) => { bl[2].entries.pop(); bl[2].header.count = 1; },
    'swapped block order': (bl) => { [bl[1], bl[2]] = [bl[2], bl[1]]; },
    'rewritten header': (bl) => { bl[1].header.timestamp = new Date().toISOString(); },
    'signatures of another block': (bl) => { bl[3].signatures = bl[2].signatures; },
    'other network genesis': (bl) => { bl[0] = genesis('another'); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const blocks = clone(chain.blocks);
    mutate(blocks);
    assert.throws(() => Chain.fromBlocks(blocks, net.opts), Error, name);
  }
});

test('blocks from the network are rebuilt from known fields with strict types', () => {
  const { chain } = buildChain(1, 1);
  const b = clone(chain.blocks[1]);
  const extra = { ...b, junk: 'x'.repeat(1000), entries: b.entries.map((e) => ({ ...e, junk: 1 })) };
  const s = sanitizeBlock(extra);
  assert.equal('junk' in s, false);
  assert.equal('junk' in s.entries[0], false);
  assert.throws(() => sanitizeBlock({ ...b, signatures: [{ signer: b.signatures[0].signer, signature: Buffer.from(b.signatures[0].signature) }] }), /signature entry/);
  assert.throws(() => sanitizeBlock({ ...b, header: { ...b.header, index: '1' } }), /index/);
  assert.throws(() => sanitizeBlock({ ...b, entries: [{ ...b.entries[0], deviceSignature: { a: 1 } }] }), /deviceSignature/);
});

test('a proof is rejected when it is about another reading, another chain, or altered', () => {
  const { chain, net } = buildChain(2, 5);
  const auth = net.opts.authorities;
  const asked = chain.blocks[2].entries[3].hash;
  const p = chain.proof(asked);
  assert.equal(verifyProof(clone(p), auth, { hash: asked, chainId: 'test' }).ok, true);
  assert.match(verifyProof(clone(chain.proof(chain.blocks[1].entries[0].hash)), auth, { hash: asked }).reason, /not the one asked for/);
  assert.match(verifyProof(clone(p), auth, { hash: asked, chainId: 'other' }).reason, /chain "test"/);
  const bad1 = clone(p); bad1.entry.reading.value = 0;
  const bad2 = clone(p); bad2.merkleProof[0].hash = sha256('x');
  const bad3 = clone(p); bad3.block.signatures = bad3.block.signatures.slice(0, 1);
  for (const bad of [bad1, bad2, bad3]) assert.equal(verifyProof(bad, auth, { hash: asked }).ok, false);
  assert.equal(verifyProof(clone(p), [generateKeys().publicKey], { hash: asked }).ok, false, 'signers we do not trust');
});

test('the store survives a torn last line, keeps blocks after a clock reset, and refuses an edited file', () => {
  const { chain, net } = buildChain(3, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-'));
  const store = new Store(path.join(dir, 'chain.jsonl'));
  chain.blocks.slice(1).forEach((bl) => store.append(bl));
  fs.appendFileSync(store.file, '{"header":{"ver'); // power loss in the middle of a write
  const load = () => Chain.fromBlocks([genesis('test'), ...store.load()], net.opts, { checkClock: false });
  assert.equal(load().tip.hash, chain.tip.hash);
  assert.equal(load().tip.hash, chain.tip.hash, 'the torn line was removed');
  fs.writeFileSync(store.file, fs.readFileSync(store.file, 'utf8').replace('"value":40.1', '"value":40.2'));
  assert.throws(load, /altered/);
});

test('token comparison never throws, whatever the client sends', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  for (const bad of ['é' + 'x'.repeat(31), 'x'.repeat(31), undefined, null, 42, { a: 1 }, 'ü'.repeat(5000)]) assert.equal(sameToken(bad, 'x'.repeat(32)), false);
  assert.equal(sameToken('', ''), false, 'an empty configured token never matches');
});
