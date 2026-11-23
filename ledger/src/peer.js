'use strict';
// A ledger peer: HTTP API for the gateway and auditors, Socket.IO between peers, sealing loop.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { Chain, genesis, makeEntry, MAX_ENTRIES } = require('./chain');
const { Store } = require('./store');
const { loadOrCreateKey } = require('./crypto');

const MAX_PENDING = 50000;

function createPeer(opts) {
  const cfg = {
    port: 5101, host: '0.0.0.0', name: 'peer', chainId: 'contrust-demo', dataDir: './data/peer',
    peers: [], authorities: [], gatewayToken: '', networkToken: '', sealIntervalMs: 3000, leaderTimeoutMs: 9000, log: console.log,
    ...opts,
  };
  const keys = cfg.keys || loadOrCreateKey(path.join(cfg.dataDir, 'peer.key'));
  const authorities = cfg.authorities.length ? cfg.authorities : [keys.publicKey];
  const store = new Store(path.join(cfg.dataDir, 'chain.jsonl'));
  const chainOpts = { chainId: cfg.chainId, authorities };

  // Opening the chain validates every block: a tampered file stops the peer instead of being served.
  let chain = Chain.fromBlocks([genesis(cfg.chainId), ...store.load()], chainOpts);
  const pending = new Map();
  let lastBlockAt = Date.now();
  const log = (...a) => cfg.log(`[${cfg.name}]`, ...a);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 20e6 });
  const outgoing = new Map(); // url -> client socket

  const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const gatewayOk = (req) => !cfg.gatewayToken || sameToken(req.get('x-contrust-token') || '', cfg.gatewayToken);

  function status() {
    return {
      name: cfg.name, chainId: cfg.chainId, publicKey: keys.publicKey, authorities, isAuthority: authorities.includes(keys.publicKey),
      height: chain.height, tip: chain.tip.hash, pending: pending.size, peers: [...outgoing.values()].filter((s) => s.connected).length + io.engine.clientsCount,
    };
  }

  function addEntry(entry, gossip) {
    if (chain.has(entry.hash) || pending.has(entry.hash)) return false;
    if (pending.size >= MAX_PENDING) throw new Error('pending pool is full');
    pending.set(entry.hash, entry);
    if (gossip) broadcast('entry', entry);
    return true;
  }

  function broadcast(event, payload) {
    io.emit(event, payload);
    for (const s of outgoing.values()) if (s.connected) s.emit(event, payload);
  }

  function adopt(blocks, from) {
    let candidate;
    try { candidate = Chain.fromBlocks(blocks, chainOpts); } catch (e) { log(`rejected chain from ${from}: ${e.message}`); return false; }
    if (!chain.isBetter(candidate)) return false;
    const orphans = chain.blocks.slice(1).flatMap((b) => b.entries).filter((e) => !candidate.has(e.hash));
    chain = candidate;
    store.replace(chain.blocks.slice(1));
    for (const e of [...pending.values()]) if (chain.has(e.hash)) pending.delete(e.hash);
    for (const e of orphans) pending.set(e.hash, e); // readings of a losing fork go back to the pool, never lost
    lastBlockAt = Date.now();
    log(`switched to the chain from ${from}: height ${chain.height}`);
    broadcast('block', chain.tip);
    return true;
  }

  function receiveBlock(block, socket) {
    if (!block || !block.header) return;
    if (block.header.index === chain.height + 1 && block.header.previousHash === chain.tip.hash) {
      try {
        chain.append(block);
        store.append(block);
        for (const e of block.entries) pending.delete(e.hash);
        lastBlockAt = Date.now();
        log(`block ${block.header.index} from the network (${block.entries.length} readings)`);
        broadcast('block', block);
      } catch (e) {
        log(`rejected block ${block.header.index}: ${e.message}`);
      }
      return;
    }
    if (chain.blocks[block.header.index] && chain.blocks[block.header.index].hash === block.hash) return; // already have it
    // does not fit on our tip: ask the sender for its chain and keep whichever is better
    if (socket && block.header.index >= chain.height) socket.emit('get-chain', (blocks) => adopt(blocks, 'a peer'));
  }

  function attach(socket) {
    socket.on('entry', (entry) => {
      try { addEntry(makeEntry(entry && entry.reading, entry && entry.deviceSignature), true); } catch (e) { /* invalid gossip is ignored */ }
    });
    socket.on('block', (block) => receiveBlock(block, socket));
    socket.on('get-chain', (reply) => { if (typeof reply === 'function') reply(chain.blocks); });
  }

  io.use((socket, next) => (!cfg.networkToken || sameToken((socket.handshake.auth || {}).token || '', cfg.networkToken) ? next() : next(new Error('bad network token'))));
  io.on('connection', attach);

  function connectPeers() {
    for (const url of cfg.peers) {
      if (outgoing.has(url)) continue;
      const s = ioClient(url, { auth: { token: cfg.networkToken }, reconnectionDelayMax: 5000 });
      attach(s);
      s.on('connect', () => s.emit('get-chain', (blocks) => adopt(blocks, url)));
      outgoing.set(url, s);
    }
  }

  // Seal when this peer is the leader for the next block, or when the leader has been silent too long.
  function tick() {
    if (!pending.size || !authorities.includes(keys.publicKey)) return;
    const next = chain.height + 1;
    const leader = chain.leaderFor(next);
    if (leader !== keys.publicKey && Date.now() - lastBlockAt < cfg.leaderTimeoutMs) return;
    const batch = [...pending.values()].sort((a, b) => a.reading.takenAt.localeCompare(b.reading.takenAt) || a.hash.localeCompare(b.hash)).slice(0, MAX_ENTRIES);
    const block = chain.seal(batch, keys);
    store.append(block);
    for (const e of batch) pending.delete(e.hash);
    lastBlockAt = Date.now();
    log(`sealed block ${block.header.index} (${batch.length} readings)`);
    broadcast('block', block);
  }

  // ---------- HTTP ----------
  app.get('/status', (req, res) => res.json(status()));

  app.post('/entries', (req, res) => {
    if (!gatewayOk(req)) return res.status(401).json({ error: 'bad token' });
    let entry;
    try { entry = makeEntry(req.body && req.body.reading, req.body && req.body.deviceSignature); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const added = addEntry(entry, true);
      res.status(added ? 202 : 200).json({ hash: entry.hash, state: chain.has(entry.hash) ? 'anchored' : 'pending' });
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  app.get('/entries/:hash', (req, res) => {
    const p = chain.proof(req.params.hash);
    if (p) return res.json({ state: 'anchored', block: p.block.header.index, confirmations: p.confirmations });
    res.status(pending.has(req.params.hash) ? 200 : 404).json({ state: pending.has(req.params.hash) ? 'pending' : 'unknown' });
  });

  app.get('/chain', (req, res) => {
    const from = Math.max(0, parseInt(req.query.from, 10) || 0);
    res.json({ chainId: cfg.chainId, height: chain.height, blocks: chain.blocks.slice(from, from + 500) });
  });

  app.get('/blocks/:index', (req, res) => {
    const b = chain.blocks[parseInt(req.params.index, 10)];
    return b ? res.json(b) : res.status(404).json({ error: 'no such block' });
  });

  app.get('/proof/:hash', (req, res) => {
    const p = chain.proof(req.params.hash);
    return p ? res.json({ ...p, authorities }) : res.status(404).json({ error: 'reading not anchored (yet)' });
  });

  let timer = null;
  return {
    app, io, status, get chain() { return chain; }, keys,
    listen() {
      return new Promise((resolve, reject) => server.once('error', (e) => reject(new Error(`port ${cfg.port}: ${e.code === 'EADDRINUSE' ? 'already in use (set PORT to another one)' : e.message}`))).listen(cfg.port, cfg.host, () => {
        cfg.port = server.address().port;
        timer = setInterval(() => { try { tick(); } catch (e) { log('sealing failed:', e.message); } }, cfg.sealIntervalMs);
        connectPeers();
        log(`listening on ${cfg.port}, height ${chain.height}, ${authorities.includes(keys.publicKey) ? 'authority' : 'follower'} ${keys.publicKey.slice(0, 12)}...`);
        resolve(cfg.port);
      }));
    },
    connect(urls) { cfg.peers.push(...urls); connectPeers(); },
    tick,
    close() {
      clearInterval(timer);
      for (const s of outgoing.values()) s.close();
      io.close();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createPeer };
