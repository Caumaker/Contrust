#!/usr/bin/env node
'use strict';
// Independent verifier: checks a chain or one reading without trusting the peer that served it.
//   contrust-verify --peer http://localhost:5101 [--authorities key1,key2]   whole chain
//   contrust-verify --peer http://localhost:5101 --reading <hash>             one reading (Merkle proof)
//   contrust-verify --file data/peer1/chain.jsonl --chain contrust-demo --authorities k1,k2,k3
// Pass --authorities from a source you trust (the contract, the network config). Without it the verifier
// uses the list the peer reports, which only proves internal consistency.
const fs = require('fs');
const { Chain, genesis, verifyProof } = require('../ledger/src/chain');

const a = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) a[process.argv[i].slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = (ok, msg) => { console.log((ok ? 'VALID   ' : 'INVALID ') + msg); process.exit(ok ? 0 : 2); };

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function main() {
  let authorities = list(a.authorities);
  const trusted = authorities.length > 0;
  if (a.reading) {
    if (!a.peer) throw new Error('--reading needs --peer');
    const proof = await getJson(`${a.peer.replace(/\/+$/, '')}/proof/${a.reading}`);
    if (!trusted) authorities = proof.authorities;
    const v = verifyProof(proof, authorities);
    return out(v.ok, `${v.reason}${v.ok ? `, ${proof.confirmations} confirmations` : ''}${trusted ? '' : ' (authorities as reported by the peer)'}`);
  }
  let blocks;
  let chainId = a.chain;
  if (a.file) {
    if (!chainId) throw new Error('--file needs --chain <chainId>');
    blocks = [genesis(chainId), ...fs.readFileSync(a.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))];
    if (!trusted) throw new Error('--file needs --authorities');
  } else if (a.peer) {
    const base = a.peer.replace(/\/+$/, '');
    const status = await getJson(base + '/status');
    chainId = status.chainId;
    if (!trusted) authorities = status.authorities;
    blocks = [];
    for (let from = 0, voltas = 0; voltas < 10000; voltas++) { // ceiling: 10000 pages
      const page = await getJson(`${base}/chain?from=${from}`);
      blocks.push(...page.blocks);
      from += page.blocks.length;
      if (!page.blocks.length || from > page.height) break;
    }
  } else {
    throw new Error('use --peer <url> or --file <chain.jsonl>');
  }
  try {
    const c = Chain.fromBlocks(blocks, { chainId, authorities });
    const readings = c.blocks.reduce((n, b) => n + b.entries.length, 0);
    out(true, `chain "${chainId}": ${c.height} blocks, ${readings} readings, tip ${c.tip.hash.slice(0, 16)}...${trusted ? '' : ' (authorities as reported by the peer)'}`);
  } catch (e) {
    out(false, e.message);
  }
}

main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
