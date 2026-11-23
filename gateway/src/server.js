'use strict';
// Gateway: receives readings from devices, checks them, hands them to the ledger and shows the live dashboard.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { makeEntry, verifyProof } = require('../../ledger/src/chain');
const { checkDeviceSignature } = require('../../ledger/src/reading');

const RETRY_MS = 5000;

function createGateway(opts) {
  const cfg = {
    port: 6001, host: '0.0.0.0', dataDir: './data/gateway', ledgerUrls: ['http://localhost:5101'],
    gatewayToken: '', networkToken: '', deviceToken: '', devices: {}, requireSignatures: false, log: console.log,
    ...opts,
  };
  const log = (...a) => cfg.log('[gateway]', ...a);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, 'readings.jsonl');

  // readings received, by hash, in arrival order. The ledger is the source of truth for what is anchored.
  const readings = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(line); readings.set(r.hash, r); } catch (e) { /* a torn last line is skipped */ }
    }
  }
  const anchors = new Map(); // reading hash -> { block, blockHash, at }
  const queued = new Set([...readings.keys()]); // still to be confirmed by the ledger

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const server = http.createServer(app);
  const io = new Server(server);
  let ledgerStatus = null;
  let ledgerSocket = null;

  const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  async function ledgerFetch(p, init) {
    let last;
    for (const base of cfg.ledgerUrls) {
      try {
        const r = await fetch(base.replace(/\/+$/, '') + p, { ...init, headers: { 'content-type': 'application/json', 'x-contrust-token': cfg.gatewayToken, ...((init && init.headers) || {}) }, signal: AbortSignal.timeout(5000) });
        return r;
      } catch (e) { last = e; }
    }
    throw last || new Error('no ledger peer configured');
  }

  function stateOf(hash) {
    const a = anchors.get(hash);
    return a ? { state: 'anchored', block: a.block, blockHash: a.blockHash } : { state: queued.has(hash) ? 'queued' : 'pending' };
  }

  function view(r) { return { ...r, ...stateOf(r.hash) }; }

  function learnBlock(block) {
    if (!block || !block.header || !Array.isArray(block.entries)) return;
    for (const e of block.entries) {
      if (anchors.has(e.hash)) continue;
      anchors.set(e.hash, { block: block.header.index, blockHash: block.hash, at: block.header.timestamp });
      queued.delete(e.hash);
      if (readings.has(e.hash)) io.emit('anchored', { hash: e.hash, block: block.header.index, blockHash: block.hash });
    }
  }

  async function syncChain() {
    for (let from = 0, voltas = 0; voltas < 1000; voltas++) { // ceiling: 1000 pages of 500 blocks
      const r = await ledgerFetch(`/chain?from=${from}`);
      const j = await r.json();
      j.blocks.forEach(learnBlock);
      from += j.blocks.length;
      if (!j.blocks.length || from > j.height) break;
    }
  }

  // Sends a reading to the ledger. On failure it stays queued and the retry loop tries again.
  async function forward(rec) {
    try {
      const r = await ledgerFetch('/entries', { method: 'POST', body: JSON.stringify({ reading: rec.reading, deviceSignature: rec.deviceSignature }) });
      if (r.ok) {
        queued.delete(rec.hash);
        if (!anchors.has(rec.hash)) io.emit('pending', { hash: rec.hash });
        return true;
      }
      log(`ledger refused ${rec.hash.slice(0, 12)}: HTTP ${r.status}`);
    } catch (e) {
      log(`ledger unreachable, ${rec.hash.slice(0, 12)} stays queued`);
    }
    return false;
  }

  async function retryQueued() {
    for (const hash of [...queued].slice(0, 200)) {
      const rec = readings.get(hash);
      if (!rec || anchors.has(hash)) { queued.delete(hash); continue; }
      if (!(await forward(rec))) break;
    }
  }

  // ---------- devices ----------
  app.post('/api/readings', async (req, res) => {
    if (cfg.deviceToken && !sameToken(req.get('x-contrust-device-token') || '', cfg.deviceToken)) return res.status(401).json({ error: 'bad device token' });
    const body = req.body || {};
    const input = body.reading || body;
    let entry;
    try { entry = makeEntry(input, body.signature); } catch (e) { return res.status(400).json({ error: e.message }); }
    const check = checkDeviceSignature(entry.reading, body.signature, cfg.devices);
    if (!check.ok || (cfg.requireSignatures && check.reason !== 'signed')) return res.status(400).json({ error: check.ok ? 'readings must be signed by a registered device' : check.reason });
    if (readings.has(entry.hash)) return res.json({ hash: entry.hash, duplicate: true, ...stateOf(entry.hash) });
    const rec = { hash: entry.hash, reading: entry.reading, deviceSignature: entry.deviceSignature, signed: check.reason === 'signed', receivedAt: new Date().toISOString() };
    readings.set(rec.hash, rec);
    queued.add(rec.hash);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
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
      res.json({ proof, verification: verifyProof(proof, proof.authorities) });
    } catch (e) {
      res.status(502).json({ error: 'ledger unreachable' });
    }
  });

  app.get('/api/status', (req, res) => res.json({
    ledger: ledgerStatus, readings: readings.size, anchored: [...readings.keys()].filter((h) => anchors.has(h)).length, queued: queued.size,
    devices: Object.keys(cfg.devices).length, requireSignatures: cfg.requireSignatures,
  }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  let timers = [];
  return {
    app, readings, anchors,
    async listen() {
      await new Promise((resolve, reject) => server.once('error', (e) => reject(new Error(`port ${cfg.port}: ${e.code === 'EADDRINUSE' ? 'already in use (set PORT to another one)' : e.message}`))).listen(cfg.port, cfg.host, resolve));
      cfg.port = server.address().port;
      ledgerSocket = ioClient(cfg.ledgerUrls[0], { auth: { token: cfg.networkToken }, reconnectionDelayMax: 5000 });
      ledgerSocket.on('block', learnBlock);
      ledgerSocket.on('connect', () => syncChain().catch(() => {}));
      const poll = async () => {
        try { ledgerStatus = await (await ledgerFetch('/status')).json(); io.emit('status', ledgerStatus); } catch (e) { ledgerStatus = null; }
        await retryQueued().catch(() => {});
      };
      timers = [setInterval(poll, RETRY_MS)];
      poll();
      log(`listening on ${cfg.port}, ledger ${cfg.ledgerUrls.join(', ')}`);
      return cfg.port;
    },
    sync: syncChain,
    close() {
      timers.forEach(clearInterval);
      if (ledgerSocket) ledgerSocket.close();
      io.close();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createGateway };
