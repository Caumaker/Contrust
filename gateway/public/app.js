'use strict';
// Contrust dashboard: live readings, chart per instrument and in-browser proof checking.
const $ = (id) => document.getElementById(id);
const leituras = new Map();
let escolhido = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const quando = (iso) => new Date(iso).toLocaleString();

// Same canonical JSON as the ledger (ledger/src/crypto.js): sorted keys at every level.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
async function sha256(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function selo(r) {
  if (r.state === 'anchored') return `<span class="selo anchored">block #${r.block}</span>`;
  return `<span class="selo ${r.state}">${r.state === 'queued' ? 'queued (ledger offline)' : 'waiting for block'}</span>`;
}

function linha(r, novo) {
  const x = r.reading;
  return `<tr data-hash="${r.hash}" class="${novo ? 'novo' : ''}">
    <td>${esc(quando(x.takenAt))}</td><td>${esc(x.instrumentId)}</td>
    <td class="num">${esc(x.value)} ${esc(x.unit || '')}</td>
    <td>${x.deviceId ? esc(x.deviceId) + (r.signed ? ' <span class="assinado" title="signed by the device">✔</span>' : '') : '<span class="pequeno">-</span>'}</td>
    <td>${selo(r)}</td>
    <td><button class="verificar" data-hash="${r.hash}" ${r.state === 'anchored' ? '' : 'disabled'}>Verify</button></td></tr>`;
}

function desenharTabela(novo) {
  const lista = [...leituras.values()].sort((a, b) => b.reading.takenAt.localeCompare(a.reading.takenAt)).slice(0, 150);
  if (!lista.length) return;
  $('leituras').innerHTML = lista.map((r) => linha(r, r.hash === novo)).join('');
}

async function carregarInstrumentos() {
  const lista = await (await fetch('/api/instruments')).json();
  if (!escolhido && lista.length) escolhido = lista[0].instrumentId;
  $('instrumentos').innerHTML = lista.map((i) => `<button class="chip ${i.instrumentId === escolhido ? 'ativo' : ''}" data-i="${esc(i.instrumentId)}">${esc(i.instrumentId)}<small>${i.last ? esc(i.last.value) + ' ' + esc(i.unit) : ''} · ${i.anchored}/${i.count}</small></button>`).join('');
  desenharGrafico();
}

function desenharGrafico() {
  const pts = [...leituras.values()].filter((r) => r.reading.instrumentId === escolhido).sort((a, b) => a.reading.takenAt.localeCompare(b.reading.takenAt)).slice(-200);
  const svg = $('grafico');
  if (pts.length < 2) { svg.innerHTML = '<text x="450" y="115" fill="#8d99b3" text-anchor="middle" font-size="14">waiting for readings</text>'; return; }
  const vs = pts.map((p) => p.reading.value);
  const min = Math.min(...vs), max = Math.max(...vs), faixa = max - min || 1;
  const x = (i) => 40 + (i / (pts.length - 1)) * 840;
  const y = (v) => 190 - ((v - min) / faixa) * 160;
  const caminho = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.reading.value).toFixed(1)}`).join(' ');
  const pontos = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.reading.value).toFixed(1)}" r="2.6" fill="${p.state === 'anchored' ? '#2fcf84' : '#f0b43c'}"><title>${esc(quando(p.reading.takenAt))}: ${esc(p.reading.value)}</title></circle>`).join('');
  svg.innerHTML = `<text x="8" y="34" fill="#8d99b3" font-size="11">${esc(max)}</text><text x="8" y="194" fill="#8d99b3" font-size="11">${esc(min)}</text>
    <path d="${caminho}" fill="none" stroke="#4c8dff" stroke-width="1.6"/>${pontos}`;
}

async function carregar() {
  const lista = await (await fetch('/api/readings?limit=500')).json();
  lista.forEach((r) => leituras.set(r.hash, r));
  desenharTabela();
  await carregarInstrumentos();
  estado(await (await fetch('/api/status')).json());
}

function estado(s) {
  const l = s.ledger || s;
  if (s.readings !== undefined) $('ancoradas').textContent = `${s.anchored} / ${s.readings}`;
  if (l && l.height !== undefined) {
    $('altura').textContent = l.height;
    $('pendentes').textContent = l.pending;
    $('pares').textContent = l.peers;
    $('ponta').textContent = l.tip.slice(0, 24) + '…';
  }
}

async function verificar(hash) {
  const passos = $('passos');
  $('provaHash').textContent = hash;
  passos.innerHTML = '<li>Fetching the proof…</li>';
  $('prova').showModal();
  const r = await fetch(`/api/readings/${hash}/proof`);
  const j = await r.json();
  if (!r.ok) { passos.innerHTML = `<li class="falha">✘ ${esc(j.error || 'no proof')}</li>`; return; }
  const p = j.proof;
  const item = (ok, txt) => `<li class="${ok ? 'ok' : 'falha'}">${ok ? '✔' : '✘'} ${txt}</li>`;
  const h1 = await sha256(canonical(p.entry.reading));
  let h = p.entry.hash;
  for (const s of p.merkleProof) h = s.side === 'left' ? await sha256(s.hash + h) : await sha256(h + s.hash);
  const h3 = await sha256(canonical(p.block.header));
  passos.innerHTML = [
    item(h1 === p.entry.hash, `The reading hashes to <span class="mono">${h1.slice(0, 16)}…</span>`),
    item(h === p.block.header.merkleRoot, `Its Merkle path (${p.merkleProof.length} steps) reaches the root of block #${p.block.header.index}`),
    item(h3 === p.block.hash, `The block header hashes to <span class="mono">${h3.slice(0, 16)}…</span>, which the next blocks point to`),
    item(j.verification.ok, `Signed by an authority of the network (${esc(j.verification.reason)})`),
    `<li class="pequeno">${p.confirmations} block(s) sealed after it</li>`,
  ].join('');
  $('baixar').href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button.verificar');
  if (b && !b.disabled) verificar(b.dataset.hash);
  const c = e.target.closest('.chip');
  if (c) { escolhido = c.dataset.i; carregarInstrumentos(); }
});

const io = window.io();
io.on('reading', (r) => { leituras.set(r.hash, r); desenharTabela(r.hash); carregarInstrumentos(); });
io.on('anchored', (a) => {
  const r = leituras.get(a.hash);
  if (r) { Object.assign(r, { state: 'anchored', block: a.block, blockHash: a.blockHash }); desenharTabela(); desenharGrafico(); }
});
io.on('pending', (a) => { const r = leituras.get(a.hash); if (r && r.state === 'queued') { r.state = 'pending'; desenharTabela(); } });
io.on('status', () => fetch('/api/status').then((r) => r.json()).then(estado));
carregar();
