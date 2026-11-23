'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPeer } = require('../ledger/src/peer');
const { createGateway } = require('../gateway/src/server');
const { generateKeys, sign } = require('../ledger/src/crypto');
const { normalizeReading, readingHash } = require('../ledger/src/reading');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(cond, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await cond()) return true; await espera(100); }
  return false;
}
const quiet = () => {};

test('three peers, a gateway and signed devices: everything anchored, verifiable and identical on every peer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-net-'));
  const keys = [generateKeys(), generateKeys(), generateKeys()];
  const authorities = keys.map((k) => k.publicKey);
  const common = { chainId: 'net-test', authorities, gatewayToken: 'gw', networkToken: 'net', sealIntervalMs: 200, leaderTimeoutMs: 800, port: 0, host: '127.0.0.1', log: quiet };
  const peers = keys.map((k, i) => createPeer({ ...common, name: 'p' + i, keys: k, dataDir: path.join(dir, 'p' + i) }));
  const ports = [];
  for (const p of peers) ports.push(await p.listen());
  const urls = ports.map((p) => `http://127.0.0.1:${p}`);
  peers.forEach((p, i) => p.connect(urls.filter((_, j) => j !== i)));

  const dev = generateKeys();
  const gw = createGateway({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'gw'), ledgerUrls: [urls[0], urls[1]], gatewayToken: 'gw', networkToken: 'net', devices: { 'logger-1': dev.publicKey }, log: quiet });
  const gport = await gw.listen();
  const G = `http://127.0.0.1:${gport}`;
  t.after(async () => { await gw.close(); for (const p of peers) await p.close(); });

  const post = (body) => fetch(G + '/api/readings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hashes = [];
  for (let i = 0; i < 12; i++) {
    const r = normalizeReading({ instrumentId: i % 2 ? 'PZ-01' : 'INC-02', takenAt: new Date(Date.UTC(2020, 7, 2, 19, i)).toISOString(), value: 40 + i, unit: 'kPa', deviceId: 'logger-1' });
    const res = await post({ reading: r, signature: sign(readingHash(r), dev.privateKey) });
    assert.equal(res.status, 202);
    hashes.push((await res.json()).hash);
  }

  // bad input and bad signatures never reach the ledger
  assert.equal((await post({ instrumentId: 'X', takenAt: 'no', value: 1 })).status, 400);
  const forged = normalizeReading({ instrumentId: 'PZ-01', takenAt: '2020-08-02T20:00:00Z', value: 1, deviceId: 'logger-1' });
  assert.equal((await post({ reading: forged, signature: sign(readingHash(forged), generateKeys().privateKey) })).status, 400);
  assert.equal((await post({ reading: forged })).status, 400, 'a registered device must sign');
  const dup = await post({ reading: normalizeReading({ instrumentId: 'INC-02', takenAt: new Date(Date.UTC(2020, 7, 2, 19, 0)).toISOString(), value: 40, unit: 'kPa', deviceId: 'logger-1' }), signature: 'x' });
  assert.equal(dup.status, 400, 'same reading with a wrong signature is refused before the duplicate check');

  const anchoredAll = await ate(async () => {
    const list = await (await fetch(G + '/api/readings')).json();
    return list.length === 12 && list.every((r) => r.state === 'anchored');
  });
  assert.ok(anchoredAll, 'all readings anchored in the gateway');
  assert.ok(await ate(() => new Set(peers.map((p) => p.chain.tip.hash)).size === 1 && peers[0].chain.height >= 1), 'peers converge on the same tip');

  for (const h of hashes) {
    const r = await (await fetch(`${G}/api/readings/${h}/proof`)).json();
    assert.equal(r.verification.ok, true, r.verification.reason);
  }
  const inst = await (await fetch(G + '/api/instruments')).json();
  assert.deepEqual(inst.map((i) => [i.instrumentId, i.count, i.anchored]).sort(), [['INC-02', 6, 6], ['PZ-01', 6, 6]]);

  // a peer restarted from its file has the same chain
  const tip = peers[2].chain.tip.hash;
  await peers[2].close();
  const reopened = createPeer({ ...common, name: 'p2b', keys: keys[2], dataDir: path.join(dir, 'p2') });
  assert.equal(reopened.chain.tip.hash, tip);
});

test('gateway keeps readings queued while the ledger is down and delivers them later', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-q-'));
  const k = generateKeys();
  const gw = createGateway({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'gw'), ledgerUrls: ['http://127.0.0.1:1'], log: quiet });
  const G = `http://127.0.0.1:${await gw.listen()}`;
  const res = await fetch(G + '/api/readings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instrumentId: 'PZ-09', takenAt: '2021-01-01T00:00:00Z', value: 3.5 }) });
  const { hash, state } = await res.json();
  assert.equal(state, 'queued');
  await gw.close();

  // the ledger comes up and a new gateway process (same data dir) delivers the queued reading
  const peer = createPeer({ chainId: 'q', keys: k, authorities: [k.publicKey], dataDir: path.join(dir, 'peer'), port: 0, host: '127.0.0.1', sealIntervalMs: 150, log: quiet });
  const port = await peer.listen();
  const gw2 = createGateway({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'gw'), ledgerUrls: [`http://127.0.0.1:${port}`], log: quiet });
  const G2 = `http://127.0.0.1:${await gw2.listen()}`;
  t.after(async () => { await gw2.close(); await peer.close(); });
  assert.ok(await ate(async () => (await (await fetch(G2 + '/api/readings')).json()).every((r) => r.state === 'anchored'), 20000), 'queued reading anchored after restart');
  assert.ok(peer.chain.has(hash));
});
