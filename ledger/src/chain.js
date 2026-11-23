'use strict';
// The chain: blocks linked by hash, each one sealing a batch of readings under a Merkle root.
// A block counts only when a MAJORITY of the network's authorities (the parties of the contract) signed it.
// An honest authority never signs two different blocks at the same height, so with an honest majority there
// is never a second valid block for the same height: certified blocks are final and history cannot be rewritten
// by one party alone.
const { hashOf, merkleRoot, merkleProof, verifyMerkleProof, sign, verifySignature } = require('./crypto');
const { normalizeReading, readingHash } = require('./reading');

const VERSION = 3;
const ZERO = '0'.repeat(64);
const MAX_ENTRIES = 1000;            // readings per block
const MAX_CLOCK_SKEW_MS = 2 * 60e3;  // a new block from the future is rejected
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/;      // Ed25519 public key, 32 bytes
const SIG_B64 = /^[A-Za-z0-9+/]{86}==$/;     // Ed25519 signature, 64 bytes
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const quorumOf = (n) => Math.floor(n / 2) + 1;

// Same chainId, same genesis on every peer.
function genesis(chainId) {
  const header = { version: VERSION, chainId, index: 0, timestamp: '1970-01-01T00:00:00.000Z', previousHash: ZERO, merkleRoot: merkleRoot([]), count: 0, sealer: null };
  return { header, hash: hashOf(header), signatures: [], entries: [] };
}

// Merkle leaf of an entry: covers the reading hash AND the device signature, so neither can change unnoticed.
const leafOf = (entry) => hashOf({ hash: entry.hash, deviceSignature: entry.deviceSignature || null });

function makeEntry(input, deviceSignature) {
  const reading = normalizeReading(input);
  const entry = { hash: readingHash(reading), reading };
  if (deviceSignature !== undefined && deviceSignature !== null && deviceSignature !== '') {
    if (typeof deviceSignature !== 'string' || !SIG_B64.test(deviceSignature)) throw new Error('deviceSignature must be a base64 Ed25519 signature');
    entry.deviceSignature = deviceSignature;
  }
  return entry;
}

// Rebuilds a block received from the network or read from disk out of known fields with strict types.
// Anything else (extra properties, Buffers, objects where strings belong) is dropped or refused.
function sanitizeBlock(b) {
  const fail = (m) => { throw new Error('malformed block: ' + m); };
  if (!b || typeof b !== 'object' || !b.header || typeof b.header !== 'object') fail('no header');
  const h = b.header;
  const header = {
    version: h.version, chainId: h.chainId, index: h.index, timestamp: h.timestamp,
    previousHash: h.previousHash, merkleRoot: h.merkleRoot, count: h.count, sealer: h.sealer,
  };
  if (header.version !== VERSION) fail(`version ${header.version}`);
  if (typeof header.chainId !== 'string' || !header.chainId || header.chainId.length > 64) fail('chainId');
  if (!Number.isSafeInteger(header.index) || header.index < 1) fail('index');
  if (typeof header.timestamp !== 'string' || !ISO.test(header.timestamp)) fail('timestamp');
  if (!HEX64.test(String(header.previousHash)) || !HEX64.test(String(header.merkleRoot))) fail('hashes');
  if (!Number.isSafeInteger(header.count) || header.count < 1 || header.count > MAX_ENTRIES) fail('count');
  if (typeof header.sealer !== 'string' || !KEY_B64.test(header.sealer)) fail('sealer');
  if (typeof b.hash !== 'string' || !HEX64.test(b.hash)) fail('hash');
  if (!Array.isArray(b.signatures) || b.signatures.length > 64) fail('signatures');
  const signatures = b.signatures.map((s) => {
    if (!s || typeof s.signer !== 'string' || !KEY_B64.test(s.signer) || typeof s.signature !== 'string' || !SIG_B64.test(s.signature)) fail('signature entry');
    return { signer: s.signer, signature: s.signature };
  });
  if (!Array.isArray(b.entries) || b.entries.length !== header.count) fail('entries');
  const entries = b.entries.map((e) => {
    if (!e || typeof e.hash !== 'string' || !HEX64.test(e.hash)) fail('entry hash');
    const out = { hash: e.hash, reading: e.reading };
    if (e.deviceSignature !== undefined) {
      if (typeof e.deviceSignature !== 'string' || !SIG_B64.test(e.deviceSignature)) fail('deviceSignature');
      out.deviceSignature = e.deviceSignature;
    }
    return out;
  });
  return { header, hash: b.hash, signatures, entries };
}

