'use strict';
// The chain: blocks linked by hash, each one sealing a batch of readings under a Merkle root and signed
// by one of the network's authorities (proof of authority: the parties of a construction contract, not miners).
const { hashOf, merkleRoot, merkleProof, verifyMerkleProof, sign, verifySignature } = require('./crypto');
const { normalizeReading, readingHash } = require('./reading');

const VERSION = 2;
const ZERO = '0'.repeat(64);
const MAX_ENTRIES = 1000;            // readings per block
const MAX_CLOCK_SKEW_MS = 2 * 60e3;  // a block from the future is rejected

// Same chainId, same genesis on every peer: no signature, fixed timestamp.
function genesis(chainId) {
  const header = { version: VERSION, chainId, index: 0, timestamp: '1970-01-01T00:00:00.000Z', previousHash: ZERO, merkleRoot: merkleRoot([]), count: 0, sealer: null };
  return { header, hash: hashOf(header), signature: null, entries: [] };
}

// Entry = reading + its hash (+ the device signature, when the device signs).
function makeEntry(input, deviceSignature) {
  const reading = normalizeReading(input);
  const entry = { hash: readingHash(reading), reading };
  if (deviceSignature) entry.deviceSignature = String(deviceSignature);
  return entry;
}

class Chain {
  constructor({ chainId, authorities }) {
    if (!chainId) throw new Error('chainId is required');
    this.chainId = chainId;
    this.authorities = [...new Set(authorities || [])].sort();
    this.blocks = [genesis(chainId)];
    this.where = new Map(); // reading hash -> [block index, position]
  }

  get height() { return this.blocks.length - 1; }
  get tip() { return this.blocks[this.blocks.length - 1]; }
  has(hash) { return this.where.has(hash); }

  // Round robin: the authority expected to seal the block at this index.
  leaderFor(index) { return this.authorities.length ? this.authorities[index % this.authorities.length] : null; }

  // Throws Error(reason) if the block cannot follow prev. seen = reading hashes already in the chain.
  validateBlock(block, prev, seen) {
    const h = block && block.header;
    if (!h || typeof h !== 'object') throw new Error('block without header');
    if (h.version !== VERSION) throw new Error(`unsupported block version ${h.version}`);
    if (h.chainId !== this.chainId) throw new Error(`block belongs to chain "${h.chainId}"`);
    if (h.index !== prev.header.index + 1) throw new Error(`expected index ${prev.header.index + 1}, got ${h.index}`);
    if (h.previousHash !== prev.hash) throw new Error(`block ${h.index} does not point to the previous block`);
    if (block.hash !== hashOf(h)) throw new Error(`block ${h.index} hash does not match its header`);
    const t = Date.parse(h.timestamp);
    if (Number.isNaN(t) || t < Date.parse(prev.header.timestamp)) throw new Error(`block ${h.index} timestamp goes back in time`);
    if (t > Date.now() + MAX_CLOCK_SKEW_MS) throw new Error(`block ${h.index} timestamp is in the future`);
    if (!this.authorities.includes(h.sealer)) throw new Error(`block ${h.index} sealed by a key that is not an authority`);
    if (!verifySignature(block.hash, block.signature, h.sealer)) throw new Error(`block ${h.index} signature is invalid`);
    const entries = Array.isArray(block.entries) ? block.entries : null;
    if (!entries || entries.length !== h.count || !entries.length || entries.length > MAX_ENTRIES) throw new Error(`block ${h.index} has a wrong number of readings`);
    const local = new Set();
    for (const e of entries) {
      let normalized;
      try { normalized = normalizeReading(e.reading); } catch (err) { throw new Error(`block ${h.index}: invalid reading (${err.message})`); }
      if (hashOf(normalized) !== hashOf(e.reading) || readingHash(normalized) !== e.hash) throw new Error(`block ${h.index}: reading ${String(e.hash).slice(0, 12)} was altered`);
      if (local.has(e.hash) || (seen && seen.has(e.hash))) throw new Error(`block ${h.index}: reading ${e.hash.slice(0, 12)} appears twice`);
      local.add(e.hash);
    }
    if (h.merkleRoot !== merkleRoot(entries.map((e) => e.hash))) throw new Error(`block ${h.index} Merkle root does not match its readings`);
  }

  append(block) {
    this.validateBlock(block, this.tip, this.where);
    this.blocks.push(block);
    block.entries.forEach((e, i) => this.where.set(e.hash, [block.header.index, i]));
    return block;
  }

  // Builds and signs the next block with this peer's key.
  seal(entries, keys, now = new Date()) {
    if (!entries.length) throw new Error('nothing to seal');
    const prev = this.tip;
    const ts = new Date(Math.max(now.getTime(), Date.parse(prev.header.timestamp))).toISOString();
    const batch = entries.slice(0, MAX_ENTRIES);
    const header = {
      version: VERSION, chainId: this.chainId, index: prev.header.index + 1, timestamp: ts,
      previousHash: prev.hash, merkleRoot: merkleRoot(batch.map((e) => e.hash)), count: batch.length, sealer: keys.publicKey,
    };
    const hash = hashOf(header);
    return this.append({ header, hash, signature: sign(hash, keys.privateKey), entries: batch });
  }

  // Validates a whole list of blocks (genesis included) and returns a new Chain, or throws.
  static fromBlocks(blocks, opts) {
    const c = new Chain(opts);
    if (!Array.isArray(blocks) || !blocks.length) throw new Error('empty chain');
    if (blocks[0].hash !== c.blocks[0].hash) throw new Error('genesis does not match this network');
    for (let i = 1; i < blocks.length; i++) c.append(blocks[i]);
    return c;
  }

  // Fork choice: the longer valid chain wins; on a tie, the one whose tip hash is lower (same answer on every peer).
  isBetter(other) {
    return other.height > this.height || (other.height === this.height && other.tip.hash < this.tip.hash);
  }

  // Everything an auditor needs to check one reading without trusting the server.
  proof(hash) {
    const at = this.where.get(hash);
    if (!at) return null;
    const block = this.blocks[at[0]];
    return {
      chainId: this.chainId,
      entry: block.entries[at[1]],
      merkleProof: merkleProof(block.entries.map((e) => e.hash), at[1]),
      block: { header: block.header, hash: block.hash, signature: block.signature },
      confirmations: this.height - at[0],
    };
  }
}

// Checks a proof on its own: reading hash, Merkle path, block hash and authority signature.
function verifyProof(proof, authorities) {
  const fail = (reason) => ({ ok: false, reason });
  if (!proof || !proof.entry || !proof.block) return fail('incomplete proof');
  let reading;
  try { reading = normalizeReading(proof.entry.reading); } catch (e) { return fail('invalid reading: ' + e.message); }
  if (readingHash(reading) !== proof.entry.hash) return fail('the reading does not match its hash');
  const { header, hash, signature } = proof.block;
  if (hashOf(header) !== hash) return fail('the block header does not match the block hash');
  if (!verifyMerkleProof(proof.entry.hash, proof.merkleProof || [], header.merkleRoot)) return fail('the reading is not in that block (Merkle path fails)');
  if (authorities && !authorities.includes(header.sealer)) return fail('the block was sealed by a key that is not an authority');
  if (!verifySignature(hash, signature, header.sealer)) return fail('the block signature is invalid');
  return { ok: true, reason: `reading included in block ${header.index} (${hash.slice(0, 16)}...)` };
}

module.exports = { Chain, genesis, makeEntry, verifyProof, MAX_ENTRIES, VERSION };
