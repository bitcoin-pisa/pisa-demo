// The stage: two wallets and the transaction they build between them.
//
// The server narrates every step of a payment as an event. Events are played
// one at a time, so each message gets to fly before the next one lands, and
// anything that happened before this page loaded is applied without motion.

const $ = (sel, root = document) => root.querySelector(sel);
const loadedAt = Date.now();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// State

const fresh = () => ({
  alice: { screen: 'home', invoice: null, pasting: false, steps: {}, error: null, amount: 0, txid: null, summary: null },
  bob: { screen: 'home', amount: 50000, invoice: null, steps: {}, error: null, negotiating: false, coin: null, output: null },
  tx: null,
});

let ui = fresh();
let server = null; // the last /api/state
let lastSeq = 0;
// False while replaying events from before this page loaded: those land in
// their final state at once, without any of the motion.
let moving = true;

// What a wallet shows while a payjoin is under way: one line, the way a real
// wallet would. The protocol itself is in the lane between the phones.
function aliceStatus(steps) {
  if (steps['alice.aggregated']) return 'Sending';
  if (steps['alice.proposal']) return 'Finishing transaction';
  if (steps['alice.original_sent']) return 'Waiting for Bob';
  return 'Preparing transaction';
}

function bobStatus(steps) {
  return steps['bob.proposal_sent'] ? 'Waiting for Alice' : 'Payjoin in progress';
}

// How long the end of a payment lingers, in ms. Finalizing, broadcasting
// and landing in the mempool follow each other within a second on regtest;
// a viewer needs a moment for each.
const LINGER = {
  ownPartial: 1300,    // Alice's partial signature, before the two merge
  merge: 1400,         // the two partial signatures flying into one
  nonce: 2600,         // Alice's fallback signature and nonce, before she sends
  contributed: 2600,   // Bob's coin in the transaction
  partialSigned: 2600, // Bob's partial signature
  aggregated: 4200,    // the finished transaction, before it is broadcast
  broadcast: 1800,     // the flight to the network
  inMempool: 1600,     // in the mempool, before Alice's phone says sent
  received: 1800,      // before Bob's phone says received
};

// ---------------------------------------------------------------------------
// Formatting

const fmtInt = (n) => Math.abs(n).toLocaleString('en-US');
const sats = (n) => `${fmtInt(n)} sats`;
const btc = (sat) => (sat / 1e8).toFixed(8);
const signedSats = (n) => `${n < 0 ? '−' : '+'}${fmtInt(n)}`;

// 0.03449648 with the leading zeros dimmed, the way a wallet shows it.
function btcParts(sat) {
  const s = btc(sat);
  const m = s.match(/^(0\.0*)(.*)$/);
  if (!m || sat === 0) return { lead: s, rest: '' };
  return { lead: m[1], rest: m[2] };
}

const shortAddr = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-6)}` : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CHECK_BIG = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Server

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${path} failed`);
  return json;
}

