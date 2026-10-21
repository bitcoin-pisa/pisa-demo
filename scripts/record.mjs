#!/usr/bin/env node
// Record one take of the demo as an MP4, without touching the screen.
//
// A headless Chrome with its own throwaway profile plays the take: Bob asks
// for a payment, Alice scans and pays, a block is mined, and the explorer
// shows the transaction. A drawn cursor moves to each button before it is
// pressed.
//
// The page is captured at twice its CSS resolution, and a camera that
// follows the action is applied afterwards: the take logs where to look and
// how close, and ffmpeg's zoompan turns that into eased zooms and pans. Close
// ups stay sharp because they are crops of the larger frames, and the text
// that matters fills the frame on a phone screen.
//
//   node scripts/record.mjs [out.mp4]
//
// The demo has to be running (scripts/demo.sh start), ideally on a fresh
// chain so the wallets' activity lists are short.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEMO = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] ?? path.join(DEMO, 'docs', 'pisa-demo.mp4'));
const WORK = path.join(DEMO, '.data', 'recording');
const FRAMES = path.join(WORK, 'frames');
const WALLETS = process.env.WALLETS_URL ?? 'http://localhost:3000';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9333);
// The page's size in CSS pixels, and how many frame pixels each one gets.
const W = 1280;
const H = 720;
const DPR = 2;
const FPS = 30;
const OUT_SIZE = '1920x1080';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Chrome and the DevTools protocol

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(WORK, 'profile')}`,
  `--window-size=${W},${H}`,
  // The screencast ignores an emulated device scale factor; only this makes
  // its frames twice the page's CSS size.
  `--force-device-scale-factor=${DPR}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

async function pageSocketUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chrome did not start');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws.onmessage = (msg) => {
      const m = JSON.parse(msg.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} ${m.error.data ?? ''}`)) : resolve(m.result);
      } else if (m.method) {
        (this.handlers.get(m.method) ?? []).forEach((h) => h(m.params));
      }
    };
  }
  open() { return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, handler) { this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]); }
  once(method) { return new Promise((resolve) => { const h = (p) => { this.handlers.set(method, this.handlers.get(method).filter((x) => x !== h)); resolve(p); }; this.on(method, h); }); }
}

const cdp = new Cdp(await pageSocketUrl());
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function waitFor(expression, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

// ---------------------------------------------------------------------------
// Frames
//
// The screencast sends a frame whenever the page repaints; a tiny element
// that never stops animating keeps it repainting. Frames are timed by when
// they arrive here, because the screencast's own timestamps come from the
// page's renderer, and a navigation to another origin moves the page to a
// renderer whose clock does not continue the first one's. While a page
// loads, frames are dropped and the gap is cut out.

const frames = [];
let recording = false;
let skipped = 0;
let lastRaw = null;
let cutPending = false;

cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  const t = Date.now() / 1000;
  if (!recording) return;
  if (cutPending && lastRaw !== null) {
    skipped += t - lastRaw - 1 / FPS;
    cutPending = false;
  }
  lastRaw = t;
  const file = path.join(FRAMES, `${String(frames.length).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: t - skipped });
});

function pause() { recording = false; cutPending = true; }
function resume() { recording = true; }

/** The take's clock, with the cut gaps taken out; frames use the same one. */
function takeTime() {
  return Date.now() / 1000 - skipped;
}

// ---------------------------------------------------------------------------
// The camera
//
// A keyframe says where the camera should be looking, in the page's CSS
// pixels, how close, and how long the move there takes. ffmpeg interpolates
// between them with an ease in and out.

// Times are on the take's clock until the encoder knows when the first frame
// came, and turns them into seconds into the video.
const camera = [{ t: -Infinity, z: 1, cx: W / 2, cy: H / 2, d: 0 }];
/** What the camera shows, in CSS pixels; captions stay inside it. */
let view = { left: 0, top: 0, right: W, bottom: H };

