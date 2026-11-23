'use strict';
// Gateway: receives readings from devices, checks them, hands them to the ledger and shows the live dashboard.
// It trusts the ledger only as far as it can check: blocks must carry a majority of signatures of the
// authorities configured HERE (AUTHORITIES), not of whatever list a peer reports.
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { makeEntry, verifyProof, leafOf, quorumOf } = require('../../ledger/src/chain');
const { checkDeviceSignature } = require('../../ledger/src/reading');
const { hashOf, merkleRoot, verifySignature } = require('../../ledger/src/crypto');
const { sameToken } = require('../../ledger/src/peer');

const TICK_MS = 5000;
const RESEND_MS = 30000;   // a reading not anchored after this is sent again (a peer may have restarted)
const MAX_PAGES = 10000;   // ceiling of pages read in one sync

function createGateway(opts) {
  const cfg = {
    port: 6001, host: '0.0.0.0', dataDir: './data/gateway', ledgerUrls: ['http://localhost:5101'],
    chainId: '', authorities: [], gatewayToken: '', networkToken: '', deviceToken: '', devices: {}, requireSignatures: false,
    resendMs: RESEND_MS, log: console.log,
    ...opts,
  };
  const log = (...a) => cfg.log('[gateway]', ...a);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, 'readings.jsonl');

  const readings = new Map(); // hash -> record, in arrival order
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(line); readings.set(r.hash, r); } catch (e) { /* a torn last line is skipped */ }
    }
  }
  const anchors = new Map(); // reading hash -> { block, blockHash, at }
  const lastSent = new Map(); // reading hash -> time of the last delivery to the ledger (0 = never confirmed)
  for (const h of readings.keys()) lastSent.set(h, 0);
  let known = 0; // blocks learned, in order
  let trusted = { chainId: cfg.chainId, authorities: [...cfg.authorities].sort(), selfReported: !cfg.authorities.length };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const server = http.createServer(app);
  const io = new Server(server);
  let ledgerStatus = null;
  const ledgerSockets = [];

  // Next peer on network errors and on answers that say "not here": 401/403, 5xx.
  async function ledgerFetch(p, init) {
    let last;
    for (const base of cfg.ledgerUrls) {
      try {
        const r = await fetch(base.replace(/\/+$/, '') + p, { ...init, headers: { 'content-type': 'application/json', 'x-contrust-token': cfg.gatewayToken }, signal: AbortSignal.timeout(5000) });
        if (r.status === 401 || r.status === 403 || r.status >= 500) { last = new Error(`${base}: HTTP ${r.status}`); continue; }
        return r;
      } catch (e) { last = e; }
    }
    throw last || new Error('no ledger peer configured');
  }

  function stateOf(hash) {
    const a = anchors.get(hash);
    if (a) return { state: 'anchored', block: a.block, blockHash: a.blockHash };
    return { state: lastSent.get(hash) ? 'pending' : 'queued' };
  }
  const view = (r) => ({ ...r, ...stateOf(r.hash) });

  // A block counts here only if it hashes right, its readings match its Merkle root and a majority of the
  // trusted authorities signed it.
  function blockOk(b) {
    try {
      if (!b || !b.header || hashOf(b.header) !== b.hash) return false;
      if (trusted.chainId && b.header.chainId !== trusted.chainId) return false;
      if (b.header.merkleRoot !== merkleRoot(b.entries.map(leafOf))) return false;
      if (b.entries.some((e) => hashOf(e.reading) !== e.hash)) return false;
      const signers = new Set(b.signatures.filter((s) => trusted.authorities.includes(s.signer) && verifySignature(b.hash, s.signature, s.signer)).map((s) => s.signer));
      return signers.size >= quorumOf(trusted.authorities.length);
    } catch (e) { return false; }
  }

  function learn(b) {
    if (!b || !b.header || b.header.index !== known + 1) return false;
    if (!blockOk(b)) { log(`ignored block ${b.header.index}: not certified by the configured authorities`); return false; }
    known = b.header.index;
    for (const e of b.entries) {
      if (anchors.has(e.hash)) continue;
      anchors.set(e.hash, { block: b.header.index, blockHash: b.hash, at: b.header.timestamp });
      if (readings.has(e.hash)) io.emit('anchored', { hash: e.hash, block: b.header.index, blockHash: b.hash });
    }
    return true;
  }

  async function sync() {
    for (let i = 0; i < MAX_PAGES; i++) {
      const j = await (await ledgerFetch(`/chain?from=${known + 1}`)).json();
      let n = 0;
      for (const b of j.blocks) { if (!learn(b)) break; n++; }
      if (!j.blocks.length || n < j.blocks.length || known >= j.height) break;
    }
  }

  async function forward(rec) {
    try {
      const r = await ledgerFetch('/entries', { method: 'POST', body: JSON.stringify({ reading: rec.reading, deviceSignature: rec.deviceSignature }) });
      if (r.ok) {
        const first = !lastSent.get(rec.hash);
        lastSent.set(rec.hash, Date.now());
        if (first && !anchors.has(rec.hash)) io.emit('pending', { hash: rec.hash });
        return true;
      }
      log(`ledger refused ${rec.hash.slice(0, 12)}: HTTP ${r.status}`);
    } catch (e) {
      log(`ledger unreachable, ${rec.hash.slice(0, 12)} stays queued`);
    }
    return false;
  }

  // Everything not anchored yet: never sent, or sent long ago (the peer may have lost it in a restart).
  async function resend() {
    const now = Date.now();
    let n = 0;
    for (const [hash, at] of lastSent) {
      if (anchors.has(hash)) { lastSent.delete(hash); continue; }
      if (at && now - at < cfg.resendMs) continue;
      if (++n > 200) break;
      if (!(await forward(readings.get(hash)))) break;
    }
  }

  // ---------- devices ----------
  app.post('/api/readings', async (req, res) => {
    if (cfg.deviceToken && !sameToken(req.get('x-contrust-device-token'), cfg.deviceToken)) return res.status(401).json({ error: 'bad device token' });
    const body = req.body || {};
    const input = body.reading || body;
    let entry;
    try { entry = makeEntry(input, body.signature); } catch (e) { return res.status(400).json({ error: e.message }); }
    const check = checkDeviceSignature(entry.reading, body.signature, cfg.devices);
    if (!check.ok || (cfg.requireSignatures && check.reason !== 'signed')) return res.status(400).json({ error: check.ok ? 'readings must be signed by a registered device' : check.reason });
    if (readings.has(entry.hash)) return res.json({ hash: entry.hash, duplicate: true, ...stateOf(entry.hash) });
    const rec = { hash: entry.hash, reading: entry.reading, deviceSignature: entry.deviceSignature, signed: check.reason === 'signed', receivedAt: new Date().toISOString() };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    readings.set(rec.hash, rec);
    lastSent.set(rec.hash, 0);
    await forward(rec);
    io.emit('reading', view(rec)); // after the ledger answered: the dashboard shows the real state
    res.status(202).json({ hash: rec.hash, ...stateOf(rec.hash) });
  });

  // ---------- dashboard and auditors ----------
  app.get('/api/readings', (req, res) => {
    const inst = req.query.instrument ? String(req.query.instrument) : '';
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const all = [...readings.values()].filter((r) => !inst || r.reading.instrumentId === inst);
    res.json(all.slice(-limit).reverse().map(view));
  });

  app.get('/api/instruments', (req, res) => {
    const by = new Map();
    for (const r of readings.values()) {
      const i = by.get(r.reading.instrumentId) || { instrumentId: r.reading.instrumentId, unit: r.reading.unit || '', count: 0, anchored: 0, last: null };
      i.count++;
      if (anchors.has(r.hash)) i.anchored++;
      if (!i.last || r.reading.takenAt > i.last.takenAt) i.last = { takenAt: r.reading.takenAt, value: r.reading.value };
      by.set(i.instrumentId, i);
    }
    res.json([...by.values()]);
  });

  app.get('/api/readings/:hash/proof', async (req, res) => {
    try {
      const r = await ledgerFetch('/proof/' + encodeURIComponent(req.params.hash));
      const proof = await r.json();
      if (!r.ok) return res.status(r.status).json(proof);
      const verification = verifyProof(proof, trusted.authorities, { hash: req.params.hash, chainId: trusted.chainId });
      if (trusted.selfReported) verification.reason += ' (authorities as reported by the ledger: set AUTHORITIES on the gateway)';
      res.json({ proof, verification });
    } catch (e) {
      res.status(502).json({ error: 'ledger unreachable' });
    }
  });

  app.get('/api/status', (req, res) => res.json({
    ledger: ledgerStatus, blocks: known, readings: readings.size, anchored: [...readings.keys()].filter((h) => anchors.has(h)).length,
    queued: [...lastSent.values()].filter((t) => !t).length, devices: Object.keys(cfg.devices).length, requireSignatures: cfg.requireSignatures,
    authoritiesConfigured: !trusted.selfReported,
  }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  let timer = null;
  return {
    app, readings, anchors,
    async listen() {
      await new Promise((resolve, reject) => server.once('error', (e) => reject(new Error(`port ${cfg.port}: ${e.code === 'EADDRINUSE' ? 'already in use (set PORT to another one)' : e.message}`))).listen(cfg.port, cfg.host, resolve));
      cfg.port = server.address().port;
      for (const url of cfg.ledgerUrls) {
        const s = ioClient(url, { auth: { token: cfg.networkToken }, reconnectionDelayMax: 5000 });
        s.on('block', (b) => { if (!learn(b) && b && b.header && b.header.index > known + 1) sync().catch(() => {}); });
        s.on('connect', () => sync().catch(() => {}));
        ledgerSockets.push(s);
      }
      const poll = async () => {
        try {
          ledgerStatus = await (await ledgerFetch('/status')).json();
          if (trusted.selfReported) trusted = { chainId: ledgerStatus.chainId, authorities: [...ledgerStatus.authorities].sort(), selfReported: true };
          io.emit('status', ledgerStatus);
          await sync();
        } catch (e) { ledgerStatus = null; }
        await resend().catch(() => {});
      };
      timer = setInterval(poll, TICK_MS);
      await poll();
      log(`listening on ${cfg.port}, ledger ${cfg.ledgerUrls.join(', ')}${trusted.selfReported ? ' (no AUTHORITIES set: trusting the list the ledger reports)' : ''}`);
      return cfg.port;
    },
    sync,
    close() {
      clearInterval(timer);
      for (const s of ledgerSockets) s.close();
      io.close();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createGateway };
