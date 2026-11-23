#!/usr/bin/env node
'use strict';
// One command demo: three ledger peers, the gateway and a device simulator, on this machine.
// Keys, tokens and data go to ./data/demo (delete the folder to start over).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadOrCreateKey } = require('../ledger/src/crypto');

const root = path.join(__dirname, '..');
const data = path.join(root, 'data', 'demo');
fs.mkdirSync(data, { recursive: true });
const secretFile = path.join(data, 'tokens.json');
const tokens = fs.existsSync(secretFile) ? JSON.parse(fs.readFileSync(secretFile, 'utf8'))
  : { gateway: crypto.randomBytes(16).toString('hex'), network: crypto.randomBytes(16).toString('hex') };
fs.writeFileSync(secretFile, JSON.stringify(tokens), { mode: 0o600 });

const peers = [5101, 5102, 5103].map((port, i) => ({ port, name: `peer${i + 1}`, key: loadOrCreateKey(path.join(data, `peer${i + 1}`, 'peer.key')) }));
const device = loadOrCreateKey(path.join(data, 'devices', 'logger-1.key'));
fs.writeFileSync(path.join(data, 'devices.json'), JSON.stringify({ 'logger-1': device.publicKey }, null, 2));
const authorities = peers.map((p) => p.key.publicKey).join(',');
const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m'];
const children = [];

function run(label, script, env, color) {
  const child = spawn(process.execPath, [path.join(root, script), ...(env.ARGS || [])], { env: { ...process.env, ...env }, cwd: root });
  const prefix = `${color}${label.padEnd(9)}\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (d) => { const lines = (rest + d).split('\n'); rest = lines.pop(); lines.forEach((l) => console.log(prefix + l)); });
  }
  children.push(child);
}

peers.forEach((p, i) => run(p.name, 'ledger/index.js', {
  PORT: String(p.port), PEER_NAME: p.name, CHAIN_ID: 'contrust-demo', DATA_DIR: path.join(data, p.name),
  PEERS: peers.filter((o) => o !== p).map((o) => `http://localhost:${o.port}`).join(','), AUTHORITIES: authorities,
  GATEWAY_TOKEN: tokens.gateway, NETWORK_TOKEN: tokens.network,
}, colors[i]));
setTimeout(() => run('gateway', 'gateway/index.js', {
  PORT: '6001', DATA_DIR: path.join(data, 'gateway'), LEDGER_URLS: 'http://localhost:5101,http://localhost:5102',
  GATEWAY_TOKEN: tokens.gateway, NETWORK_TOKEN: tokens.network, DEVICES_FILE: path.join(data, 'devices.json'),
}, colors[3]), 800);
setTimeout(() => {
  console.log('\n  Dashboard: http://localhost:6001   Verify: npm run verify -- --peer http://localhost:5101\n');
  run('device', 'devices/simulator.js', { ARGS: ['--instrument', 'PZ-01', '--unit', 'kPa', '--device', 'logger-1', '--key', path.join(data, 'devices', 'logger-1.key'), '--interval', process.env.INTERVAL || '1500'] }, colors[4]);
}, 2500);

const stop = () => { children.forEach((c) => c.kill('SIGTERM')); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