function look(cx, cy, z, d) {
  z = Math.min(Math.max(z, 1), 2.6);
  // Never look past the page's edge.
  const hw = W / z / 2;
  const hh = H / z / 2;
  cx = Math.min(Math.max(cx, hw), W - hw);
  cy = Math.min(Math.max(cy, hh), H - hh);
  camera.push({ t: takeTime(), z, cx, cy, d });
  view = { left: cx - hw, top: cy - hh, right: cx + hw, bottom: cy + hh };
  return evaluate(`document.documentElement.style.setProperty('--rec-zoom', ${z})`).catch(() => {});
}

/** Frame a rectangle with some room around it. */
function frame(rect, { pad = 28, maxZoom = 2.4, d = 1.1 } = {}) {
  const z = Math.min(W / (rect.width + 2 * pad), H / (rect.height + 2 * pad), maxZoom);
  return look(rect.left + rect.width / 2, rect.top + rect.height / 2, z, d);
}

function wide(d = 1.1) {
  return look(W / 2, H / 2, 1, d);
}

/** The union of the boxes of whatever the expressions find. */
async function box(...expressions) {
  const r = await evaluate(`(() => {
    const els = [${expressions.join(',')}].flat().filter(Boolean);
    if (!els.length) return null;
    const rs = els.map((e) => e.getBoundingClientRect());
    const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top));
    const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  })()`);
  if (!r) throw new Error(`nothing to frame for ${expressions.join(', ')}`);
  return r;
}

const $ = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

// The part of a phone where its screens keep everything that matters.
async function phoneTop(who, share = 0.7) {
  const r = await box($(`[data-who="${who}"] .phone`));
  return { left: r.left, top: r.top, width: r.width, height: r.height * share };
}

// ---------------------------------------------------------------------------
// The cursor, the ring, and the ticker, put into every page the take visits.
// Their sizes are divided by the camera's zoom so they look the same however
// close the camera is.

