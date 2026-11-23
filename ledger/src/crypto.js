'use strict';
// Hashing, canonical JSON, Merkle trees and Ed25519 signatures. Node's crypto module only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// JSON with keys sorted at every level: the same object always hashes the same way.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const hashOf = (obj) => sha256(canonical(obj));

// Merkle tree over hex leaf hashes. An odd node is paired with itself (Bitcoin style).
function merkleLevels(leaves) {
  if (!leaves.length) return [[sha256('')]];
  const levels = [leaves.slice()];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(sha256(prev[i] + (prev[i + 1] || prev[i])));
    levels.push(next);
  }
  return levels;
}

const merkleRoot = (leaves) => { const l = merkleLevels(leaves); return l[l.length - 1][0]; };

// Inclusion proof: the sibling hashes from the leaf up to the root, with the side each one sits on.
function merkleProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new RangeError('leaf index out of range');
  const levels = merkleLevels(leaves);
  const proof = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sibling = index % 2 ? index - 1 : index + 1;
    proof.push({ side: index % 2 ? 'left' : 'right', hash: level[sibling] !== undefined ? level[sibling] : level[index] });
    index = Math.floor(index / 2);
  }
  return proof;
}

function verifyMerkleProof(leaf, proof, root) {
  let h = leaf;
  for (const step of proof) h = step.side === 'left' ? sha256(step.hash + h) : sha256(h + step.hash);
  return h === root;
}

// Ed25519 keys as base64 of the raw 32-byte public key: short enough to put in configs and block headers.
function publicKeyToB64(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

function publicKeyFromB64(b64) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex'); // SPKI header for Ed25519
  return crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });
}

function generateKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKeyToB64(publicKey), privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
}

// Loads the key from file or creates it (mode 0600) the first time.
function loadOrCreateKey(file) {
  if (fs.existsSync(file)) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
    return { privateKey, publicKey: publicKeyToB64(crypto.createPublicKey(privateKey)) };
  }
  const k = generateKeys();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, k.privatePem, { mode: 0o600 });
  return { privateKey: k.privateKey, publicKey: k.publicKey };
}

const sign = (message, privateKey) => crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

function verifySignature(message, signatureB64, publicKeyB64) {
  try {
    return crypto.verify(null, Buffer.from(message), publicKeyFromB64(publicKeyB64), Buffer.from(String(signatureB64), 'base64'));
  } catch (e) {
    return false;
  }
}

module.exports = {
  sha256, canonical, hashOf, merkleRoot, merkleProof, verifyMerkleProof,
  generateKeys, loadOrCreateKey, sign, verifySignature, publicKeyFromB64,
};