async function refresh() {
  try {
    server = await api('/api/state');
  } catch {
    return;
  }
  $('#height').textContent = `Regtest, block ${server.height}`;
  $('#explorer').href = server.explorer;
  renderPhone('alice');
  renderPhone('bob');
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------------------
// Phones

const lastScreen = { alice: null, bob: null };
const lastHtml = { alice: '', bob: '' };
// Screens with a text field are left alone by the periodic refresh, so that
// typing is never interrupted.
const STICKY = new Set(['amount', 'scan']);

function renderPhone(who, force = false) {
  const st = ui[who];
  const changed = lastScreen[who] !== st.screen;
  if (!changed && !force && STICKY.has(st.screen)) return;
  const html = statusbar() + (who === 'alice' ? aliceView(st) : bobView(st));
  if (!changed && html === lastHtml[who]) return;
  const root = $(`#${who}`);
  root.innerHTML = html;
  if (changed) root.querySelector('.view')?.classList.add('enter');
  lastScreen[who] = st.screen;
  lastHtml[who] = html;
  bindPhone(who, root);
}

function statusbar() {
  return '<div class="statusbar"><span>9:41</span><span class="net">regtest</span></div>';
}

function wallet(who) {
  return server?.wallets?.[who] ?? { confirmed_sat: 0, pending_sat: 0, txs: [] };
}

function homeView(who, name, action) {
  const w = wallet(who);
  // What a wallet shows: everything it holds, and what is still unconfirmed
  // as the net effect of those transactions. Core's own split would show
  // Bob's contributed coin as gone and the payjoin's output as pending.
  const { lead, rest } = btcParts(w.confirmed_sat + w.pending_sat);
  const unconfirmed = w.txs.filter((t) => t.confirmations === 0).reduce((sum, t) => sum + t.net_sat, 0);
  const pending = unconfirmed ? `${signedSats(unconfirmed)} sats pending` : '';
  const other = who === 'alice' ? 'Bob' : 'Alice';
  const rows = w.txs.map((t) => {
    const out = t.net_sat < 0;
    const what = t.payjoin ? (out ? `Paid ${other}` : `From ${other}`) : (out ? 'Sent' : 'Received');
    const tag = t.payjoin ? '<span class="tag">Payjoin</span>' : '';
    const when = t.confirmations > 0 ? '' : '<span class="sub">Pending</span>';
    return `<li><span class="what">${what}${tag}</span><span class="amt ${out ? '' : 'in'}">${signedSats(t.net_sat)}<span class="u"> sats</span></span>${when}</li>`;
  }).join('');
  return `<div class="view">
    <div class="who"><div class="avatar">${name[0]}</div><div class="who-name">${name}</div></div>
    <div class="balance-label">Balance</div>
    <div class="balance"><span class="lead">${lead}</span>${rest}<span class="unit">BTC</span></div>
    <div class="pending">${pending}</div>
    <div class="actions">${action}</div>
    <div class="section-title">Activity</div>
    ${rows ? `<ul class="activity">${rows}</ul>` : '<div class="empty">No transactions yet</div>'}
  </div>`;
}

function statusLine(text) {
  return `<div class="status-line"><span class="spinner"></span><span>${text}</span></div>`;
}

function aliceView(st) {
  switch (st.screen) {
    case 'scan': {
      const shot = st.invoice
        ? `<div class="shot">${st.invoice.qr_svg}</div><div class="scanline"></div>`
        : '';
      const paste = st.pasting
        ? `<form class="paste" data-act="paste"><input name="uri" placeholder="bitcoin:bcrt1z…?pj=…" autocomplete="off" spellcheck="false"><button class="btn primary" type="submit">Use</button></form>`
        : '<button class="link" data-act="show-paste" type="button">Paste</button>';
      return `<div class="view">
        <div class="head"><h2>Scan</h2><button class="link" data-act="home" type="button">Cancel</button></div>
        <div class="camera">
          <div class="finder">${shot}</div>
          ${st.invoice ? '' : '<button class="btn primary" data-act="scan" type="button">Scan</button>'}
          ${st.invoice ? '' : paste}
        </div>
      </div>`;
    }
    case 'review': {
      const inv = st.invoice;
      return `<div class="view">
        <div class="head"><h2>Pay Bob</h2><button class="link" data-act="home" type="button">Cancel</button></div>
        <p class="pay-amount">${sats(inv.amount_sat)}</p>
        <p class="attempt">Attempting payjoin</p>
        <button class="btn primary block gap" data-act="send" type="button">Send</button>
      </div>`;
    }
    case 'progress': {
      const error = st.error ? `<div class="error-box">${esc(st.error)}</div>` : '';
      return `<div class="view">
        <div class="head"><h2>Paying Bob</h2>${st.error ? '<button class="link" data-act="home" type="button">Close</button>' : ''}</div>
        <p class="pay-amount">${sats(st.amount)}</p>
        ${st.error ? error : statusLine(aliceStatus(st.steps))}
      </div>`;
    }
    case 'done': {
      const sm = st.summary;
      const confirmed = ui.tx?.confirmedIn;
      return `<div class="view done-view">
        <div class="seal">${CHECK_BIG}</div>
        <p class="done-title">Sent</p>
        <div class="done-sub">${sats(st.amount)} to Bob</div>
        ${sm ? `<div class="sig-chip">${sm.signatures} signature, ${sm.inputs.length} inputs</div>` : ''}
        <div class="confirm-state ${confirmed ? 'yes' : ''}"><span class="dot"></span>${confirmed ? `Block ${confirmed}` : 'In mempool'}</div>
        <div class="done-actions">
          <a class="btn primary block" href="${esc(explorerUrl(st.txid, sm))}" target="_blank" rel="noopener">View in mempool</a>
          <button class="btn soft block" data-act="home" type="button">Done</button>
        </div>
      </div>`;
    }
    default:
      return homeView('alice', 'Alice', '<button class="btn primary" data-act="to-scan" type="button">Send</button>');
  }
}

function bobView(st) {
  switch (st.screen) {
    case 'amount': {
      const presets = [25000, 50000, 100000].map((n) =>
        `<button class="preset" data-act="preset" data-n="${n}" aria-pressed="${n === st.amount}" type="button">${fmtInt(n)}</button>`).join('');
      return `<div class="view">
        <div class="head"><h2>Request</h2><button class="link" data-act="home" type="button">Cancel</button></div>
        <label class="amount-field"><input id="bob-amount" inputmode="numeric" value="${st.amount}" aria-label="Amount in sats"><span>sats</span></label>
        <div class="presets">${presets}</div>
        <button class="btn primary block gap" data-act="request" type="button">Create request</button>
      </div>`;
    }
    case 'request': {
      const inv = st.invoice;
      if (!inv) return '<div class="view"></div>';
      const waiting = st.negotiating ? '' : '<div class="listening"><span class="pulse"></span>Pending transaction</div>';
      return `<div class="view ${st.negotiating ? 'compact' : ''}">
        <div class="head"><h2>${st.negotiating ? 'Receiving' : 'Request'}</h2>${st.negotiating && !st.error ? '' : '<button class="link" data-act="home" type="button">Close</button>'}</div>
        <div class="request-row">
          <div class="qr-card">${inv.qr_svg ?? ''}</div>
          <div class="request-meta">
            <div class="request-amount">${sats(inv.amount_sat)}</div>
          </div>
        </div>
        ${waiting}
        ${st.negotiating && !st.error ? statusLine(bobStatus(st.steps)) : ''}
        ${st.error ? `<div class="error-box">${esc(st.error)}</div>` : ''}
      </div>`;
    }
    case 'done': {
      const confirmed = ui.tx?.confirmedIn;
      return `<div class="view done-view">
        <div class="seal">${CHECK_BIG}</div>
        <p class="done-title">Received</p>
        <div class="done-sub">${sats(st.invoice?.amount_sat ?? 0)} from Alice</div>
        <div class="confirm-state ${confirmed ? 'yes' : ''}"><span class="dot"></span>${confirmed ? `Block ${confirmed}` : 'In mempool'}</div>
        <div class="spacer"></div>
        <button class="btn soft block" data-act="home" type="button">Done</button>
      </div>`;
    }
    default:
      return homeView('bob', 'Bob', '<button class="btn primary" data-act="to-amount" type="button">Receive</button>');
  }
}

function bindPhone(who, root) {
  root.onclick = async (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.tagName === 'FORM') return;
    const act = el.dataset.act;
    const st = ui[who];
    try {
      if (act === 'home') { st.screen = 'home'; st.error = null; }
      if (act === 'to-scan') { Object.assign(st, { screen: 'scan', invoice: null, pasting: false }); }
      if (act === 'to-amount') { st.screen = 'amount'; }
      if (act === 'show-paste') { st.pasting = true; renderPhone(who, true); $('.paste input', root)?.focus(); return; }
      if (act === 'scan') { await scanBob(); return; }
      if (act === 'send') { el.disabled = true; await api('/api/alice/pay', { uri: st.invoice.uri }); return; }
      if (act === 'preset') { st.amount = Number(el.dataset.n); renderPhone(who, true); return; }
      if (act === 'request') {
        const n = Number(String($('#bob-amount', root).value).replace(/[^0-9]/g, ''));
        if (!n) { toast('Enter an amount in sats'); return; }
        st.amount = n;
        el.disabled = true;
        const { invoice } = await api('/api/bob/invoice', { amount_sat: n });
        Object.assign(st, { invoice, screen: 'request', steps: {}, negotiating: false, error: null });
      }
    } catch (e) {
      toast(e.message);
      el.disabled = false;
    }
    renderPhone(who);
  };
  root.onsubmit = async (ev) => {
    ev.preventDefault();
    const uri = new FormData(ev.target).get('uri');
    if (!uri) return;
    useInvoice({ uri, ...parseUri(uri), qr_svg: null });
  };
  const amount = $('#bob-amount', root);
  if (amount) amount.oninput = () => { ui.bob.amount = Number(amount.value.replace(/[^0-9]/g, '')) || 0; };
}

