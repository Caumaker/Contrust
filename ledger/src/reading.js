'use strict';
// An instrument reading: the unit of evidence Contrust anchors. Everything the hash covers is listed here.
const { hashOf, verifySignature } = require('./crypto');

const FIELDS = ['instrumentId', 'takenAt', 'value', 'unit', 'raw', 'deviceId', 'meta'];

// Normalizes and validates. Throws with a readable message on bad input.
function normalizeReading(input) {
  const r = input && typeof input === 'object' ? input : {};
  const instrumentId = String(r.instrumentId || '').trim();
  if (!instrumentId || instrumentId.length > 120) throw new Error('instrumentId is required (up to 120 characters)');
  const takenAt = new Date(r.takenAt);
  if (Number.isNaN(takenAt.getTime())) throw new Error('takenAt must be a date (ISO 8601)');
  const value = typeof r.value === 'string' ? Number(r.value.replace(',', '.')) : r.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('value must be a finite number');
  const reading = { instrumentId, takenAt: takenAt.toISOString(), value };
  if (r.unit !== undefined && r.unit !== '') reading.unit = String(r.unit).slice(0, 32);
  if (r.raw !== undefined && r.raw !== '') reading.raw = String(r.raw).slice(0, 2000);
  if (r.deviceId !== undefined && r.deviceId !== '') reading.deviceId = String(r.deviceId).slice(0, 120);
  if (r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta)) {
    const meta = JSON.stringify(r.meta);
    if (meta.length > 4000) throw new Error('meta is too large (4 KB max)');
    reading.meta = JSON.parse(meta);
  }
  return reading;
}

// The hash identifies the reading everywhere: in the gateway, in the ledger and in proofs.
const readingHash = (reading) => hashOf(reading);

// Optional device signature: Ed25519 over the reading hash, checked against the device's registered key.
function checkDeviceSignature(reading, signature, devices) {
  if (!reading.deviceId) return { ok: !signature, reason: signature ? 'signature without deviceId' : 'unsigned' };
  const key = devices && devices[reading.deviceId];
  if (!key) return { ok: !signature, reason: signature ? 'unknown device' : 'unsigned' };
  if (!signature) return { ok: false, reason: 'registered device must sign its readings' };
  return verifySignature(readingHash(reading), signature, key) ? { ok: true, reason: 'signed' } : { ok: false, reason: 'bad device signature' };
}

module.exports = { FIELDS, normalizeReading, readingHash, checkDeviceSignature };
