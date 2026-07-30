// live-check.mjs —— 无头 Chrome + CDP 真机验收（本地或线上都能跑）
// 用法：node live-check.mjs [--url https://...] [--shot out.png] [--port 9333]
// 不给 --url 就自己起一个静态服务器伺候 ~/code/chess-cloud

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { count } from './verify.mjs';
import { Chess } from 'chess.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', '9333'));
const SHOT = arg('--shot', path.join(os.tmpdir(), 'chess-cloud-shot.png'));
let URL_ = arg('--url', null);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

let server = null, chromeProcess = null;
async function serveLocal() {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(8123, '127.0.0.1', r));
  return 'http://127.0.0.1:8123/index.html';
}

// ─────────────────────────── CDP 最小客户端
let ws = null, nextId = 1;
const waiting = new Map();
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise, userGesture: true,
  });
  if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const dir = path.join(os.tmpdir(), `chess-cloud-chrome-${PORT}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const p = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--window-size=1440,900',
    // 无头下 WebGL：走 angle+swiftshader，别用 --disable-gpu（会出合成伪影/黑画布）
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 80; i++) {
    try {
      const v = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (v.ok) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 起不来');
}

async function attach() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没找到 page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.text || '') + ' ' + String(m.params.exceptionDetails.exception?.description || ''));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push('console.error: ' + JSON.stringify(m.params.args.map((a) => a.value ?? a.description)));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  // 坑：CDP 新 tab document.hidden=true，rAF 全冻结 → three.js 一帧都不画
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');
}

// ─────────────────────────── 截图像素统计（零依赖解 PNG）
// 为什么不用 gl.readPixels：没开 preserveDrawingBuffer 的话，rAF 之外读默认帧缓冲一律是空的，
// 那个 0 是量法的问题不是画面的问题。所以改成直接解 CDP 截下来的 PNG，看画面真长什么样。
function decodePng(buf) {
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!ch || bd !== 8) throw new Error(`不支持的 PNG: colorType=${ct} bitDepth=${bd}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (f !== 0) throw new Error('未知 PNG filter ' + f);
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, px: out };
}

function shotStats(file, rect) {
  const { w, h, ch, px } = decodePng(fs.readFileSync(file));
  // 取样区不再靠猜布局：直接问页面要星云 canvas 的真实矩形（getBoundingClientRect），
  // 往里缩 4px 避开圆角描边。这样以后怎么改版式，量法都跟着走。
  const x0 = Math.max(0, Math.round(rect.x) + 4), x1 = Math.min(w, Math.round(rect.x + rect.w) - 4);
  const y0 = Math.max(0, Math.round(rect.y) + 4), y1 = Math.min(h, Math.round(rect.y + rect.h) - 4);
  let total = 0, lit = 0, warm = 0, cold = 0, bright = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * ch;
      const r = px[o], g = px[o + 1], b = px[o + 2];
      total++;
      const br = r + g + b;
      if (br <= 90) continue;
      lit++;
      if (br > 450) bright++;
      if (r > b + 20) warm++;
      else if (b > r + 20) cold++;
    }
  }
  return {
    w, h, rect, total, lit, warm, cold, bright,
    litRatio: +(lit / total).toFixed(4),
    brightRatio: +(bright / total).toFixed(4),
    warmOfLit: +(warm / Math.max(1, lit)).toFixed(4),
    coldOfLit: +(cold / Math.max(1, lit)).toFixed(4),
  };
}

function edgeStats(file, cssW, cssH) {
  const { w, h, ch, px } = decodePng(fs.readFileSync(file));
  const scale = Math.min(w / cssW, h / cssH);
  const band = Math.max(2, Math.round(7 * scale));
  let total = 0, dark = 0, light = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      const o = (y * w + x) * ch;
      const sum = px[o] + px[o + 1] + px[o + 2];
      total++;
      if (sum < 240) dark++;
      if (sum > 660) light++;
    }
  }
  return {
    w, h, band, total, dark, light,
    darkRatio: +(dark / Math.max(1, total)).toFixed(4),
    lightRatio: +(light / Math.max(1, total)).toFixed(4),
  };
}

// ─────────────────────────── 验收
const results = [];
function record(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`${ok ? '绿 ✓' : '红 ✗'} ${label}${detail ? ' — ' + detail : ''}`);
}

async function waitCloud(timeoutMs = 90000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await evalJs('typeof window.__cloudStats === "function" ? window.__cloudStats() : null');
    if (last && last.growing === false && last.depth >= 4) return last;
    await sleep(400);
  }
  throw new Error('等星云长满超时，最后状态: ' + JSON.stringify(last));
}

async function checkNodesMatchCount(stats, tag) {
  // ① __cloudStats().nodes 与 count(同 fen 同 depth) 完全相等
  const expect = count(stats.fen, stats.depth);
  record(stats.nodes === expect,
    `①${tag} __cloudStats().nodes == count(fen, ${stats.depth})`,
    `页面 ${stats.nodes} vs verify.mjs count() ${expect}｜fen=${stats.fen}`);
  // 顺手把每一层都对一遍，比只对最深一层狠
  for (const l of stats.layers) {
    const e = count(stats.fen, l.depth);
    record(l.nodes === e, `①${tag} 第 ${l.depth} 层星数`, `页面 ${l.nodes} vs count() ${e}`);
  }
}

async function settleLayout() {
  await evalJs('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
}

async function setViewport(width, height, orientation) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: true,
    screenWidth: width, screenHeight: height,
    screenOrientation: { type: orientation, angle: orientation === 'portraitPrimary' ? 0 : 90 },
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await settleLayout();
}

async function touchAt(x, y) {
  const point = { x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 };
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(100);
}

async function selectorCenter(selector) {
  const quoted = JSON.stringify(selector);
  await evalJs(`(() => {
    const el = document.querySelector(${quoted});
    if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
  })()`);
  await settleLayout();
  return evalJs(`(() => {
    const el = document.querySelector(${quoted});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: (r.left + r.right) / 2,
      y: (r.top + r.bottom) / 2,
      w: r.width,
      h: r.height,
    };
  })()`);
}

async function clickSelector(selector) {
  const center = await selectorCenter(selector);
  if (!center) return false;
  await clickAt(center.x, center.y);
  await settleLayout();
  return true;
}

async function swipeTouch(from, to, steps = 8) {
  const pointAt = (i) => ({
    x: from.x + (to.x - from.x) * i / steps,
    y: from.y + (to.y - from.y) * i / steps,
    radiusX: 1, radiusY: 1, force: 1, id: 1,
  });
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pointAt(0)] });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pointAt(i)] });
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(120);
}

