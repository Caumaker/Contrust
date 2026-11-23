'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { createPeer } = require('../ledger/src/peer');
const { createGateway } = require('../gateway/src/server');
const { Chain, makeEntry } = require('../ledger/src/chain');
const { generateKeys, sign } = require('../ledger/src/crypto');
const { normalizeReading, readingHash } = require('../ledger/src/reading');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(cond, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await cond()) return true; await espera(100); }
  return false;
}
const quiet = () => {};
const TOK = { gatewayToken: 'gw-secret-token', networkToken: 'net-secret-token' };
const rd = (i, extra) => normalizeReading({ instrumentId: i % 2 ? 'PZ-01' : 'INC-02', takenAt: new Date(Date.UTC(2020, 7, 2, 19, i)).toISOString(), value: 40 + i, unit: 'kPa', ...extra });

async function rede(dir, n = 3, extra = {}) {
  const keys = Array.from({ length: n }, () => generateKeys());
  const authorities = keys.map((k) => k.publicKey);
  const common = { chainId: 'net-test', authorities, ...TOK, sealIntervalMs: 150, leaderTimeoutMs: 700, port: 0, host: '127.0.0.1', log: quiet, ...extra };
  const peers = keys.map((k, i) => createPeer({ ...common, name: 'p' + i, keys: k, dataDir: path.join(dir, 'p' + i) }));
  const urls = [];
  for (const p of peers) urls.push(`http://127.0.0.1:${await p.listen()}`);
  peers.forEach((p, i) => p.connect(urls.filter((_, j) => j !== i)));
  return { keys, authorities, common, peers, urls };
}

test('three authorities, a gateway and signed devices: everything certified by a majority, verifiable and identical', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-net-'));
  const net = await rede(dir);
  const dev = generateKeys();
  const gw = createGateway({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'gw'), ledgerUrls: [net.urls[0], net.urls[1]], chainId: 'net-test', authorities: net.authorities, ...TOK, devices: { 'logger-1': dev.publicKey }, log: quiet });
  const G = `http://127.0.0.1:${await gw.listen()}`;
  t.after(async () => { await gw.close(); for (const p of net.peers) await p.close(); });

  const post = (body, headers = {}) => fetch(G + '/api/readings', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const hashes = [];
  for (let i = 0; i < 12; i++) {
    const r = rd(i, { deviceId: 'logger-1' });
    const res = await post({ reading: r, signature: sign(readingHash(r), dev.privateKey) });
    assert.equal(res.status, 202);
    hashes.push((await res.json()).hash);
  }
  assert.equal((await post({ instrumentId: 'X', takenAt: 'no', value: 1 })).status, 400);
  const forged = rd(40, { deviceId: 'logger-1' });
  assert.equal((await post({ reading: forged, signature: sign(readingHash(forged), generateKeys().privateKey) })).status, 400);
  assert.equal((await post({ reading: forged })).status, 400, 'a registered device must sign');

  assert.ok(await ate(async () => (await (await fetch(G + '/api/readings')).json()).every((r) => r.state === 'anchored')), 'all anchored');
  assert.ok(await ate(() => new Set(net.peers.map((p) => p.chain.tip.hash)).size === 1), 'peers converge');
  for (const b of net.peers[0].chain.blocks.slice(1)) assert.ok(b.signatures.length >= 2, 'every block carries a majority');
  for (const h of hashes) {
    const r = await (await fetch(`${G}/api/readings/${h}/proof`)).json();
    assert.equal(r.verification.ok, true, r.verification.reason);
  }

  // a peer reopened from its files has the same chain
  const tip = net.peers[2].chain.tip.hash;
  await net.peers[2].close();
  assert.equal(createPeer({ ...net.common, name: 'p2b', keys: net.keys[2], dataDir: path.join(dir, 'p2') }).chain.tip.hash, tip);
});

test('a network without a majority online certifies nothing, and resumes when one comes back', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-maj-'));
  const net = await rede(dir);
  t.after(async () => { for (const p of net.peers) await p.close().catch(() => {}); });
  await net.peers[1].close();
  await net.peers[2].close();
  await fetch(net.urls[0] + '/entries', { method: 'POST', headers: { 'content-type': 'application/json', 'x-contrust-token': TOK.gatewayToken }, body: JSON.stringify({ reading: rd(1) }) });
  await espera(1500);
  assert.equal(net.peers[0].chain.height, 0, 'one authority alone sealed nothing');
  const back = createPeer({ ...net.common, name: 'p1b', keys: net.keys[1], dataDir: path.join(dir, 'p1') });
  await back.listen();
  back.connect([net.urls[0]]);
  t.after(() => back.close());
  assert.ok(await ate(() => net.peers[0].chain.height === 1 && back.chain.height === 1), 'certified once a second authority is back');
});