function parseUri(uri) {
  const m = uri.match(/^bitcoin:([^?]+)\??(.*)$/i);
  const params = new URLSearchParams(m?.[2] ?? '');
  return { address: m?.[1] ?? '', amount_sat: Math.round(Number(params.get('amount') ?? 0) * 1e8) };
}

async function scanBob() {
  const { invoice } = await api('/api/invoice');
  if (!invoice || invoice.status !== 'waiting') {
    toast('Bob has no open request. Create one on his phone first.');
    return;
  }
  ui.alice.invoice = invoice;
  renderPhone('alice', true);
  await sleep(reducedMotion ? 0 : 1300);
  useInvoice(invoice);
}

function useInvoice(invoice) {
  if (!invoice.amount_sat) { toast('That link has no amount'); return; }
  Object.assign(ui.alice, { invoice, screen: 'review' });
  renderPhone('alice');
}

// ---------------------------------------------------------------------------
// The lane: the transaction under construction

function laneIntro() {
  return `<div class="intro">
    <h1><span class="who-alice">Alice</span> pays <span class="who-bob">Bob</span></h1>
    <p>with a PISA Enabled Transaction</p>
  </div>`;
}

function renderLane() {
  const root = $('#tx');
  const tx = ui.tx;
  if (!tx) {
    if (!root.querySelector('.intro')) root.innerHTML = laneIntro();
    return;
  }
  let card = root.querySelector('.card');
  if (!card) {
    root.innerHTML = `<div class="card">
      <div class="card-head"><span class="card-title">Transaction</span><span class="status"></span></div>
      <div class="rows-label">Inputs</div><div class="rows" data-part="in"></div>
      <div class="rows-label">Outputs</div><div class="rows" data-part="out"></div>
      <div class="foot"></div>
    </div>`;
    card = root.querySelector('.card');
  }
  const status = card.querySelector('.status');
  status.textContent = tx.status;
  status.className = `status ${tx.confirmedIn ? 'confirmed' : tx.txid ? 'mempool' : ''}`;

  const inputs = tx.summary ? finalInputs(tx.summary) : psbtInputs(tx.psbt);
  const outputs = (tx.summary?.outputs ?? tx.psbt?.outputs ?? []).map((o, i) => ({
    key: `o${i}-${o.owner}`, owner: o.owner, value: o.value_sat, chips: [],
  }));
  syncRows(card.querySelector('[data-part="in"]'), inputs);
  syncRows(card.querySelector('[data-part="out"]'), outputs);

  const foot = card.querySelector('.foot');
  const footHtml = tx.summary ? statsHtml(tx) : '';
  if (foot.dataset.html !== footHtml) {
    foot.innerHTML = footHtml;
    foot.dataset.html = footHtml;
  }
}