function layoutProblems(layout) {
  const issues = [];
  const panels = Object.entries(layout.panels);
  if (Math.max(layout.root.scrollW, layout.body.scrollW) > layout.root.clientW + 1) {
    issues.push(`根页面横向溢出 ${Math.max(layout.root.scrollW, layout.body.scrollW)}>${layout.root.clientW}`);
  }
  for (const [id, r] of panels) {
    if (r.docX < -1 || r.docRight > layout.viewport.w + 1) {
      issues.push(`${id} 横向 ${Math.round(r.docX)}..${Math.round(r.docRight)}`);
    }
    if (r.docY < -1 || r.docBottom > layout.root.scrollH + 1) {
      issues.push(`${id} 纵向 ${Math.round(r.docY)}..${Math.round(r.docBottom)} / 文档 ${layout.root.scrollH}`);
    }
  }
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const [aId, a] = panels[i], [bId, b] = panels[j];
      const overlapW = Math.min(a.docRight, b.docRight) - Math.max(a.docX, b.docX);
      const overlapH = Math.min(a.docBottom, b.docBottom) - Math.max(a.docY, b.docY);
      if (overlapW > 1 && overlapH > 1) {
        issues.push(`${aId}/${bId} 重叠 ${Math.round(overlapW)}×${Math.round(overlapH)}`);
      }
    }
  }
  return issues;
}

async function forkColumnDom(col) {
  return evalJs(`(() => {
    const col = ${Number(col)};
    const cards = [...document.querySelectorAll(\`#fork g.card[data-col="\${col}"]\`)];
    const selected = cards.find((card) => card.dataset.selected === 'true') || null;
    const toggle = document.querySelector(\`#fork g.more[data-col="\${col}"]\`);
    return {
      cards: cards.length,
      indices: cards.map((card) => Number(card.dataset.idx)),
      selectedRank: selected ? Number(selected.dataset.idx) : null,
      selectedSan: selected?.dataset.san || '',
      toggleText: toggle?.textContent.trim() || '',
      toggleExpanded: toggle?.dataset.expanded || '',
    };
  })()`);
}

async function forkRouteDom() {
  return evalJs(`(() => {
    const cardCenter = (card) => {
      const r = card?.querySelector('rect');
      if (!r) return null;
      const x = Number(r.getAttribute('x'));
      const y = Number(r.getAttribute('y'));
      const w = Number(r.getAttribute('width'));
      const h = Number(r.getAttribute('height'));
      return { left: x, right: x + w, y: y + h / 2 };
    };
    const pathEnds = (path) => {
      if (!path) return null;
      const length = path.getTotalLength();
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(length);
      return {
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
      };
    };
    const root = document.querySelector('#fork circle[data-root="true"]');
    const rootPoint = root
      ? { x: Number(root.getAttribute('cx')), y: Number(root.getAttribute('cy')) }
      : null;
    const columns = [...new Set(
      [...document.querySelectorAll('#fork g.card[data-col]')]
        .map((card) => Number(card.dataset.col)),
    )].sort((a, b) => a - b);
    return columns.map((col, position) => {
      const cards = [...document.querySelectorAll(\`#fork g.card[data-col="\${col}"]\`)];
      const selectedCards = cards.filter((card) => card.dataset.selected === 'true');
      const edges = [...document.querySelectorAll(\`#fork path.branch-edge[data-col="\${col}"][data-selected="true"]\`)];
      const underlays = [...document.querySelectorAll(\`#fork path.route-underlay[data-col="\${col}"]\`)];
      const card = selectedCards[0] || null;
      const previous = position > 0
        ? document.querySelector(\`#fork g.card[data-col="\${columns[position - 1]}"][data-selected="true"]\`)
        : null;
      const cardPoint = cardCenter(card);
      const previousPoint = cardCenter(previous);
      const edgePoints = pathEnds(edges[0]);
      const underlayPoints = pathEnds(underlays[0]);
      const expectedStart = position === 0 ? rootPoint : (
        previousPoint ? { x: previousPoint.right, y: previousPoint.y } : null
      );
      const close = (a, b) => !!(a && b && Math.hypot(a.x - b.x, a.y - b.y) <= 1.6);
      const expectedEnd = cardPoint ? { x: cardPoint.left, y: cardPoint.y } : null;
      return {
        col,
        selectedCards: selectedCards.length,
        selectedEdges: edges.length,
        routeUnderlays: underlays.length,
        cardIdx: card ? Number(card.dataset.idx) : null,
        edgeIdx: edges[0] ? Number(edges[0].dataset.idx) : null,
        strokeWidth: edges[0] ? Number(edges[0].getAttribute('stroke-width')) : 0,
        continuous:
          close(edgePoints?.start, expectedStart)
          && close(edgePoints?.end, expectedEnd)
          && close(underlayPoints?.start, expectedStart)
          && close(underlayPoints?.end, expectedEnd),
      };
    });
  })()`);
}

function analyzeCloudShape(map) {
  const root = map.layers.find((layer) => layer.depth === 0);
  const first = map.layers.find((layer) => layer.depth === 1);
  const rootPosition = root?.positions?.slice(0, 3) || [];
  const firstPositions = first?.positions || [];
  const vectors = [];
  for (let i = 0; i + 2 < firstPositions.length; i += 3) {
    vectors.push([
      firstPositions[i] - (rootPosition[0] || 0),
      firstPositions[i + 1] - (rootPosition[1] || 0),
      firstPositions[i + 2] - (rootPosition[2] || 0),
    ]);
  }
  const mean = [0, 0, 0];
  let meanRadius = 0;
  for (const v of vectors) {
    mean[0] += v[0]; mean[1] += v[1]; mean[2] += v[2];
    meanRadius += Math.hypot(v[0], v[1], v[2]);
  }
  if (vectors.length) {
    mean[0] /= vectors.length; mean[1] /= vectors.length; mean[2] /= vectors.length;
    meanRadius /= vectors.length;
  }
  const meanLength = Math.hypot(mean[0], mean[1], mean[2]);
  const coherence = meanRadius ? meanLength / meanRadius : 0;
  const positive = meanLength
    ? vectors.filter((v) => v[0] * mean[0] + v[1] * mean[1] + v[2] * mean[2] > 0).length
    : 0;
  return {
    rootCount: root?.count || 0,
    rootPosition,
    firstCount: first?.count || 0,
    coherence,
    positiveRatio: vectors.length ? positive / vectors.length : 0,
  };
}