const STAGEHANDS = `(() => {
  if (document.getElementById('rec-cursor')) return true;
  const style = document.createElement('style');
  style.textContent = \`
    :root { --rec-zoom: 1; }
    #rec-cursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px; z-index: 2147483647; pointer-events: none;
      transform: translate(${W * 0.5}px, ${H * 0.62}px); transition: transform .75s cubic-bezier(.45,.05,.25,1); }
    #rec-cursor svg { filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); transition: transform .12s; transform-origin: 4px 3px;
      transform: scale(calc(1.15 / var(--rec-zoom))); }
    #rec-cursor.press svg { transform: scale(calc(.95 / var(--rec-zoom))); }
    .rec-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px; margin: -22px 0 0 -22px;
      border-radius: 50%; border: 3px solid rgba(233,168,0,.9); animation: rec-ripple .55s ease-out forwards; }
    @keyframes rec-ripple { from { transform: scale(calc(.3 / var(--rec-zoom))); opacity: 1; } to { transform: scale(calc(1.3 / var(--rec-zoom))); opacity: 0; } }
    #rec-ticker { position: fixed; right: 0; bottom: 0; width: 2px; height: 2px; pointer-events: none; animation: rec-tick 1s linear infinite; }
    /* A paint, not a compositor animation: only a repaint makes the screencast send a frame. */
    @keyframes rec-tick { from { background-color: rgba(128, 128, 128, .02); } to { background-color: rgba(128, 128, 128, .04); } }
    #rec-spot { position: fixed; z-index: 2147483640; pointer-events: none; opacity: 0;
      border: 3px solid #e9a800; border-radius: 12px;
      box-shadow: 0 0 0 200vmax rgba(4, 7, 14, .62), 0 0 26px 4px rgba(233, 168, 0, .45);
      transition: left .6s cubic-bezier(.45,.05,.25,1), top .6s cubic-bezier(.45,.05,.25,1), width .6s cubic-bezier(.45,.05,.25,1), height .6s cubic-bezier(.45,.05,.25,1), opacity .45s; }
    #rec-spot.on { opacity: 1; }
    #rec-caption { position: fixed; z-index: 2147483641; pointer-events: none; max-width: 640px; padding: 14px 20px 14px 18px; border-radius: 12px;
      background: #ffffff; color: #14171f; border-left: 7px solid #e9a800; box-shadow: 0 22px 44px -14px rgba(0, 0, 0, .7);
      font: 600 26px/1.25 'Helvetica Neue', -apple-system, sans-serif; letter-spacing: -.01em; opacity: 0; transform: translateY(10px);
      transition: opacity .35s, transform .35s, left .6s cubic-bezier(.45,.05,.25,1), top .6s cubic-bezier(.45,.05,.25,1); }
    #rec-caption.on { opacity: 1; transform: none; }
    #rec-fade { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; background: #05080f; opacity: 0; transition: opacity .6s ease; }
    #rec-fade.on { opacity: 1; }
    #rec-fade.now { transition: none; }
    details[open] > :not(summary) { animation: rec-reveal .5s cubic-bezier(.2,.7,.2,1); }
    @keyframes rec-reveal { from { opacity: 0; transform: translateY(-8px); } }
    #rec-caption small { display: block; margin-top: 4px; font-weight: 400; font-size: 19px; color: #3a404d; }
  \`;
  document.head.appendChild(style);
  const cursor = document.createElement('div');
  cursor.id = 'rec-cursor';
  cursor.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.4 3 6.7 3.1-1.4-3-6.6 6.4-.4z" fill="#fff" stroke="#14171f" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  const ticker = document.createElement('div');
  ticker.id = 'rec-ticker';
  document.body.appendChild(ticker);
  const spot = document.createElement('div');
  spot.id = 'rec-spot';
  document.body.appendChild(spot);
  const caption = document.createElement('div');
  caption.id = 'rec-caption';
  document.body.appendChild(caption);
  const fade = document.createElement('div');
  fade.id = 'rec-fade';
  document.body.appendChild(fade);
  // Ring a part of the page, dim the rest, and say what it shows. The
  // caption goes below the ring, or above it, inside the camera's view.
  window.__spot = (r, text, note, view) => {
    const pad = 10;
    const box = { left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
    // The ring and its caption glide from one piece to the next; only when
    // they first appear do they start in place.
    const fresh = !spot.classList.contains('on');
    if (fresh) { spot.style.transition = 'none'; caption.style.transition = 'none'; }
    Object.assign(spot.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
    caption.innerHTML = text + (note ? '<small>' + note + '</small>' : '');
    const ch = caption.offsetHeight;
    const cw = caption.offsetWidth;
    const below = box.top + box.height + 16;
    const top = below + ch < view.bottom - 12 ? below : Math.max(view.top + 12, box.top - ch - 16);
    const left = Math.min(Math.max(view.left + 12, box.left), view.right - cw - 12);
    Object.assign(caption.style, { left: left + 'px', top: top + 'px' });
    if (fresh) { spot.offsetHeight; spot.style.transition = ''; caption.style.transition = ''; }
    spot.classList.add('on');
    caption.classList.add('on');
  };
  window.__unspot = () => { spot.classList.remove('on'); caption.classList.remove('on'); };
  return true;
})()`;

async function goto(url, ready, prepare = null) {
  pause();
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await waitFor(ready, 60000);
  await evaluate(STAGEHANDS);
  if (prepare) await evaluate(prepare);
  await sleep(500);
  resume();
}

// Move the drawn cursor onto an element, press, then click it for real.
async function click(selector, { follow = true } = {}) {
  const r = await box($(selector));
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  await evaluate(`document.getElementById('rec-cursor').style.transform = 'translate(${x - 4}px, ${y - 3}px)'`);
  await sleep(850);
  await evaluate(`(() => {
    const c = document.getElementById('rec-cursor');
    c.classList.add('press');
    const ripple = document.createElement('div');
    ripple.className = 'rec-ripple';
    ripple.style.left = '${x}px'; ripple.style.top = '${y}px';
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
    setTimeout(() => c.classList.remove('press'), 140);
  })()`);
  await sleep(160);
  if (follow) await evaluate(`${$(selector)}.click()`);
}