class Chain {
  constructor({ chainId, authorities }) {
    if (!chainId) throw new Error('chainId is required');
    this.chainId = chainId;
    this.authorities = [...new Set(authorities || [])].sort();
    if (!this.authorities.length) throw new Error('at least one authority is required');
    this.quorum = quorumOf(this.authorities.length);
    this.blocks = [genesis(chainId)];
    this.where = new Map(); // reading hash -> [block index, position]
  }

  get height() { return this.blocks.length - 1; }
  get tip() { return this.blocks[this.blocks.length - 1]; }
  has(hash) { return this.where.has(hash); }

  // Round robin: the authority expected to propose the block at this index.
  leaderFor(index) { return this.authorities[index % this.authorities.length]; }

  // Checks everything except the signatures (used for proposals, which carry only the proposer's).
  // Throws Error(reason). checkClock = false when reading our own file (a clock reset must not lock us out).
  validateContent(block, prev, { checkClock = true } = {}) {
    const h = block.header;
    if (h.chainId !== this.chainId) throw new Error(`block belongs to chain "${h.chainId}"`);
    if (h.index !== prev.header.index + 1) throw new Error(`expected index ${prev.header.index + 1}, got ${h.index}`);
    if (h.previousHash !== prev.hash) throw new Error(`block ${h.index} does not point to the previous block`);
    if (block.hash !== hashOf(h)) throw new Error(`block ${h.index} hash does not match its header`);
    if (Date.parse(h.timestamp) < Date.parse(prev.header.timestamp)) throw new Error(`block ${h.index} timestamp goes back in time`);
    if (checkClock && Date.parse(h.timestamp) > Date.now() + MAX_CLOCK_SKEW_MS) throw new Error(`block ${h.index} timestamp is in the future`);
    if (!this.authorities.includes(h.sealer)) throw new Error(`block ${h.index} proposed by a key that is not an authority`);
    const local = new Set();
    for (const e of block.entries) {
      let normalized;
      try { normalized = normalizeReading(e.reading); } catch (err) { throw new Error(`block ${h.index}: invalid reading (${err.message})`); }
      if (hashOf(normalized) !== hashOf(e.reading) || readingHash(normalized) !== e.hash) throw new Error(`block ${h.index}: reading ${e.hash.slice(0, 12)} was altered`);
      if (local.has(e.hash) || this.where.has(e.hash)) throw new Error(`block ${h.index}: reading ${e.hash.slice(0, 12)} appears twice`);
      local.add(e.hash);
    }
    if (h.merkleRoot !== merkleRoot(block.entries.map(leafOf))) throw new Error(`block ${h.index} Merkle root does not match its readings`);
  }

  // Valid signatures of distinct authorities over the block hash.
  certifiers(block) {
    const ok = new Set();
    for (const s of block.signatures) if (this.authorities.includes(s.signer) && !ok.has(s.signer) && verifySignature(block.hash, s.signature, s.signer)) ok.add(s.signer);
    return ok;
  }

  validateBlock(block, prev, opts) {
    this.validateContent(block, prev, opts);
    const n = this.certifiers(block).size;
    if (n < this.quorum) throw new Error(`block ${block.header.index} has ${n} valid authority signature(s), needs ${this.quorum}`);
  }

  // check() validates without changing anything; commit() adds a checked block. The peer writes to disk in between.
  check(raw, opts) {
    const block = sanitizeBlock(raw);
    this.validateBlock(block, this.tip, opts);
    return block;
  }