function psbtInputs(psbt) {
  return (psbt?.inputs ?? []).map((input, i) => {
    const chips = [];
    if (input.fallback_sig) chips.push(['sig', 'sig-plain', 'fallback signature']);
    if (input.pubnonce) chips.push(['nonce', 'nonce', 'nonce']);
    if (input.partial_sig) chips.push(['partial', 'partial', 'partial sig']);
    return { key: `i${input.owner}-${input.value_sat}`, owner: input.owner, value: input.value_sat, chips, index: i };
  });
}

function finalInputs(summary) {
  return summary.inputs.map((input) => {
    const chips = input.role === 'aggregated'
      ? [['empty', 'empty', 'empty (covered by aggregate)']]
      : input.role === 'aggregate'
        ? [['aggregate', 'aggregate', 'aggregate signature']]
        : [['sig', 'sig-plain', 'signature']];
    return { key: `i${input.owner}-${input.value_sat}`, owner: input.owner, value: input.value_sat, chips };
  });
}

// The explorer's transaction page, inputs expanded, with who is who.
function explorerUrl(txid, summary) {
  const base = `${server?.explorer ?? ''}/tx/${txid}?showDetails=true`;
  return summary?.pj_fragment ? `${base}#${summary.pj_fragment}` : base;
}

const OWNER = { alice: 'Alice', bob: 'Bob', other: 'Other' };