async function runMobileChecks() {
  const shotBase = SHOT.replace(/\.png$/i, '');
  try {

  // 390×844 竖屏：页面本身只纵向滚，棋盘 → 分叉 → 星云都能到达。
  await setViewport(390, 844, 'portraitPrimary');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const portrait = await evalJs('window.__test.layout()');
  const portraitProblems = layoutProblems(portrait);
  const orderOk =
    portrait.panels.boardPanel.docY < portrait.panels.stage.docY
    && portrait.panels.stage.docY < portrait.panels.cloudPanel.docY;
  await swipeTouch(
    { x: 4, y: portrait.viewport.h - 80 },
    { x: 4, y: 80 },
  );
  const portraitScrollY = await evalJs('window.scrollY');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const portraitViewportOk =
    Math.abs(portrait.viewport.w - 390) <= 1
    && Math.abs(portrait.viewport.h - 844) <= 1
    && Math.abs(portrait.viewport.visualW - 390) <= 1;
  record(portraitProblems.length === 0 && orderOk && portraitScrollY > 20 && portraitViewportOk,
    '④ 手机竖屏三块面板完整可达、互不覆盖',
    portraitProblems.length
      ? portraitProblems.join('; ')
      : `viewport ${portrait.viewport.w}×${portrait.viewport.h}｜真实滑动到 y=${Math.round(portraitScrollY)}｜顺序 棋盘→分叉→星云`);

  const boardOk =
    Math.abs(portrait.board.w - portrait.board.h) <= 1
    && portrait.board.w / 8 >= 36
    && portrait.board.docX >= -1
    && portrait.board.docRight <= portrait.viewport.w + 1;
  const targets = [...portrait.controls.buttons, portrait.controls.firstCard].filter(Boolean);
  const targetsOk = targets.length > 0 && targets.every((r) => r.h >= 43.9);
  const minTarget = targets.length ? Math.min(...targets.map((r) => r.h)) : 0;
  record(boardOk && targetsOk,
    '④ 手机棋盘保持正方形，触控目标不小于 44px',
    `棋盘 ${Math.round(portrait.board.w)}×${Math.round(portrait.board.h)}｜单格 ${(portrait.board.w / 8).toFixed(1)}px｜最小目标 ${minTarget.toFixed(1)}px`);

  const forkGesture = await evalJs(`(() => {
    const wrap = document.getElementById('forkWrap');
    wrap.scrollLeft = 0;
    const r = wrap.getBoundingClientRect();
    return {
      from: { x: r.right - 24, y: r.top + Math.min(r.height - 24, 180) },
      to: { x: r.left + 24, y: r.top + Math.min(r.height - 24, 180) },
    };
  })()`);
  await swipeTouch(forkGesture.from, forkGesture.to);
  const gestureScrollLeft = await evalJs('document.getElementById("forkWrap").scrollLeft');

  const forkReach = await evalJs(`(() => {
    const wrap = document.getElementById('forkWrap');
    const cards = [...document.querySelectorAll('#fork g.card')];
    if (cards.length === 0) {
      return {
        cards: 0, clientW: wrap.clientWidth, scrollW: wrap.scrollWidth,
        visible: false, target: null,
        rootScrollW: document.documentElement.scrollWidth,
        rootClientW: document.documentElement.clientWidth,
      };
    }
    wrap.scrollLeft = wrap.scrollWidth;
    const wr = wrap.getBoundingClientRect();
    const lastCol = Math.max(...cards.map((card) => Number(card.dataset.col)));
    const target = cards.find((card) => Number(card.dataset.col) === lastCol && Number(card.dataset.idx) === 1)
      || cards.find((card) => Number(card.dataset.col) === lastCol);
    const r = target.getBoundingClientRect();
    return {
      cards: cards.length, clientW: wrap.clientWidth, scrollW: wrap.scrollWidth,
      visible: r.right > wr.left && r.left < wr.right,
      target: {
        x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2,
        col: lastCol, san: target.querySelector('text').textContent,
      },
      rootScrollW: document.documentElement.scrollWidth,
      rootClientW: document.documentElement.clientWidth,
    };
  })()`);
  if (forkReach.target) {
    await touchAt(forkReach.target.x, forkReach.target.y);
    await sleep(120);
  }
  const touchedBranch = forkReach.target
    ? await evalJs(`window.__forkStats()[${forkReach.target.col}].chosenSan`)
    : null;
  record(
    forkReach.cards > 0
      && gestureScrollLeft > 10
      && forkReach.scrollW > forkReach.clientW
      && forkReach.visible
      && touchedBranch === forkReach.target?.san
      && forkReach.rootScrollW <= forkReach.rootClientW + 1,
    '④ 分叉可真实横滑，最后一列可触摸选择',
    `手势滑到 ${Math.round(gestureScrollLeft)}px｜末列点 ${forkReach.target?.san || '无卡片'}→${touchedBranch || '未选'}｜根页面 ${forkReach.rootClientW}/${forkReach.rootScrollW}px`);

  // 背景不是只铺首屏：页面顶部和滚到底后的四周都直接数截图像素。
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const topFile = `${shotBase}-mobile-top.png`;
  const topShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(topFile, Buffer.from(topShot.data, 'base64'));
  await evalJs('window.scrollTo(0, document.documentElement.scrollHeight)');
  await settleLayout();
  const bottomPosition = await evalJs(`({
    y: window.scrollY,
    max: document.documentElement.scrollHeight - window.innerHeight,
  })`);
  const bottomFile = `${shotBase}-mobile-bottom.png`;
  const bottomShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(bottomFile, Buffer.from(bottomShot.data, 'base64'));
  const topEdge = edgeStats(topFile, portrait.viewport.w, portrait.viewport.h);
  const bottomEdge = edgeStats(bottomFile, portrait.viewport.w, portrait.viewport.h);
  record(
    topEdge.darkRatio > 0.98
      && bottomEdge.darkRatio > 0.98
      && bottomPosition.y >= bottomPosition.max - 1,
    '④ 手机背景从页面顶部铺到底部，无白边或透明断层',
    `顶部深色 ${topEdge.darkRatio}｜底部深色 ${bottomEdge.darkRatio}｜滚动 ${Math.round(bottomPosition.y)}/${Math.round(bottomPosition.max)}`);

  // 全屏要真占满 viewport，四角的命中层也必须属于星云，而不是后面的面板。
  const skyTap = await evalJs(`(() => {
    const r = document.getElementById('sky').getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  })()`);
  await touchAt(skyTap.x, skyTap.y);
  await settleLayout();
  const full = await evalJs(`(() => {
    const l = window.__test.layout();
    const w = l.viewport.visualW, h = l.viewport.visualH;
    const points = [[1,1],[w-2,1],[1,h-2],[w-2,h-2]];
    const cornersHit = points.every(([x,y]) => {
      const el = document.elementFromPoint(x,y);
      return !!(el && el.closest('#cloudPanel'));
    });
    return { layout: l, cornersHit };
  })()`);
  const fsb = full.layout.skyBox, fsc = full.layout.skyCanvas;
  const pxRatio = Math.min(full.layout.viewport.dpr, 2);
  const fullGeometryOk =
    full.layout.cloudFull
    && Math.abs(fsb.x) <= 1 && Math.abs(fsb.y) <= 1
    && Math.abs(fsb.w - full.layout.viewport.visualW) <= 1
    && Math.abs(fsb.h - full.layout.viewport.visualH) <= 1
    && full.cornersHit
    && Math.abs(fsc.pixelW - fsc.w * pxRatio) <= 2
    && Math.abs(fsc.pixelH - fsc.h * pxRatio) <= 2;

  // 全屏标签直接读实际 DOM 盒子/computedStyle，合法性则由 Node 端 chess.js 独立判断。
  await sleep(260);
  await settleLayout();
  const fullStateBeforeLabel = await evalJs('window.__test.state()');
  const legalFullSans = new Set(new Chess(fullStateBeforeLabel.fen).moves());
  const fullMap = await evalJs('window.__test.cloudMap()');
  const forkAtFull = await evalJs('window.__forkStats()');
  const visibleLabels = fullMap.labels.filter((label) => label.visible);
  const visibleRoots = visibleLabels.filter((label) => label.depth === 0 && label.text.includes('现在'));
  const firstLevelLabels = fullMap.labels.filter((label) => label.depth === 1 && label.san);
  const visibleMoves = visibleLabels.filter((label) => label.depth === 1 && label.san);
  const pathLabels = fullMap.labels.filter((label) => label.depth >= 2 && label.san);
  const visibleSans = visibleLabels.filter((label) => label.depth >= 1 && label.san);
  const pathLabelsLegal = pathLabels.every((label) => {
    const parent = forkAtFull[label.depth - 1];
    return !!parent
      && new Chess(parent.fen).moves().includes(label.san)
      && parent.chosenSan === label.san;
  });
  const labelsOk =
    visibleRoots.length === 1
    && visibleSans.length >= 3
    && visibleLabels.length <= 5
    && firstLevelLabels.every((label) => legalFullSans.has(label.san))
    && new Set(firstLevelLabels.map((label) => label.san)).size === firstLevelLabels.length
    && pathLabels.length === fullMap.routePoints - 2
    && pathLabelsLegal
    && fullMap.routePoints >= 3 && fullMap.routePoints <= 4;
  record(
    labelsOk,
    '④ 手机全屏有「现在」和少量真实走法标签，主路径逐步合法',
    `可见 ${visibleLabels.length} 个（现在 ${visibleRoots.length} + SAN ${visibleSans.length}）`
      + `｜根走法 ${visibleMoves.map((label) => label.san).join('/')}`
      + `｜后续路径 ${pathLabels.map((label) => `${label.depth}:${label.san}`).join('/')}`
      + `｜selected-route position.count=${fullMap.routePoints}`);

  // 真触摸一个当前可见、非默认的走法标签；它只换选路，不得偷偷落子。
  const labelTarget = visibleMoves.find((label) => !label.selected) || null;
  const forkBeforeLabel = (await evalJs('window.__forkStats()'))[0];
  const historyBeforeLabel = fullStateBeforeLabel.history;
  if (labelTarget) {
    await touchAt(labelTarget.x, labelTarget.y);
    await sleep(280);
    await settleLayout();
  }
  const stateAfterLabel = await evalJs('window.__test.state()');
  const forkAfterLabel = (await evalJs('window.__forkStats()'))[0];
  const mapAfterLabel = await evalJs('window.__test.cloudMap()');
  const selectedLabelAfter = mapAfterLabel.labels.find((label) =>
    label.depth === 1 && label.san === labelTarget?.san && label.selected);
  const labelPickOk =
    !!labelTarget
    && legalFullSans.has(labelTarget.san)
    && forkAfterLabel.chosenSan === labelTarget.san
    && forkAfterLabel.chosenSan !== forkBeforeLabel.chosenSan
    && stateAfterLabel.fen === fullStateBeforeLabel.fen
    && JSON.stringify(stateAfterLabel.history) === JSON.stringify(historyBeforeLabel)
    && !!selectedLabelAfter
    && mapAfterLabel.routePoints >= 3 && mapAfterLabel.routePoints <= 4;
  record(
    labelPickOk,
    '④ 真实触摸星图标签会同步第一列选路，但棋谱不动',
    `点 ${labelTarget?.san || '无可点标签'}｜第一列 ${forkBeforeLabel.chosenSan}→${forkAfterLabel.chosenSan}`
      + `｜history ${JSON.stringify(historyBeforeLabel)}→${JSON.stringify(stateAfterLabel.history)}`
      + `｜路线点 ${mapAfterLabel.routePoints}`);

  // 先让选中标签带来的镜头聚焦稳定下来，再从画布空白处发真实 touch drag。
  await sleep(520);
  await settleLayout();
  const mapBeforeDrag = await evalJs('window.__test.cloudMap()');
  const cloudDrag = await evalJs(`(() => {
    const canvas = document.getElementById('sky');
    const r = canvas.getBoundingClientRect();
    const candidates = [];
    for (const yf of [.78, .68, .58, .86]) {
      for (const xf of [.82, .72, .62, .9]) {
        const x = r.left + r.width * xf, y = r.top + r.height * yf;
        if (document.elementFromPoint(x, y) === canvas) candidates.push({ x, y });
      }
    }
    const from = candidates[0] || null;
    if (!from) return null;
    return {
      from,
      to: {
        x: Math.max(r.left + 24, r.left + r.width * .18),
        y: Math.min(r.bottom - 24, from.y + 34),
      },
    };
  })()`);
  if (cloudDrag) await swipeTouch(cloudDrag.from, cloudDrag.to, 12);
  await sleep(260);
  await settleLayout();
  const mapAfterDrag = await evalJs('window.__test.cloudMap()');
  const matrixDelta = mapBeforeDrag.cameraMatrix.reduce(
    (max, value, i) => Math.max(max, Math.abs(value - mapAfterDrag.cameraMatrix[i])),
    0,
  );
  const labelKey = (label) => `${label.depth}:${label.index}:${label.san}`;
  const labelsBeforeByKey = new Map(mapBeforeDrag.labels.map((label) => [labelKey(label), label]));
  let maxLabelMove = 0, visibilityChanged = false;
  for (const label of mapAfterDrag.labels) {
    const before = labelsBeforeByKey.get(labelKey(label));
    if (!before) continue;
    maxLabelMove = Math.max(maxLabelMove, Math.hypot(label.x - before.x, label.y - before.y));
    if (label.visible !== before.visible) visibilityChanged = true;
  }
  const visibleAfterDrag = mapAfterDrag.labels.filter((label) => label.visible).length;
  const hiddenAfterDrag = mapAfterDrag.labels.length - visibleAfterDrag;
  const dragOk =
    !!cloudDrag
    && matrixDelta > 0.01
    && maxLabelMove > 8
    && visibleAfterDrag > 0
    && hiddenAfterDrag > 0;
  record(
    dragOk,
    '④ 真实拖动会转动相机并重排标签，画面同时有显有隐',
    `拖动 ${cloudDrag ? `${Math.round(cloudDrag.from.x)},${Math.round(cloudDrag.from.y)}→${Math.round(cloudDrag.to.x)},${Math.round(cloudDrag.to.y)}` : '没找到画布空白'}`
      + `｜camera Δ${matrixDelta.toFixed(3)}｜标签最大位移 ${maxLabelMove.toFixed(1)}px`
      + `｜显/隐 ${visibleAfterDrag}/${hiddenAfterDrag}｜显隐集合变化=${visibilityChanged}`);

  // 全屏只由明确的收起按钮退出；不再拿点画布中心冒充关闭。
  const closeTap = await evalJs(`(() => {
    const button = document.getElementById('cloudClose');
    const r = button.getBoundingClientRect();
    const cs = getComputedStyle(button);
    return {
      x: (r.left + r.right) / 2,
      y: (r.top + r.bottom) / 2,
      w: r.width,
      h: r.height,
      visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
    };
  })()`);
  if (closeTap.visible) {
    await touchAt(closeTap.x, closeTap.y);
    await sleep(180);
    await settleLayout();
  }
  const closed = await evalJs(`(() => ({
    layout: window.__test.layout(),
    closeDisplay: getComputedStyle(document.getElementById('cloudClose')).display,
  }))()`);
  const fullOk =
    fullGeometryOk
    && closeTap.visible
    && closeTap.w >= 47.9 && closeTap.h >= 43.9
    && !closed.layout.cloudFull
    && closed.closeDisplay === 'none';
  record(fullOk, '④ 手机星云是真全屏，并可用明确按钮真实触摸收起',
    `真实触摸开/按钮关｜盒子 ${Math.round(fsb.x)},${Math.round(fsb.y)} ${Math.round(fsb.w)}×${Math.round(fsb.h)}`
      + `｜画布 ${fsc.pixelW}×${fsc.pixelH}｜四角命中 ${full.cornersHit}`
      + `｜收起按钮 ${Math.round(closeTap.w)}×${Math.round(closeTap.h)}｜关闭后 full=${closed.layout.cloudFull}`);

  // 不走测试钩子，发真实 touch 事件点 e2 → e4。
  await evalJs(`(() => {
    window.__test.reset();
    document.getElementById('board').scrollIntoView({ block: 'center' });
  })()`);
  await settleLayout();
  const tapBoard = await evalJs(`(() => {
    const r = document.getElementById('board').getBoundingClientRect();
    const at = (file, rank) => ({
      x: r.left + (file + .5) * r.width / 8,
      y: r.top + (8 - rank + .5) * r.height / 8,
    });
    return { e2: at(4, 2), e4: at(4, 4) };
  })()`);
  await touchAt(tapBoard.e2.x, tapBoard.e2.y);
  const mobileAiStart = Date.now();
  await touchAt(tapBoard.e4.x, tapBoard.e4.y);
  let mobileAi = null, touched = [];
  while (Date.now() - mobileAiStart < 5000) {
    const mobileState = await evalJs('({ state: window.__test.state(), ai: window.__test.ai() })');
    touched = mobileState.state.history;
    mobileAi = mobileState.ai;
    if (mobileAi && touched.length >= 2 && !mobileState.state.thinking) break;
    await sleep(50);
  }
  const mobileAiWall = Date.now() - mobileAiStart;
  record(
    touched[0] === 'e4' && touched.length === 2 && !!mobileAi && mobileAiWall <= 3000,
    '④ 手机真实触摸能走 e4，AI 仍在 3 秒内合法应手',
    `外部秒表 ${mobileAiWall}ms｜棋谱 ${JSON.stringify(touched)}｜${mobileAi ? `搜到 ${mobileAi.depth} 层` : 'AI 未返回'}`);

  // 844×390 短横屏：允许页面纵滚，但不能再把棋盘裁到屏外或压住星云。
  await setViewport(844, 390, 'landscapePrimary');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const landscape = await evalJs('window.__test.layout()');
  const landscapeProblems = layoutProblems(landscape);
  await swipeTouch(
    { x: 4, y: landscape.viewport.h - 55 },
    { x: 4, y: 55 },
  );
  const landscapeScrollY = await evalJs('window.scrollY');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const landscapeTopFile = `${shotBase}-mobile-landscape-top.png`;
  const landscapeTopShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(landscapeTopFile, Buffer.from(landscapeTopShot.data, 'base64'));
  await evalJs('window.scrollTo(0, document.documentElement.scrollHeight)');
  await settleLayout();
  const landscapeBottomFile = `${shotBase}-mobile-landscape-bottom.png`;
  const landscapeBottomShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(landscapeBottomFile, Buffer.from(landscapeBottomShot.data, 'base64'));
  const landscapeTopEdge = edgeStats(landscapeTopFile, landscape.viewport.w, landscape.viewport.h);
  const landscapeBottomEdge = edgeStats(landscapeBottomFile, landscape.viewport.w, landscape.viewport.h);
  const landscapeViewportOk =
    Math.abs(landscape.viewport.w - 844) <= 1
    && Math.abs(landscape.viewport.h - 390) <= 1
    && Math.abs(landscape.viewport.visualW - 844) <= 1;
  record(
    landscapeProblems.length === 0
      && landscapeViewportOk
      && landscapeScrollY > 20
      && landscapeTopEdge.lightRatio < 0.08
      && landscapeBottomEdge.lightRatio < 0.08,
    '④ 手机短横屏面板完整可达、互不覆盖',
    landscapeProblems.length
      ? landscapeProblems.join('; ')
      : `viewport ${landscape.viewport.w}×${landscape.viewport.h}｜真实滑动到 y=${Math.round(landscapeScrollY)}｜背景亮边 ${landscapeTopEdge.lightRatio}/${landscapeBottomEdge.lightRatio}`);

  const landscapeTargets = [...landscape.controls.buttons, landscape.controls.firstCard].filter(Boolean);
  const landscapeTargetsOk = landscapeTargets.length > 0 && landscapeTargets.every((r) => r.h >= 43.9);

  await setViewport(667, 375, 'landscapePrimary');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const smallLandscape = await evalJs('window.__test.layout()');
  const smallProblems = layoutProblems(smallLandscape);
  const smallTargets = [...smallLandscape.controls.buttons, smallLandscape.controls.firstCard].filter(Boolean);
  const smallTwoColumn =
    Math.abs(smallLandscape.panels.boardPanel.docY - smallLandscape.panels.stage.docY) <= 1
    && smallLandscape.panels.boardPanel.docRight <= smallLandscape.panels.stage.docX + 1
    && smallLandscape.panels.cloudPanel.docY > smallLandscape.panels.boardPanel.docY;

  await setViewport(1024, 768, 'landscapePrimary');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const tablet = await evalJs('window.__test.layout()');
  const tabletProblems = layoutProblems(tablet);
  const tabletTargets = [...tablet.controls.buttons, tablet.controls.firstCard].filter(Boolean);
  const tabletTwoColumn =
    Math.abs(tablet.panels.cloudPanel.docY - tablet.panels.stage.docY) <= 1
    && tablet.panels.cloudPanel.docRight <= tablet.panels.stage.docX + 1
    && tablet.panels.boardPanel.docRight <= tablet.panels.stage.docX + 1;
  record(
    Math.abs(landscape.board.w - landscape.board.h) <= 1
      && landscape.board.docX >= -1
      && landscape.board.docRight <= landscape.viewport.w + 1
      && landscapeTargetsOk
      && smallProblems.length === 0
      && smallTwoColumn
      && smallTargets.length > 0 && smallTargets.every((r) => r.h >= 43.9)
      && tabletProblems.length === 0
      && tabletTwoColumn
      && tabletTargets.length > 0 && tabletTargets.every((r) => r.h >= 43.9),
    '④ 常见手机横屏与平板均完整，触控目标不小于 44px',
    `844 棋盘 ${Math.round(landscape.board.w)}px｜667 双栏 ${smallTwoColumn ? '是' : '否'} / ${smallProblems.length ? smallProblems.join('; ') : '无重叠'}｜1024 双栏 ${tabletTwoColumn ? '是' : '否'} / ${tabletProblems.length ? tabletProblems.join('; ') : '无重叠'}`);

  } finally {
    try {
      const full = await evalJs('document.body.classList.contains("cloud-full")');
      if (full) await evalJs('window.__test.toggleCloudFull()');
    } catch {}
    try { await send('Emulation.clearDeviceMetricsOverride'); } catch {}
    try { await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 }); } catch {}
  }
}