  commit(block) {
    this.blocks.push(block);
    block.entries.forEach((e, i) => this.where.set(e.hash, [block.header.index, i]));
    return block;
  }

  append(raw, opts) { return this.commit(this.check(raw, opts)); }

  // The proposer builds the next block and signs it; it still needs the other authorities' signatures.
  propose(entries, keys, now = new Date()) {
    if (!entries.length) throw new Error('nothing to seal');
    const prev = this.tip;
    const ts = new Date(Math.max(now.getTime(), Date.parse(prev.header.timestamp))).toISOString();
    const batch = entries.slice(0, MAX_ENTRIES);
    const header = {
      version: VERSION, chainId: this.chainId, index: prev.header.index + 1, timestamp: ts,
      previousHash: prev.hash, merkleRoot: merkleRoot(batch.map(leafOf)), count: batch.length, sealer: keys.publicKey,
    };
    const hash = hashOf(header);
    return { header, hash, signatures: [{ signer: keys.publicKey, signature: sign(hash, keys.privateKey) }], entries: batch };
  }

  // Validates a whole list of blocks (genesis included) and returns a new Chain, or throws.
  static fromBlocks(blocks, opts, appendOpts) {
    const c = new Chain(opts);
    if (!Array.isArray(blocks) || !blocks.length) throw new Error('empty chain');
    if (blocks[0].hash !== c.blocks[0].hash) throw new Error('genesis does not match this network');
    for (let i = 1; i < blocks.length; i++) c.append(blocks[i], appendOpts);
    return c;
  }

  // Everything an auditor needs to check one reading without trusting the server.
  proof(hash) {
    const at = this.where.get(hash);
    if (!at) return null;
    const block = this.blocks[at[0]];
    return {
      chainId: this.chainId,
      entry: block.entries[at[1]],
      merkleProof: merkleProof(block.entries.map(leafOf), at[1]),
      block: { header: block.header, hash: block.hash, signatures: block.signatures },
      confirmations: this.height - at[0],
    };
  }
}

// Checks a proof on its own against the authorities you trust: the reading asked for, the Merkle path,
// the block hash, the chain id and a majority of authority signatures.
function verifyProof(proof, authorities, expected = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!proof || !proof.entry || !proof.block || !proof.block.header) return fail('incomplete proof');
  if (!Array.isArray(authorities) || !authorities.length) return fail('no trusted authorities given');
  const auth = [...new Set(authorities)];
  if (expected.hash && proof.entry.hash !== expected.hash) return fail(`the proof is about reading ${String(proof.entry.hash).slice(0, 12)}, not the one asked for`);
  let reading;
  try { reading = normalizeReading(proof.entry.reading); } catch (e) { return fail('invalid reading: ' + e.message); }
  if (readingHash(reading) !== proof.entry.hash || hashOf(reading) !== hashOf(proof.entry.reading)) return fail('the reading does not match its hash');
  const { header, hash } = proof.block;
  if (expected.chainId && header.chainId !== expected.chainId) return fail(`the block belongs to chain "${header.chainId}"`);
  if (hashOf(header) !== hash) return fail('the block header does not match the block hash');
  if (!verifyMerkleProof(leafOf(proof.entry), proof.merkleProof || [], header.merkleRoot)) return fail('the reading is not in that block (Merkle path fails)');
  const signers = new Set();
  for (const s of proof.block.signatures || []) if (s && auth.includes(s.signer) && verifySignature(hash, s.signature, s.signer)) signers.add(s.signer);
  const quorum = quorumOf(auth.length);
  if (signers.size < quorum) return fail(`the block has ${signers.size} valid authority signature(s), needs ${quorum}`);
  return { ok: true, reason: `reading included in block ${header.index} (${hash.slice(0, 16)}...), signed by ${signers.size} of ${auth.length} authorities` };
}

module.exports = { Chain, genesis, makeEntry, sanitizeBlock, leafOf, verifyProof, quorumOf, MAX_ENTRIES, VERSION };