// Keep rows and chips that are still there, so only what changed moves.
function syncRows(container, rows) {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  rows.forEach((row, i) => {
    let el = existing.get(row.key);
    if (!el) {
      el = document.createElement('div');
      el.className = `row ${row.owner}`;
      el.dataset.key = row.key;
      el.innerHTML = `<span class="bar-owner"></span><span class="owner">${OWNER[row.owner] ?? row.owner}</span><span class="chips"></span><span class="value"></span>`;
    }
    existing.delete(row.key);
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null);
    const value = row.value == null ? '' : btc(row.value);
    const v = el.querySelector('.value');
    if (v.textContent !== value) {
      if (v.textContent && moving && !reducedMotion) v.animate([{ color: 'var(--sig-ink)', background: 'var(--sig-tint)' }, {}], { duration: 1400 });
      v.textContent = value;
    }
    syncChips(el.querySelector('.chips'), row.chips);
  });
  existing.forEach((el) => el.remove());
}

function syncChips(container, chips) {
  const wanted = new Set(chips.map(([key]) => key));
  const leaving = [...container.children].filter((el) => !wanted.has(el.dataset.key) && !el.classList.contains('gone'));
  // A chip on its way out keeps its place but no longer takes up room, so
  // the ones coming in never push the row onto a second line. Measure them
  // all before any of them leaves the flow.
  const spots = leaving.map((el) => [el, el.offsetLeft, el.offsetTop]);
  spots.forEach(([el, left, top]) => {
    if (!moving) { el.remove(); return; }
    Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
    el.classList.add('gone');
    setTimeout(() => el.remove(), 500);
  });
  for (const [key, cls, label] of chips) {
    if (container.querySelector(`[data-key="${key}"]:not(.gone)`)) continue;
    const el = document.createElement('span');
    el.className = `chip ${cls}`;
    el.dataset.key = key;
    el.innerHTML = label;
    container.appendChild(el);
  }
}