async function main() {
  if (!URL_) URL_ = await serveLocal();
  console.log(`验收目标: ${URL_}\n`);
  chromeProcess = await launchChrome();
  await attach();

  await send('Page.navigate', { url: URL_ });
  await sleep(1500);
  await send('Page.bringToFront');

  // 1) 初始局面：等第 4 层长满，对数
  const s1 = await waitCloud();
  console.log('初始星云: ' + JSON.stringify({ depth: s1.depth, nodes: s1.nodes, total: s1.totalNodes, ms: s1.ms, layers: s1.layers }));
  await checkNodesMatchCount(s1, '');

  // 星图的「一个现在 → 向前分叉」也从 three.js 实际 geometry 对账。
  // coherence 是首层平均方向长度 / 平均半径：球壳接近 0，向前张开的锥形会明显大于 0。
  const cloudMap1 = await evalJs('window.__test.cloudMap()');
  const cloudShape1 = analyzeCloudShape(cloudMap1);
  const firstExpected = count(s1.fen, 1);
  const rootAtOrigin =
    cloudShape1.rootPosition.length === 3
    && cloudShape1.rootPosition.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e-7);
  record(
    cloudShape1.rootCount === 1 && rootAtOrigin,
    '② 星图从一个真实根点「现在」出发',
    `root position.count=${cloudShape1.rootCount}｜坐标 ${JSON.stringify(cloudShape1.rootPosition)}`);
  record(
    cloudShape1.firstCount === firstExpected && cloudMap1.firstLinks === firstExpected,
    '② 第一层真实星点和根连线都等于合法走法数',
    `geometry 星点 ${cloudShape1.firstCount}｜LineSegments ${cloudMap1.firstLinks}｜count(fen,1) ${firstExpected}`);
  record(
    cloudShape1.coherence >= 0.35 && cloudShape1.positiveRatio >= 0.8,
    '② 第一层沿未来方向展开，不再围成球壳',
    `方向一致性 ${cloudShape1.coherence.toFixed(3)}｜正向比例 ${cloudShape1.positiveRatio.toFixed(3)}`);

  // 1.5) 顺手看一眼评估分的实际分布，星色刻度是照这个定的，不是拍脑袋
  const dist = await evalJs(`(async () => {
    const m = await import('./engine.js');
    let fens = [window.__test.state().fen], all = [];
    for (let d = 1; d <= 3; d++) { const r = m.expand(fens, { keepFens: true }); fens = r.fens; if (d === 3) all = Array.from(r.scores); }
    all.sort((a, b) => a - b);
    const q = (p) => all[Math.min(all.length - 1, Math.floor(p * all.length))];
    return { n: all.length, min: all[0], p05: q(.05), p25: q(.25), p50: q(.5), p75: q(.75), p95: q(.95), max: all[all.length - 1] };
  })()`, true);
  console.log('第 3 层评估分分布（百分兵）: ' + JSON.stringify(dist));

  // 2) 截图（② 星云清晰）
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  const bytes = fs.statSync(SHOT).size;
  const skyRect = await evalJs('window.__test.skyRect()');
  const ss = shotStats(SHOT, skyRect);
  // 阈值用「占比」不用「绝对个数」，换布局/换分辨率都不会被量法误伤
  record(ss.litRatio > 0.05 && ss.brightRatio > 0.002,
    '② 截图里星云确实成形', `${SHOT} ${bytes}B｜星云窗 ${Math.round(skyRect.w)}×${Math.round(skyRect.h)}｜亮像素 ${ss.lit}/${ss.total} (${ss.litRatio})，很亮的占比 ${ss.brightRatio}`);
  record(ss.warmOfLit > 0.02 && ss.coldOfLit > 0.02,
    '② 暖/冷两色都真的看得出来', `暖 ${ss.warm} (${ss.warmOfLit})｜冷 ${ss.cold} (${ss.coldOfLit})`);

  // 3) 非法走子被拒
  const bad = await evalJs(`(() => {
    const before = window.__test.state().fen;
    const r1 = window.__test.tryMove('e2','e5');   // 白兵走不到 e5
    const r2 = window.__test.tryMove('a1','a3');   // 车被兵堵着
    const r3 = window.__test.tryMove('e7','e5');   // 那是黑子，不该动
    return { r1, r2, r3, changed: window.__test.state().fen !== before };
  })()`);
  record(bad.r1 === false && bad.r2 === false && bad.r3 === false && bad.changed === false,
    '非法走子被拒', JSON.stringify(bad));

  // 旧 AI 回包不能穿过 reset 污染新棋局：先触发一次搜索，马上重开，
  // 等过完整桌面预算后再看真实棋谱/思考态/回包和页面错误。
  const errorsBeforeResetRace = pageErrors.length;
  const resetRaceStarted = await evalJs(`(() => {
    const played = window.__test.tryMove('e2','e4');
    window.__test.reset();
    return played;
  })()`);
  await sleep(2200);
  const resetRace = await evalJs(`({
    state: window.__test.state(),
    ai: window.__test.ai(),
  })`);
  const resetRaceOk =
    resetRaceStarted === true
    && resetRace.state.history.length === 0
    && resetRace.state.thinking === false
    && resetRace.ai === null
    && pageErrors.length === errorsBeforeResetRace;
  record(
    resetRaceOk,
    '重开会作废途中 AI 回包，不会把旧应手塞进新棋局',
    `触发 e4=${resetRaceStarted}｜等 2200ms 后 history=${JSON.stringify(resetRace.state.history)}`
      + `｜thinking=${resetRace.state.thinking}｜AI=${resetRace.ai ? resetRace.ai.san : 'null'}`
      + `｜新增错误=${pageErrors.length - errorsBeforeResetRace}`);
  await evalJs('window.__test.reset()');

  // 4) e4 → AI ≤3 秒应一步合法棋
  const t0 = Date.now();
  const played = await evalJs(`window.__test.tryMove('e2','e4')`);
  record(played === true, '玩家 e4 被接受', String(played));
  let ai = null;
  while (Date.now() - t0 < 20000) {
    ai = await evalJs('window.__test.ai()');
    if (ai) break;
    await sleep(50);
  }
  const wall = Date.now() - t0;
  record(!!ai && wall <= 3000, 'e4 后 AI 应手 ≤3 秒',
    ai ? `外部秒表 ${wall}ms｜页面自计 ${ai.totalMs}ms｜走 ${ai.san}｜搜到 ${ai.depth} 层 ${ai.nodes} 节点` : '超时没应手');

  // AI 走的这步合不合法？拿棋谱在 node 里用 chess.js 独立重放一遍
  const st = await evalJs('window.__test.state()');
  let replayOk = true, replayErr = '';
  try {
    const g = new Chess();
    for (const san of st.history) g.move(san);
    replayOk = g.fen() === st.fen && st.history.length === 2;
  } catch (e) { replayOk = false; replayErr = e.message; }
  record(replayOk, 'AI 那步经 node 端 chess.js 独立重放合法',
    `棋谱 ${JSON.stringify(st.history)}｜重放后 FEN ${replayOk ? '一致' : '不一致 ' + replayErr}`);

  // 5) AI 走完后的新局面，再对一次数（这次的 fen 不是起始局面，能证明不是对着写死的数字）
  const s2 = await waitCloud();
  console.log('AI 应手后星云: ' + JSON.stringify({ depth: s2.depth, nodes: s2.nodes, total: s2.totalNodes, ms: s2.ms }));
  record(s2.fen !== s1.fen, '第二朵云的根局面确实换了', s2.fen);
  await checkNodesMatchCount(s2, '(局中)');

  // 6) 分叉图：每列声明的「一共多少种走法」拿 count(该列局面, 1) 对撞，
  //    卡片数是从 SVG 里真数出来的 <g class="card">，不是页面自己报的账
  const cols = await evalJs('window.__forkStats()');
  console.log('分叉列: ' + JSON.stringify(cols.map((c) => `#${c.ply} 共${c.total}种/摆${c.cards}张→${c.chosenSan}`)));
  let colOk = cols.length === 5;
  const bad2 = [];
  for (const c of cols) {
    const e = count(c.fen, 1);
    if (c.total !== e) bad2.push(`第${c.col}列 声明${c.total}≠实际${e}`);
    if (c.cards !== c.shown) bad2.push(`第${c.col}列 SVG里${c.cards}张≠说要摆${c.shown}张`);
    if (c.shown > c.total) bad2.push(`第${c.col}列 摆得比总数还多`);
  }
  if (bad2.length) colOk = false;
  record(colOk, '③ 每列「共 N 种走法」== count(该列局面, 1)，卡片数也对得上',
    bad2.length ? bad2.join('; ') : `5 列全对：${cols.map((c) => c.total).join('/')} 种，各摆 ${cols.map((c) => c.cards).join('/')} 张`);

  // 排序必须是真排序：第一名的分对行棋方不能比第二名差
  const sortOk = cols.every((c) => {
    const [a, b] = c.topScores;
    if (b === undefined) return true;
    return c.ply % 2 === 0 ? a >= b : a <= b;
  });
  record(sortOk, '③ 每列确实按「对行棋方好坏」排了序',
    cols.map((c) => `${c.topSans[0]}(${(c.topScores[0] / 100).toFixed(2)})>${c.topSans[1]}(${(c.topScores[1] / 100).toFixed(2)})`).join('　'));

  const initialRoute = await forkRouteDom();
  const initialRouteOk =
    initialRoute.length === cols.length
    && initialRoute.every((c) =>
      c.selectedCards === 1
      && c.selectedEdges === 1
      && c.routeUnderlays === 1
      && c.cardIdx === c.edgeIdx
      && c.strokeWidth > 2
      && c.continuous);
  record(
    initialRouteOk,
    '③ 每列各有一张选中卡、一条选中边和一条连续主干',
    initialRoute.map((c) =>
      `列${c.col} 卡/边/底=${c.selectedCards}/${c.selectedEdges}/${c.routeUnderlays}`
      + ` idx=${c.cardIdx}/${c.edgeIdx} 连续=${c.continuous}`).join('　'));

  // 用真实 CDP 点击另一张卡，右边的列必须跟着换。
  const switchBefore = await evalJs('window.__forkStats().map(c => c.chosenSan).join(" ")');
  const switchedByClick = await clickSelector('#fork g.card[data-col="0"][data-idx="2"]');
  const switchAfter = await evalJs('window.__forkStats().map(c => c.chosenSan).join(" ")');
  record(
    switchedByClick && switchBefore !== switchAfter,
    '③ 真实点击第一列另一条，后面几列真的跟着改',
    `${switchBefore}  →  ${switchAfter}`);

  // 展开与收起都走页面真实点击。卡片数取 SVG 现状，总数仍拿 Node count() 独立对撞。
  const collapsedBefore = await forkColumnDom(0);
  const firstColBeforeToggle = (await evalJs('window.__forkStats()'))[0];
  const totalFirst = count(firstColBeforeToggle.fen, 1);
  const selectedBeforeToggle = `${collapsedBefore.selectedRank}:${collapsedBefore.selectedSan}`;
  const openedByClick = await clickSelector('#fork g.more[data-col="0"]');
  const expandedDom = await forkColumnDom(0);
  record(
    openedByClick
      && expandedDom.cards === totalFirst
      && expandedDom.toggleExpanded === 'true'
      && expandedDom.toggleText.includes('收起')
      && `${expandedDom.selectedRank}:${expandedDom.selectedSan}` === selectedBeforeToggle,
    '③ 真实点「展开」后整列摊开，选中项不变',
    `卡片 ${collapsedBefore.cards}→${expandedDom.cards}/${totalFirst}`
      + `｜文案「${expandedDom.toggleText}」｜选中 ${expandedDom.selectedSan} #${expandedDom.selectedRank + 1}`);

  const closedByClick = await clickSelector('#fork g.more[data-col="0"]');
  const collapsedAgain = await forkColumnDom(0);
  record(
    closedByClick
      && collapsedAgain.cards === collapsedBefore.cards
      && collapsedAgain.toggleExpanded === 'false'
      && collapsedAgain.toggleText.includes('展开')
      && `${collapsedAgain.selectedRank}:${collapsedAgain.selectedSan}` === selectedBeforeToggle,
    '③ 再点「收起」回到推荐数量，选中项仍不变',
    `卡片 ${expandedDom.cards}→${collapsedAgain.cards}/${collapsedBefore.cards}`
      + `｜文案「${collapsedAgain.toggleText}」｜选中 ${collapsedAgain.selectedSan}`);

  // 展开后选择推荐 N 条之外的第一张：列应自动收起，但这张已选卡必须留在 DOM，
  // 且五列主干的 card / edge / underlay 仍一一接续。
  const openedAgain = await clickSelector('#fork g.more[data-col="0"]');
  const expandedStats = (await evalJs('window.__forkStats()'))[0];
  const outsideRank = expandedStats.baseShown;
  const outsideBefore = await evalJs(`(() => {
    const card = document.querySelector('#fork g.card[data-col="0"][data-idx="${outsideRank}"]');
    return card ? { san: card.dataset.san, rank: Number(card.dataset.idx) } : null;
  })()`);
  const historyBeforeOutside = await evalJs('window.__test.state().history');
  const outsideClicked = outsideBefore
    ? await clickSelector(`#fork g.card[data-col="0"][data-idx="${outsideRank}"]`)
    : false;
  const outsideAfter = await forkColumnDom(0);
  const outsideStats = (await evalJs('window.__forkStats()'))[0];
  const historyAfterOutside = await evalJs('window.__test.state().history');
  const outsideRoute = await forkRouteDom();
  const outsideRouteOk =
    outsideRoute.length === cols.length
    && outsideRoute.every((c) =>
      c.selectedCards === 1
      && c.selectedEdges === 1
      && c.routeUnderlays === 1
      && c.cardIdx === c.edgeIdx
      && c.continuous);
  record(
    openedAgain
      && outsideClicked
      && outsideStats.expanded === false
      && outsideAfter.indices.includes(outsideRank)
      && outsideAfter.selectedRank === outsideRank
      && outsideAfter.selectedSan === outsideBefore?.san
      && outsideAfter.cards === outsideStats.baseShown + 1
      && JSON.stringify(historyAfterOutside) === JSON.stringify(historyBeforeOutside)
      && outsideRouteOk,
    '③ 选推荐区外走法会自动收起，但已选卡与整条路径不断',
    `选 #${outsideRank + 1} ${outsideBefore?.san || '无卡'}｜收起后卡片 ${outsideAfter.cards}`
      + `｜仍在 DOM=${outsideAfter.indices.includes(outsideRank)}｜五列主干连续=${outsideRouteOk}`
      + `｜棋谱未变=${JSON.stringify(historyAfterOutside) === JSON.stringify(historyBeforeOutside)}`);

  // 7) 再走一个回合，让分叉图换一批局面重算，再对一次
  await evalJs(`window.__test.tryMove('d2','d4')`);
  for (let i = 0; i < 200 && !(await evalJs('window.__test.state().history.length >= 4')); i++) await sleep(50);
  await waitCloud();
  const cols2 = await evalJs('window.__forkStats()');
  const st3 = await evalJs('window.__test.state()');
  const bad3 = [];
  for (const c of cols2) {
    const e = count(c.fen, 1);
    if (c.total !== e) bad3.push(`第${c.col}列 ${c.total}≠${e}`);
    if (c.cards !== c.shown) bad3.push(`第${c.col}列 卡片数不符`);
  }
  record(bad3.length === 0 && cols2[0].fen === st3.fen,
    '③ 走满两回合后，分叉图重算的每列仍然对得上',
    bad3.length ? bad3.join('; ') : `棋谱 ${JSON.stringify(st3.history)}｜各列 ${cols2.map((c) => c.total).join('/')} 种`);

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  const SHOT2 = SHOT.replace(/\.png$/, '-line.png');
  fs.writeFileSync(SHOT2, Buffer.from(shot2.data, 'base64'));
  console.log(`走过两回合的截图: ${SHOT2}`);

  await runMobileChecks();

  record(pageErrors.length === 0, '页面无 JS 报错', pageErrors.slice(0, 3).join(' | ') || '零报错');

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0
    ? `全绿：${results.length}/${results.length} 项通过。`
    : `有红：${failed.length}/${results.length} 项失败 → ${failed.map((r) => r.label).join('; ')}`);

  try { ws.close(); } catch {}
  try { chromeProcess && chromeProcess.kill('SIGKILL'); } catch {}
  if (server) server.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验收脚本自己崩了:', e);
  console.error('页面报错记录:', pageErrors);
  try { ws && ws.close(); } catch {}
  try { chromeProcess && chromeProcess.kill('SIGKILL'); } catch {}
  try { server && server.close(); } catch {}
  process.exit(2);
});