test('unauthenticated clients cannot connect, inject readings or crash anything', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-sec-'));
  const net = await rede(dir, 1);
  const gw = createGateway({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'gw'), ledgerUrls: net.urls, chainId: 'net-test', authorities: net.authorities, ...TOK, deviceToken: 'device-token-123', log: quiet });
  const G = `http://127.0.0.1:${await gw.listen()}`;
  t.after(async () => { await gw.close(); for (const p of net.peers) await p.close(); });

  for (const token of [undefined, 'wrong', 'é' + 'x'.repeat(TOK.networkToken.length - 1)]) {
    const s = ioClient(net.urls[0], { auth: { token }, reconnection: false });
    const r = await new Promise((resolve) => { s.on('connect', () => resolve('connected')); s.on('connect_error', () => resolve('refused')); });
    s.emit('entry', { reading: rd(9) });
    s.close();
    assert.equal(r, 'refused');
  }
  const sendRaw = (port, header) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: port === Number(new URL(G).port) ? '/api/readings' : '/entries', headers: { 'content-type': 'application/json', [header]: Buffer.from([0xfc, 0x41]).toString('latin1') } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('error'));
    req.end(JSON.stringify(rd(3)));
  });
  assert.equal(await sendRaw(Number(new URL(G).port), 'x-contrust-device-token'), 401);
  assert.equal(await sendRaw(Number(new URL(net.urls[0]).port), 'x-contrust-token'), 401);
  assert.equal((await fetch(G + '/api/status')).status, 200, 'gateway still up');
  assert.equal((await fetch(net.urls[0] + '/status')).status, 200, 'peer still up');
  assert.equal(net.peers[0].status().pending, 0, 'nothing injected');
  assert.throws(() => createPeer({ chainId: 'x', keys: generateKeys(), dataDir: path.join(dir, 'z'), log: quiet }), /GATEWAY_TOKEN and NETWORK_TOKEN/);
});

test('a reading accepted by a peer that restarts before sealing is sent again and anchored', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-lost-'));
  const k = generateKeys();
  const cfg = { chainId: 'q', keys: k, authorities: [k.publicKey], dataDir: path.join(dir, 'peer'), host: '127.0.0.1', ...TOK, log: quiet };
  const p1 = createPeer({ ...cfg, port: 0, sealIntervalMs: 60000 });
  const port = await p1.listen();
  const gw = createGateway({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'gw'), ledgerUrls: [`http://127.0.0.1:${port}`], chainId: 'q', authorities: [k.publicKey], ...TOK, resendMs: 500, log: quiet });
  const G = `http://127.0.0.1:${await gw.listen()}`;
  const res = await (await fetch(G + '/api/readings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rd(1)) })).json();
  assert.equal(res.state, 'pending');
  await p1.close(); // its pool was only in memory
  const p2 = createPeer({ ...cfg, port, sealIntervalMs: 100 });
  await p2.listen();
  t.after(async () => { await gw.close(); await p2.close(); });
  assert.ok(await ate(async () => (await (await fetch(G + '/api/readings')).json())[0].state === 'anchored', 20000), 'sent again and anchored');
  assert.ok(p2.chain.has(res.hash));
});

test('a peer that was offline catches up page by page', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-sync-'));
  const net = await rede(dir);
  await net.peers[2].close();
  for (let i = 0; i < 6; i++) {
    await fetch(net.urls[0] + '/entries', { method: 'POST', headers: { 'content-type': 'application/json', 'x-contrust-token': TOK.gatewayToken }, body: JSON.stringify({ reading: rd(i) }) });
    await ate(() => net.peers[0].chain.height > i, 5000);
  }
  const late = createPeer({ ...net.common, name: 'late', keys: net.keys[2], dataDir: path.join(dir, 'p2') });
  await late.listen();
  late.connect(net.urls.slice(0, 2));
  t.after(async () => { await late.close(); for (const p of net.peers.slice(0, 2)) await p.close(); });
  assert.ok(await ate(() => late.chain.height === net.peers[0].chain.height && late.chain.tip.hash === net.peers[0].chain.tip.hash), 'caught up');
});

test('the gateway ignores blocks its own authorities did not certify', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrust-fake-'));
  const rogue = generateKeys();
  const honest = [generateKeys(), generateKeys(), generateKeys()].map((k) => k.publicKey);
  // a "ledger" run by one party: blocks sealed by a key the gateway does not trust
  const fakeChain = new Chain({ chainId: 'f', authorities: [rogue.publicKey] });
  const r = rd(1);
  fakeChain.commit(fakeChain.propose([makeEntry(r)], rogue));
  const app = express();
  app.use(express.json());
  app.get('/status', (q, s) => s.json({ chainId: 'f', authorities: [rogue.publicKey], height: 1, tip: fakeChain.tip.hash, pending: 0, peers: 0 }));
  app.get('/chain', (q, s) => s.json({ chainId: 'f', height: 1, blocks: fakeChain.blocks.slice(Number(q.query.from) || 0) }));
  app.post('/entries', (q, s) => s.status(202).json({ hash: readingHash(r), state: 'pending' }));
  const srv = http.createServer(app);
  new Server(srv);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const gw = createGateway({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'gw'), ledgerUrls: [`http://127.0.0.1:${srv.address().port}`], chainId: 'f', authorities: honest, ...TOK, log: quiet });
  const G = `http://127.0.0.1:${await gw.listen()}`;
  t.after(async () => { await gw.close(); srv.close(); });
  await fetch(G + '/api/readings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) });
  await gw.sync();
  await espera(300);
  const list = await (await fetch(G + '/api/readings')).json();
  assert.equal(list[0].state, 'pending', 'not marked anchored by an untrusted block');
});