function statsHtml(tx) {
  const sm = tx.summary;
  const saved = sm.vsize_without_cisa - sm.vsize;
  // From weight, the way the explorer computes it, so the two agree.
  const pct = (((sm.weight_without_cisa - sm.weight) / sm.weight_without_cisa) * 100).toFixed(1);
  return `<div class="stats">
      <div><div class="stat-n">${sm.signatures} sig</div><div class="stat-l">${sm.inputs.length} inputs</div></div>
      <div><div class="stat-n">${sm.vsize} vB</div><div class="stat-l">not ${sm.vsize_without_cisa}</div></div>
      <div><div class="stat-n good">−${pct}%</div><div class="stat-l">−${saved} vB</div></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Wires and flying messages

function rect(el) { return el.getBoundingClientRect(); }

function layoutWires() {
  const wires = $('#wires');
  const a = rect($('[data-who="alice"] .phone'));
  const b = rect($('[data-who="bob"] .phone'));
  const d = rect($('#directory'));
  const n = rect($('#network'));
  const line = (x1, x2, y) => `<div class="wire" style="left:${x1}px;top:${y}px;width:${Math.max(0, x2 - x1)}px"></div>`;
  const dy = d.top + d.height / 2;
  const ny = n.top + n.height / 2;
  wires.innerHTML = line(a.right, d.left, dy) + line(d.right, b.left, dy) + line(a.right, n.left, ny) + line(n.right, b.left, ny);
}

async function fly(from, to, label, who, { gold = true, duration = 1150 } = {}) {
  if (reducedMotion) return;
  const el = document.createElement('div');
  el.className = `flyer ${who}`;
  el.innerHTML = `<span class="stripe"></span>${label}${gold ? '<span class="gold"></span>' : ''}`;
  $('#flyers').appendChild(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const point = (r, side, y) => ({ x: side === 'left' ? r.left : side === 'right' ? r.right : r.left + r.width / 2, y });
  const fr = rect(from);
  const tr = rect(to);
  const y = (to.classList.contains('node') ? tr.top + tr.height / 2 : fr.top + fr.height / 2);
  const leftToRight = fr.left < tr.left;
  const start = point(fr, leftToRight ? 'right' : 'left', y);
  const end = point(tr, leftToRight ? 'left' : 'right', y);
  const at = (p, s = 1) => `translate(${p.x - w / 2}px, ${p.y - h / 2}px) scale(${s})`;
  await el.animate(
    [
      { transform: at(start, .6), opacity: 0 },
      { transform: at(start), opacity: 1, offset: .12 },
      { transform: at(end), opacity: 1, offset: .88 },
      { transform: at(end, .6), opacity: 0 },
    ],
    { duration, easing: 'cubic-bezier(.45,.05,.25,1)' },
  ).finished;
  el.remove();
}

// Every partial signature flies onto the input that will carry the one
// signature for the group.
async function mergeSignatures(targetIndex) {
  if (reducedMotion) return;
  const card = $('#tx .card');
  const partials = [...card.querySelectorAll('.chip.partial:not(.gone)')];
  const target = card.querySelectorAll('[data-part="in"] .row')[targetIndex]?.querySelector('.chips');
  if (!target || !partials.length) return;
  const tr = rect(target);
  const flights = partials.map((chip) => {
    const r = rect(chip);
    const el = document.createElement('div');
    el.className = 'flyer sig-merge';
    el.textContent = 'partial sig';
    $('#flyers').appendChild(el);
    chip.style.visibility = 'hidden';
    const from = `translate(${r.left}px, ${r.top}px)`;
    const to = `translate(${tr.left}px, ${tr.top + (tr.height - r.height) / 2}px)`;
    return el.animate([{ transform: from }, { transform: to, opacity: 1 }, { transform: `${to} scale(1.15)`, opacity: 0 }],
      { duration: LINGER.merge, easing: 'cubic-bezier(.5,0,.2,1)' }).finished.then(() => el.remove());
  });
  await Promise.all(flights);
}

// ---------------------------------------------------------------------------
// Events

const queue = [];
let playing = false;
// Every step this page has shown since it loaded. scripts/record.mjs waits on
// it to put its captions next to what they describe.
window.__seen = new Set();

/** Show the current state, mark the step as shown, and hold it a while. */
async function linger(kind, ms) {
  renderPhone('alice'); renderPhone('bob'); renderLane();
  window.__seen.add(kind);
  await sleep(ms);
}

function enqueue(event) {
  if (event.seq <= lastSeq) return;
  lastSeq = event.seq;
  queue.push(event);
  if (!playing) play();
}

async function play() {
  playing = true;
  while (queue.length) {
    const event = queue.shift();
    const live = event.at_ms >= loadedAt - 250;
    moving = live;
    document.body.classList.toggle('replaying', !live);
    try {
      await apply(event, live);
    } catch (e) {
      console.error(e);
    }
    renderPhone('alice');
    renderPhone('bob');
    renderLane();
    if (live) window.__seen.add(event.kind);
    if (live) await sleep(250);
  }
  moving = true;
  document.body.classList.remove('replaying');
  playing = false;
}

function step(who, kind, event, extra = {}) {
  ui[who].steps[kind] = { detail: event.detail, ...extra };
}

async function apply(e, live) {
  const d = e.data ?? {};
  const A = ui.alice;
  const B = ui.bob;
  switch (e.kind) {
    case 'system.reset':
      ui = fresh();
      $('#tx').innerHTML = '';
      $('#directory').classList.remove('holding');
      $('#network').classList.remove('lit');
      break;

    case 'bob.invoice': {
      const inv = server?.invoice?.uri === d.uri ? server.invoice : (await api('/api/invoice')).invoice;
      Object.assign(B, { invoice: inv ?? d, screen: 'request', steps: {}, negotiating: false, error: null, coin: null, output: null });
      break;
    }

    case 'alice.start':
      Object.assign(A, { screen: 'progress', steps: {}, error: null, amount: d.amount_sat, txid: null, summary: null });
      ui.tx = { status: 'Alice', psbt: null, summary: null, txid: null, confirmedIn: null };
      $('#network').classList.remove('lit');
      break;
    case 'alice.fallback':
      step('alice', e.kind, e);
      ui.tx.psbt = d.psbt;
      break;
    case 'alice.nonce':
      step('alice', e.kind, e);
      ui.tx.psbt = d.psbt;
      if (live) await linger(e.kind, LINGER.nonce);
      break;
    case 'alice.original_sent':
      step('alice', e.kind, e);
      ui.tx.psbt = d.psbt ?? ui.tx.psbt;
      ui.tx.status = 'To Bob';
      renderPhone('alice'); renderLane();
      if (live) await fly($('[data-who="alice"] .phone'), $('#directory'), 'PSBT', 'alice');
      $('#directory').classList.add('holding');
      break;
    case 'directory.to_bob':
      if (live) await fly($('#directory'), $('[data-who="bob"] .phone'), 'PSBT', 'alice');
      $('#directory').classList.remove('holding');
      break;

    case 'bob.original_received':
      B.negotiating = true;
      B.screen = 'request';
      step('bob', e.kind, e);
      if (ui.tx) ui.tx.status = 'Bob';
      break;
    case 'bob.checks':
      step('bob', e.kind, e);
      break;
    case 'bob.contributed': {
      step('bob', e.kind, e);
      if (ui.tx) { ui.tx.psbt = d.psbt; ui.tx.status = 'Bob adds a coin'; }
      const mine = d.psbt?.inputs?.find((i) => i.owner === 'bob');
      B.coin = mine?.value_sat ?? null;
      if (live) await linger(e.kind, LINGER.contributed);
      break;
    }
    case 'bob.partial_signed':
      step('bob', e.kind, e);
      if (ui.tx) { ui.tx.psbt = d.psbt; ui.tx.status = 'Bob signs'; }
      if (live) await linger(e.kind, LINGER.partialSigned);
      break;
    case 'bob.proposal_sent':
      step('bob', e.kind, e);
      if (ui.tx) { ui.tx.psbt = d.psbt; ui.tx.status = 'To Alice'; }
      B.output = d.psbt?.outputs?.find((o) => o.owner === 'bob')?.value_sat ?? null;
      renderPhone('bob'); renderLane();
      if (live) await fly($('[data-who="bob"] .phone'), $('#directory'), 'Proposal', 'bob');
      $('#directory').classList.add('holding');
      break;
    case 'directory.to_alice':
      if (live) await fly($('#directory'), $('[data-who="alice"] .phone'), 'Proposal', 'bob');
      $('#directory').classList.remove('holding');
      break;

    case 'alice.proposal':
      step('alice', e.kind, e);
      if (ui.tx) { ui.tx.psbt = d.psbt; ui.tx.status = 'Alice signs'; }
      break;
    case 'alice.aggregated': {
      if (ui.tx && live) {
        // Alice's own partial signature, for the moment before they merge.
        ui.tx.psbt = { ...ui.tx.psbt, inputs: ui.tx.psbt.inputs.map((i) => ({ ...i, partial_sig: i.partial_sig || i.owner === 'alice' })) };
        renderLane();
        await sleep(LINGER.ownPartial);
        await mergeSignatures(d.inputs.findIndex((i) => i.role === 'aggregate'));
      }
      step('alice', e.kind, e);
      A.summary = d;
      if (ui.tx) { ui.tx.summary = d; ui.tx.status = '1 signature'; }
      if (live) await linger(e.kind, LINGER.aggregated);
      break;
    }
    case 'alice.broadcast':
      step('alice', e.kind, e);
      Object.assign(A, { txid: d.txid, summary: d.summary });
      if (ui.tx) { ui.tx.txid = d.txid; ui.tx.status = 'Broadcasting'; }
      renderPhone('alice'); renderLane();
      if (live) await fly($('[data-who="alice"] .phone'), $('#network'), 'Transaction', 'alice', { gold: false, duration: LINGER.broadcast });
      if (ui.tx) ui.tx.status = 'In mempool';
      $('#network').classList.add('lit');
      if (live) await linger('in_mempool', LINGER.inMempool);
      A.screen = 'done';
      break;

    case 'bob.paid':
      step('bob', e.kind, e);
      if (live) await sleep(LINGER.received);
      B.screen = 'done';
      break;

    case 'chain.block': {
      $('#height').textContent = `Regtest, block ${d.height}`;
      if (ui.tx?.txid && (d.confirmed_payjoins ?? []).includes(ui.tx.txid)) {
        ui.tx.confirmedIn = d.height;
        ui.tx.status = `Block ${d.height}`;
      }
      if (live) toast(e.title);
      refresh();
      break;
    }

    case 'alice.error': {
      A.error = e.detail;
      if (A.screen !== 'progress') A.screen = 'progress';
      break;
    }
    case 'bob.error': {
      B.error = e.detail;
      break;
    }
    default:
      break;
  }
  if (live && e.actor !== 'system' && e.actor !== 'directory') refresh();
}

function connect() {
  const source = new EventSource('/api/events');
  source.onmessage = (msg) => {
    try { enqueue(JSON.parse(msg.data)); } catch (e) { console.error(e); }
  };
  source.onerror = () => {
    // EventSource reconnects by itself; the history it replays is dropped
    // by sequence number.
  };
}

// ---------------------------------------------------------------------------
// Controls

$('#mine').onclick = () => api('/api/mine', { blocks: 1 }).catch((e) => toast(e.message));
$('#reset').onclick = () => api('/api/reset', {}).catch((e) => toast(e.message));

document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, textarea') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'm') $('#mine').click();
  if (ev.key === 'R') $('#reset').click();
});

addEventListener('resize', layoutWires);

(async function start() {
  await document.fonts.ready;
  await refresh();
  renderLane();
  layoutWires();
  connect();
  setInterval(refresh, 2000);
})();