async function parkCursor(x, y) {
  await evaluate(`document.getElementById('rec-cursor').style.transform = 'translate(${x}px, ${y}px)'`);
}

/** Ring something, dim the rest, and caption it. */
async function spot(rect, text, note = '') {
  await evaluate(`window.__spot(${JSON.stringify(rect)}, ${JSON.stringify(text)}, ${JSON.stringify(note)}, ${JSON.stringify(view)})`);
}

async function fadeOut() {
  await evaluate(`document.getElementById('rec-fade').classList.add('on')`);
  await sleep(700);
}

async function fadeIn() {
  await evaluate(`document.getElementById('rec-fade').classList.remove('on')`);
  await sleep(700);
}

async function unspot() {
  await evaluate('window.__unspot()');
  await sleep(500);
}

const text = (expression) => evaluate(`(${expression})?.textContent?.trim() ?? ''`);

async function scrollTo(expression, offset, smooth = true) {
  await evaluate(`(() => {
    const el = ${expression};
    const y = el.getBoundingClientRect().top + window.scrollY - ${offset};
    window.scrollTo({ top: y, behavior: '${smooth ? 'smooth' : 'instant'}' });
  })()`);
  // Smooth scrolling takes as long as it takes; measure only once it is over.
  let last = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(120);
    const now = await evaluate('window.scrollY');
    if (now === last) break;
    last = now;
  }
}

const heading = (name) => `[...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === ${JSON.stringify(name)})`;
const doneSteps = (who) => `document.querySelectorAll('#${who} .steps li.done').length`;

// ---------------------------------------------------------------------------
// The take

await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W * DPR, maxHeight: H * DPR, everyNthFrame: 1 });

