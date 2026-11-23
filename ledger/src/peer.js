'use strict';
// A ledger peer: HTTP API for the gateway and auditors, Socket.IO between peers, and the sealing protocol:
//   1. the authority whose turn it is proposes a block with the waiting readings and signs it;
//   2. every authority checks the proposal and, if it has not signed another block at that height, signs it too;
//   3. once a majority signed, the block is certified: every peer appends it and it never changes again.
// If the authority whose turn it is stays silent, any authority proposes after leaderTimeoutMs.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { Chain, genesis, makeEntry, sanitizeBlock, MAX_ENTRIES } = require('./chain');
const { Store } = require('./store');
const { Votes } = require('./votes');
const { loadOrCreateKey, sign, verifySignature } = require('./crypto');

const MAX_PENDING = 50000;
const SYNC_PAGE = 100;           // blocks per sync answer
const SYNC_ROUNDS = 10000;       // ceiling of pages fetched in one catch-up
const RATE = { windowMs: 10000, max: 40 }; // sync requests per socket

// Constant time and never throws, whatever the input (accents, other lengths, non-strings).
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

function createPeer(opts) {
  const cfg = {
    port: 5101, host: '0.0.0.0', name: 'peer', chainId: 'contrust-demo', dataDir: './data/peer',
    peers: [], authorities: [], gatewayToken: '', networkToken: '', insecure: false,
    sealIntervalMs: 3000, leaderTimeoutMs: 9000, log: console.log,
    ...opts,
  };
  if (!cfg.insecure && (!cfg.gatewayToken || !cfg.networkToken)) throw new Error('set GATEWAY_TOKEN and NETWORK_TOKEN (or insecure: true for local experiments only)');
  const keys = cfg.keys || loadOrCreateKey(path.join(cfg.dataDir, 'peer.key'));
  const authorities = cfg.authorities.length ? cfg.authorities : [keys.publicKey];
  const amAuthority = authorities.includes(keys.publicKey);
  const log = (...a) => cfg.log(`[${cfg.name}]`, ...a);
  const store = new Store(path.join(cfg.dataDir, 'chain.jsonl'), log);
  const votes = new Votes(path.join(cfg.dataDir, 'votes.json'));
  const chainOpts = { chainId: cfg.chainId, authorities };

  // Opening the chain validates every block (except the clock check): an edited file stops the peer.
  const chain = Chain.fromBlocks([genesis(cfg.chainId), ...store.load()], chainOpts, { checkClock: false });
  votes.prune(chain.height);
  const pending = new Map();
  const proposals = new Map(); // block hash -> proposal with the signatures gathered so far
  let lastProgressAt = Date.now();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 8e6 });
  const outgoing = new Map(); // url -> client socket

  function status() {
    return {
      name: cfg.name, chainId: cfg.chainId, publicKey: keys.publicKey, authorities, quorum: chain.quorum, isAuthority: amAuthority,
      height: chain.height, tip: chain.tip.hash, pending: pending.size, proposals: proposals.size,
      peers: [...outgoing.values()].filter((s) => s.connected).length + io.engine.clientsCount,
    };
  }

  const sockets = () => [...io.sockets.sockets.values(), ...[...outgoing.values()].filter((s) => s.connected)];
  function broadcast(event, payload, except) {
    for (const s of sockets()) if (s !== except) s.emit(event, payload);
  }

  function addEntry(entry, gossip) {
    if (chain.has(entry.hash) || pending.has(entry.hash)) return false;
    if (pending.size >= MAX_PENDING) throw new Error('pending pool is full');
    pending.set(entry.hash, entry);
    if (gossip) broadcast('entry', entry);
    return true;
  }

  // ---------- certified blocks ----------
  function accept(raw, from) {
    let block;
    try { block = chain.check(raw); } catch (e) { if (from) log(`rejected block from ${from}: ${e.message}`); return false; }
    store.append(block);          // disk first
    chain.commit(block);          // then memory
    for (const e of block.entries) pending.delete(e.hash);
    for (const [h, p] of proposals) if (p.header.index <= chain.height) proposals.delete(h);
    votes.prune(chain.height);
    lastProgressAt = Date.now();
    log(`block ${block.header.index} certified (${block.entries.length} readings, ${block.signatures.length} signatures)`);
    broadcast('block', block);
    return true;
  }

  function onBlock(raw, socket) {
    if (!raw || !raw.header || !Number.isSafeInteger(raw.header.index)) return;
    if (raw.header.index === chain.height + 1) accept(raw, 'the network');
    else if (raw.header.index > chain.height + 1 && socket) catchUp(socket);
  }

  // Asks a peer for the blocks after our tip, a page at a time. Certified blocks are final, so there is
  // nothing to roll back: either a block extends our tip or it is refused.
  async function catchUp(socket) {
    if (socket.syncing) return;
    socket.syncing = true;
    try {
      for (let i = 0; i < SYNC_ROUNDS; i++) {
        const page = await new Promise((resolve) => socket.timeout(15000).emit('get-blocks', { from: chain.height + 1 }, (err, blocks) => resolve(err ? null : blocks)));
        if (!Array.isArray(page) || !page.length) break;
        let added = 0;
        for (const b of page.slice(0, SYNC_PAGE)) { if (!accept(b, 'sync')) break; added++; }
        if (added < page.length || page.length < SYNC_PAGE) break;
      }
    } finally {
      socket.syncing = false;
    }
  }

  // ---------- proposals and votes ----------
  function tryCertify(hash) {
    const p = proposals.get(hash);
    if (!p || p.header.index !== chain.height + 1) return;
    if (chain.certifiers(p).size >= chain.quorum) accept({ ...p, signatures: [...p.signatures].sort((a, b) => a.signer.localeCompare(b.signer)) });
  }

  function addSignature(hash, signer, signature) {
    const p = proposals.get(hash);
    if (!p || p.signatures.some((s) => s.signer === signer)) return;
    if (!authorities.includes(signer) || !verifySignature(hash, signature, signer)) return;
    p.signatures.push({ signer, signature });
    tryCertify(hash);
  }

  // Signs a proposal if this authority has not signed another block at that height. The vote is on disk first.
  function vote(p) {
    if (!amAuthority || p.signatures.some((s) => s.signer === keys.publicKey)) return;
    if (!votes.record(p.header.index, p.hash)) return;
    const signature = sign(p.hash, keys.privateKey);
    p.signatures.push({ signer: keys.publicKey, signature });
    broadcast('vote', { index: p.header.index, hash: p.hash, signer: keys.publicKey, signature });
    tryCertify(p.hash);
  }

  function onProposal(raw, socket) {
    let p;
    try { p = sanitizeBlock(raw); } catch (e) { return; }
    if (p.header.index !== chain.height + 1 || proposals.has(p.hash)) {
      if (p.header.index > chain.height + 1 && socket) catchUp(socket);
      return;
    }
    try { chain.validateContent(p, chain.tip); } catch (e) { log(`ignored proposal ${p.header.index}: ${e.message}`); return; }
    const own = p.signatures.find((s) => s.signer === p.header.sealer);
    if (!own || !verifySignature(p.hash, own.signature, p.header.sealer)) return;
    p.signatures = p.signatures.filter((s) => authorities.includes(s.signer) && verifySignature(p.hash, s.signature, s.signer));
    proposals.set(p.hash, p);
    for (const e of p.entries) if (!pending.has(e.hash) && !chain.has(e.hash)) pending.set(e.hash, e); // so readings are never lost if the proposal dies
    broadcast('proposal', p, socket);
    vote(p);
    tryCertify(p.hash);
  }

  function onVote(v) {
    if (!v || typeof v.hash !== 'string' || typeof v.signer !== 'string' || typeof v.signature !== 'string') return;
    addSignature(v.hash, v.signer, v.signature);
  }

  function attach(socket) {
    let window = Date.now();
    let count = 0;
    socket.on('entry', (entry) => {
      try { addEntry(makeEntry(entry && entry.reading, entry && entry.deviceSignature), true); } catch (e) { /* invalid gossip is ignored */ }
    });
    socket.on('proposal', (p) => onProposal(p, socket));
    socket.on('vote', onVote);
    socket.on('block', (b) => onBlock(b, socket));
    socket.on('get-blocks', (req, reply) => {
      if (typeof reply !== 'function') return;
      if (Date.now() - window > RATE.windowMs) { window = Date.now(); count = 0; }
      if (++count > RATE.max) return reply([]);
      const from = Math.max(1, Number.isSafeInteger(req && req.from) ? req.from : 1);
      reply(chain.blocks.slice(from, from + SYNC_PAGE));
    });
  }

  io.use((socket, next) => {
    try {
      if (cfg.insecure && !cfg.networkToken) return next();
      return sameToken((socket.handshake.auth || {}).token, cfg.networkToken) ? next() : next(new Error('bad network token'));
    } catch (e) {
      return next(new Error('bad network token'));
    }
  });
  io.on('connection', (socket) => { attach(socket); catchUp(socket); });

  function connectPeers() {
    for (const url of cfg.peers) {
      if (outgoing.has(url)) continue;
      const s = ioClient(url, { auth: { token: cfg.networkToken }, reconnectionDelayMax: 5000 });
      attach(s);
      s.on('connect', () => catchUp(s));
      outgoing.set(url, s);
    }
  }

  // Proposes when it is this authority's turn (or the one whose turn it is stayed silent too long).
  // While a proposal at the next height is open, re-sends it and the votes so late peers can still certify it.
  function tick() {
    if (!amAuthority) return;
    const next = chain.height + 1;
    const open = [...proposals.values()].filter((p) => p.header.index === next);
    const mine = votes.get(next);
    if (open.length) {
      const p = proposals.get(mine) || open[0];
      broadcast('proposal', p);
      for (const s of p.signatures) broadcast('vote', { index: next, hash: p.hash, signer: s.signer, signature: s.signature });
      vote(p);
      return;
    }
    if (!pending.size || mine) return; // already signed something at this height: never propose a rival
    if (chain.leaderFor(next) !== keys.publicKey && Date.now() - lastProgressAt < cfg.leaderTimeoutMs) return;
    const batch = [...pending.values()].sort((a, b) => a.reading.takenAt.localeCompare(b.reading.takenAt) || a.hash.localeCompare(b.hash)).slice(0, MAX_ENTRIES);
    const p = chain.propose(batch, keys);
    if (!votes.record(next, p.hash)) return;
    proposals.set(p.hash, p);
    log(`proposed block ${next} (${batch.length} readings)`);
    broadcast('proposal', p);
    tryCertify(p.hash);
  }

  // ---------- HTTP ----------
  app.get('/status', (req, res) => res.json(status()));

  app.post('/entries', (req, res) => {
    if (!(cfg.insecure && !cfg.gatewayToken) && !sameToken(req.get('x-contrust-token'), cfg.gatewayToken)) return res.status(401).json({ error: 'bad token' });
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
    res.json({ chainId: cfg.chainId, height: chain.height, blocks: chain.blocks.slice(from, from + SYNC_PAGE) });
  });

  app.get('/blocks/:index', (req, res) => {
    const b = chain.blocks[parseInt(req.params.index, 10)];
    return b ? res.json(b) : res.status(404).json({ error: 'no such block' });
  });

  // The authorities listed here are what this peer reports. Auditors should check against their own list.
  app.get('/proof/:hash', (req, res) => {
    const p = chain.proof(req.params.hash);
    return p ? res.json({ ...p, reportedAuthorities: authorities }) : res.status(404).json({ error: 'reading not anchored (yet)' });
  });

  let timer = null;
  return {
    app, io, status, chain, keys, tick,
    listen() {
      return new Promise((resolve, reject) => server.once('error', (e) => reject(new Error(`port ${cfg.port}: ${e.code === 'EADDRINUSE' ? 'already in use (set PORT to another one)' : e.message}`))).listen(cfg.port, cfg.host, () => {
        cfg.port = server.address().port;
        timer = setInterval(() => { try { tick(); } catch (e) { log('sealing failed:', e.message); } }, cfg.sealIntervalMs);
        connectPeers();
        log(`listening on ${cfg.port}, height ${chain.height}, ${amAuthority ? 'authority' : 'follower'} ${keys.publicKey.slice(0, 12)}..., quorum ${chain.quorum} of ${authorities.length}`);
        resolve(cfg.port);
      }));
    },
    connect(urls) { cfg.peers.push(...urls); connectPeers(); },
    close() {
      clearInterval(timer);
      for (const s of outgoing.values()) s.close();
      io.close();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createPeer, sameToken };
