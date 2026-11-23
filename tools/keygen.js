#!/usr/bin/env node
'use strict';
// Creates (or shows) an Ed25519 key for a peer or a device and prints its public key.
//   node tools/keygen.js data/peer1/peer.key
const { loadOrCreateKey } = require('../ledger/src/crypto');
const file = process.argv[2];
if (!file) { console.error('usage: node tools/keygen.js <path/to/file.key>'); process.exit(1); }
console.log(loadOrCreateKey(file).publicKey);
