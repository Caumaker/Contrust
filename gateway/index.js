#!/usr/bin/env node
'use strict';
// Starts the gateway from environment variables (see README).
const fs = require('fs');
const { createGateway } = require('./src/server');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
let devices = {};
if (process.env.DEVICES_FILE && fs.existsSync(process.env.DEVICES_FILE)) devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE, 'utf8'));
const gw = createGateway({
  port: Number(process.env.PORT || 6001),
  dataDir: process.env.DATA_DIR || './data/gateway',
  ledgerUrls: list(process.env.LEDGER_URLS || 'http://localhost:5101'),
  chainId: process.env.CHAIN_ID || '',
  authorities: list(process.env.AUTHORITIES),
  gatewayToken: process.env.GATEWAY_TOKEN || '',
  networkToken: process.env.NETWORK_TOKEN || '',
  deviceToken: process.env.DEVICE_TOKEN || '',
  devices,
  requireSignatures: process.env.REQUIRE_SIGNATURES === 'true',
});
gw.listen().catch((e) => { console.error(e.message); process.exit(1); });
process.on('SIGTERM', () => gw.close().then(() => process.exit(0)));
process.on('SIGINT', () => gw.close().then(() => process.exit(0)));
