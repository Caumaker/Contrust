#!/usr/bin/env node
'use strict';
// Starts one ledger peer from environment variables (see README: "Running a network").
const { createPeer } = require('./src/peer');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const peer = createPeer({
  port: Number(process.env.PORT || 5101),
  name: process.env.PEER_NAME || `peer-${process.env.PORT || 5101}`,
  chainId: process.env.CHAIN_ID || 'contrust-demo',
  dataDir: process.env.DATA_DIR || `./data/${process.env.PEER_NAME || 'peer-' + (process.env.PORT || 5101)}`,
  peers: list(process.env.PEERS),
  authorities: list(process.env.AUTHORITIES),
  gatewayToken: process.env.GATEWAY_TOKEN || '',
  networkToken: process.env.NETWORK_TOKEN || '',
  sealIntervalMs: Number(process.env.SEAL_INTERVAL_MS || 3000),
});
peer.listen().catch((e) => { console.error(e.message); process.exit(1); });
process.on('SIGTERM', () => peer.close().then(() => process.exit(0)));
process.on('SIGINT', () => peer.close().then(() => process.exit(0)));