await fetch(`${WALLETS}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
await goto(WALLETS, `${$('#bob [data-act="to-amount"]')} && document.fonts.status === 'loaded'`);
await sleep(2800);

// Bob asks for 50,000 sats.
await frame(await phoneTop('bob'), { pad: 20 });
await sleep(1300);
await click('#bob [data-act="to-amount"]');
await sleep(1300);
await click('#bob [data-act="request"]');
await waitFor(`${$('#bob .qr-card svg')}`);
await sleep(2300);

// Alice scans his code and reviews the payment.
await frame(await phoneTop('alice'), { pad: 20 });
await sleep(1300);
await click('#alice [data-act="to-scan"]');
await sleep(1100);
await click('#alice [data-act="scan"]');
await waitFor(`${$('#alice [data-act="send"]')}`);
await sleep(2200);

// Alice pays. The camera follows the PSBT: Alice, then Bob, then back.
await click('#alice [data-act="send"]');
await parkCursor(W * 0.5, H * 1.2);
await frame(await box($('[data-who="alice"] .phone'), $('#lane')), { pad: 12, d: 1.3 });
await waitFor(`${doneSteps('bob')} >= 1`, 90000);
await frame(await box($('#lane'), $('[data-who="bob"] .phone')), { pad: 12, d: 1.3 });
await waitFor(`${doneSteps('bob')} >= 5`, 90000);
await sleep(700);
await frame(await box($('[data-who="alice"] .phone'), $('#lane')), { pad: 12, d: 1.3 });
await waitFor(`${doneSteps('alice')} >= 4`, 90000);
// Up close for the one moment that is new: two partial signatures, one signature.
await frame(await box($('#tx .card')), { pad: 22, maxZoom: 2.1, d: 1.0 });
await waitFor(`${$('#tx .stats')}`, 90000);
// Time to read the result, then back out to see it go to the network: the
// page holds the finished transaction long enough for this move.
await sleep(2400);
await wide(1.6);
await waitFor(`${$('#network.lit')}`, 60000);
await waitFor(`${$('#alice .done-view')} && ${$('#bob .done-view')}`, 60000);
await sleep(2800);

// A block.
await click('#mine');
await waitFor(`${$('#tx .status.confirmed')}`);
await sleep(2200);

// The transaction in the explorer, opened from Alice's phone.
await frame(await phoneTop('alice', 0.8), { pad: 20 });
await sleep(1200);
const href = await evaluate(`${$('#alice a.btn.primary')}.href`);
await click('#alice a.btn.primary', { follow: false });
await sleep(400);
// Out to the whole stage first, then a dip to dark into the explorer, which
// opens at the same framing: the cut is the only change, and it is hidden.
await wide(1.2);
await sleep(1500);
await fadeOut();
await goto(
  href,
  `${$('#cisa-signatures')} && ${$('app-transactions-list .payjoin-owner')} && /confirmation/i.test(document.body.innerText)`,
  `(() => { const f = document.getElementById('rec-fade'); f.classList.add('now', 'on'); f.offsetHeight; f.classList.remove('now'); const h = [...document.querySelectorAll('h1')].find((e) => /Transaction/.test(e.textContent)); window.scrollTo({ top: h.getBoundingClientRect().top + scrollY - 70, behavior: 'instant' }); document.getElementById('rec-cursor').style.opacity = 0; })()`,
);
await fadeIn();
// The explorer part keeps this framing; the page scrolls under it.
await sleep(1800);

// The aggregation section: what it saved, and whose input carries what.
const sizeSaved = (await text($('#cisa-size .card-text'))).replace(/[^0-9]/g, '');
const feeSaved = (await text($('#cisa-fee .card-text'))).replace(/[^0-9]/g, '');
const percent = await text($('#cisa-size .sub'));
await spot(await box($('#cisa-inputs'), $('#cisa-fee')), `${sizeSaved} vB less block space, ${feeSaved} sats less fee`, `${percent} smaller than with every input signed`);
await sleep(4400);
const memberName = await text($('[data-role="fullagg_member"] .payjoin-owner'));
const carrierName = await text($('[data-role="fullagg_final"] .payjoin-owner'));
await spot(await box($('[data-role="fullagg_member"]')), `No signature on ${memberName}'s input`, 'Its witness is empty: 64 bytes a signature would have taken');
await sleep(3800);
await spot(await box($('[data-role="fullagg_final"]')), `One signature on ${carrierName}'s input signs both inputs`, 'A 64-byte aggregate signature plus one marker byte');
await sleep(3800);
await unspot();

// The same in the transaction's own inputs.
const vinOf = (name) => `[...document.querySelectorAll('app-transactions-list .payjoin-owner')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
// An input's address cell, and its witness row: the witness row is in the
// same input's details table, the first one after the address.
const inputRows = (name) => `(() => {
  const cell = ${vinOf(name)}.closest('td');
  const roles = [...document.querySelectorAll('app-transactions-list .cisa-role')];
  const after = roles.find((r) => cell.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING);
  return [cell, after.closest('tr')];
})()`;
await scrollTo(`${vinOf(memberName)}.closest('td')`, 110);
await spot(await box(inputRows(memberName)), `The witness of ${memberName}'s input is empty`, 'This is the transaction as mined, not a summary of it');
await sleep(3800);
await spot(await box(inputRows(carrierName)), `${carrierName}'s input carries the aggregate signature`, 'Nodes verify it against the keys of both inputs at once');
await sleep(4000);
await unspot();

// What Bob actually received, with the arithmetic.
await scrollTo(heading('Payjoin'), 110);
await evaluate(`document.getElementById('rec-cursor').style.opacity = 1`);
await click('.payjoin-calculations summary');
await evaluate(`document.getElementById('rec-cursor').style.opacity = 0`);
await sleep(600);
await scrollTo(`${$('.payjoin-party.recipient')}`, 90);
const received = await text($('#payjoin-received strong'));
await spot(await box($('.payjoin-party.recipient')), `Bob received ${received}`, 'What came out to him, minus the coin he put in');
await sleep(4600);
await unspot();

// And the totals.
await scrollTo(heading('Details'), 110);
await evaluate(`[...document.querySelectorAll('td')].find((td) => td.textContent.trim() === 'Weight').closest('tr').id = 'rec-weight-row'`);
const savedLine = await text($('#cisa-saved .cisa-saved'));
await spot(await box($('#rec-weight-row'), $('#cisa-saved')), `Saved by signature aggregation: ${savedLine}`, 'Against the same transaction with every input signed');
await sleep(4600);
await unspot();
await sleep(800);

// The closing card: a dip to dark, the card rises in, and it stays for five
// seconds before the video ends.
await fadeOut();
await goto(
  `file://${path.join(DEMO, 'scripts', 'endcard', 'endcard.html')}`,
  `document.fonts.status === 'loaded' && document.querySelector('.logo').complete`,
  `document.getElementById('rec-cursor').style.opacity = 0`,
);
await evaluate(`document.body.classList.add('go')`);
await sleep(1300 + 5000);

// An idle page sends no frames, so the last one is held until here.
const takeEnd = Date.now() / 1000 - skipped;
await cdp.send('Page.stopScreencast');
recording = false;

// ---------------------------------------------------------------------------
// Encode: frames at their real timing, then the camera.

if (frames.length < 2) throw new Error('no frames captured');
const end = Math.max(takeEnd, frames[frames.length - 1].t + 1 / FPS);
const list = frames.map((f, i) => {
  const next = i + 1 < frames.length ? frames[i + 1].t : end;
  return `file '${f.file}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}`;
}).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
const listFile = path.join(WORK, 'frames.txt');
fs.writeFileSync(listFile, list);

for (const key of camera) key.t = Math.max(0, key.t - frames[0].t);

// The camera works in CSS pixels; the frames have however many each got.
function jpegWidth(file) {
  const b = fs.readFileSync(file);
  for (let i = 2; i < b.length - 8;) {
    const marker = b[i + 1];
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return b.readUInt16BE(i + 7);
    i += 2 + length;
  }
  throw new Error(`no frame size in ${file}`);
}
const scale = jpegWidth(frames[0].file) / W;
if (scale !== DPR) console.warn(`frames are ${scale}x the page, not ${DPR}x; close ups will be softer`);

// value(t) = first target + every later move's share of its change, eased.
function track(key) {
  let e = camera[0][key].toFixed(3);
  for (let i = 1; i < camera.length; i++) {
    const delta = camera[i][key] - camera[i - 1][key];
    if (Math.abs(delta) < 1e-4) continue;
    const t0 = camera[i].t.toFixed(3);
    if (camera[i].d <= 0) {
      e += `+(${delta.toFixed(4)})*gte(it,${t0})`;
    } else {
      const u = `clip((it-${t0})/${camera[i].d},0,1)`;
      e += `+(${delta.toFixed(4)})*${u}*${u}*(3-2*${u})`;
    }
  }
  return e;
}
const zoompan = [
  `zoompan=z='${track('z')}'`,
  `x='clip((${track('cx')})*${scale}-iw/zoom/2,0,iw-iw/zoom)'`,
  `y='clip((${track('cy')})*${scale}-ih/zoom/2,0,ih-ih/zoom)'`,
  `d=1:s=${OUT_SIZE}:fps=${FPS}`,
].join(':');
const filterFile = path.join(WORK, 'camera.filter');
fs.writeFileSync(filterFile, `fps=${FPS},${zoompan},format=yuv420p`);
fs.writeFileSync(path.join(WORK, 'camera.json'), JSON.stringify(camera, null, 1));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', listFile,
  '-/vf', filterFile,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart',
  OUT,
], { stdio: 'inherit' });

const seconds = (end - frames[0].t).toFixed(1);
console.log(`${OUT}: ${seconds} s from ${frames.length} frames, ${camera.length} camera moves`);
chrome.kill();
fs.rmSync(FRAMES, { recursive: true, force: true });
process.exit(0);
