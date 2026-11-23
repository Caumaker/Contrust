#!/usr/bin/env node
'use strict';
// Device simulator: replays a logger file (one reading per line) into the gateway, like a field instrument would.
//   node devices/simulator.js --instrument PZ-01 --unit kPa --interval 2000
//   node devices/simulator.js --key data/devices/logger-1.key --device logger-1   (signs every reading)
// File format (as exported by common dataloggers): "D/M/YY H:MM<tab>value", decimal comma accepted.
const fs = require('fs');
const path = require('path');
const { loadOrCreateKey, sign } = require('../ledger/src/crypto');
const { normalizeReading, readingHash } = require('../ledger/src/reading');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  return a;
}

// "2/8/20 19:00\t43,94822107" -> { takenAt: 2020-08-02T19:00, value: 43.948... }. Day first; times in the given UTC offset.
function parseLine(line, utcOffset = '-03:00') {
  const m = String(line).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(-?[\d.,]+)$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s, v] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const iso = `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${s || '00'}${utcOffset}`;
  return { takenAt: new Date(iso).toISOString(), value: Number(v.replace(',', '.')), raw: line.trim() };
}

async function main() {
  const a = args(process.argv.slice(2));
  const gateway = (a.gateway || process.env.GATEWAY_URL || 'http://localhost:6001').replace(/\/+$/, '');
  const file = a.file || path.join(__dirname, 'data', 'sample-readings.txt');
  const interval = Number(a.interval || 2000);
  const limit = Number(a.limit || Infinity);
  const device = a.device || '';
  const key = a.key ? loadOrCreateKey(a.key) : null;
  if (key) console.log(`device ${device || '(no --device given)'} public key: ${key.publicKey}  (register it in the gateway DEVICES_FILE)`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => parseLine(l, a.utc || '-03:00')).filter(Boolean);
  console.log(`replaying ${Math.min(lines.length, limit)} readings from ${path.basename(file)} into ${gateway} every ${interval} ms`);
  for (let i = 0; i < lines.length && i < limit; i++) {
    const reading = normalizeReading({ instrumentId: a.instrument || 'PZ-01', unit: a.unit || 'kPa', deviceId: device || undefined, ...lines[i] });
    const body = { reading };
    if (key) body.signature = sign(readingHash(reading), key.privateKey);
    try {
      const r = await fetch(gateway + '/api/readings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-contrust-device-token': process.env.DEVICE_TOKEN || '' }, body: JSON.stringify(body) });
      const j = await r.json();
      console.log(`${reading.takenAt} ${reading.value} -> ${r.status} ${j.state || j.error || ''} ${j.hash ? j.hash.slice(0, 12) : ''}`);
    } catch (e) {
      console.log(`${reading.takenAt} gateway unreachable (${e.message}); the logger keeps going`);
    }
    if (i + 1 < lines.length && i + 1 < limit) await new Promise((r) => setTimeout(r, interval));
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parseLine };
