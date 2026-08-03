// live-check.mjs —— 无头 Chrome + CDP 真机验收（本地或线上都能跑）
// 用法：node live-check.mjs [--url https://...] [--shot out.png] [--port 9333] [--headed] [--phase-one-only|--phase-two-only|--phase-three-only]
// 默认自动选空闲 CDP/静态服务端口；只有需要并行复现某次运行时才显式传 --port。
// 不给 --url 就自己起一个静态服务器伺候 chess.html；线上可传站点根目录或 chess.html。
// --headed 使用本机 Chrome/GPU 做视觉复核；默认仍是 CI 同口径的 headless + SwiftShader。

import http from 'node:http';
import net from 'node:net';
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
let PORT = Number(arg('--port', '0'));
const SHOT = arg('--shot', path.join(os.tmpdir(), 'chess-cloud-shot.png'));
const HEADED = argv.includes('--headed');
const PHASE_ONE_ONLY = argv.includes('--phase-one-only');
const PHASE_TWO_ONLY = argv.includes('--phase-two-only');
const PHASE_THREE_ONLY = argv.includes('--phase-three-only');
let URL_ = arg('--url', null);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

let server = null, chromeProcess = null;
async function serveLocal() {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(ROOT, `.${rel === '/' ? '/index.html' : rel}`);
    const insideRoot = file === ROOT || file.startsWith(`${ROOT}${path.sep}`);
    if (!insideRoot || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/chess.html`;
}

function chessPageUrl(input) {
  const url = new URL(input);
  if (url.pathname.endsWith('/chess.html')) return url.href;
  if (url.pathname.endsWith('/index.html')) {
    url.pathname = url.pathname.replace(/index\.html$/, 'chess.html');
    return url.href;
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL('chess.html', url).href;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (used) => { socket.destroy(); resolve(used); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

// ─────────────────────────── CDP 最小客户端
let ws = null, nextId = 1;
const waiting = new Map();
const pageErrors = [];
let chromeDir = null;

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`CDP ${method} 超过 30 秒无响应`));
    }, 30000);
    waiting.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(error);
    }
  });
}

function rejectWaiting(error) {
  for (const pending of waiting.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  waiting.clear();
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
  chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-cloud-chrome-'));
  const chromeArgs = [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${chromeDir}`,
    '--window-size=1440,900',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    'about:blank',
  ];
  if (!HEADED) {
    // 无头下 WebGL：走 angle+swiftshader，别用 --disable-gpu（会出合成伪影/黑画布）
    chromeArgs.unshift('--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  }
  const p = spawn(bin, chromeArgs, { stdio: 'ignore', detached: false });
  for (let i = 0; i < 80; i++) {
    if (PORT === 0) {
      try {
        const active = fs.readFileSync(path.join(chromeDir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
        const actualPort = Number(active[0]);
        if (Number.isInteger(actualPort) && actualPort > 0) PORT = actualPort;
      } catch {}
    }
    try {
      if (PORT === 0) throw new Error('Chrome 尚未写出 DevToolsActivePort');
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
      clearTimeout(w.timer);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.text || '') + ' ' + String(m.params.exceptionDetails.exception?.description || ''));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push('console.error: ' + JSON.stringify(m.params.args.map((a) => a.value ?? a.description)));
    }
  };
  ws.onerror = () => rejectWaiting(new Error('CDP WebSocket 通信失败'));
  ws.onclose = () => rejectWaiting(new Error('CDP WebSocket 已关闭'));
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
  // 取样区不再靠猜布局：直接问页面要路径网 canvas 的真实矩形（getBoundingClientRect），
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

// 用“正常路径网 - 隐藏 cloudGroup”取得真实 canvas 像素差。
// DOM/geometry 断言能证明线段存在；这份差分继续证明用户真的看得见它们。
function cloudPathPixelDiff(normalFile, hiddenFile, rect, minDelta = 18) {
  const normal = decodePng(fs.readFileSync(normalFile));
  const hidden = decodePng(fs.readFileSync(hiddenFile));
  if (normal.w !== hidden.w || normal.h !== hidden.h || normal.ch !== hidden.ch) {
    throw new Error('路径网像素对照图尺寸不一致');
  }
  const x0 = Math.max(0, Math.round(rect.x) + 4);
  const x1 = Math.min(normal.w, Math.round(rect.x + rect.w) - 4);
  const y0 = Math.max(0, Math.round(rect.y) + 4);
  const y1 = Math.min(normal.h, Math.round(rect.y + rect.h) - 4);
  let total = 0, changed = 0, warm = 0, cold = 0;
  let minX = x1, maxX = x0 - 1, minY = y1, maxY = y0 - 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * normal.w + x) * normal.ch;
      const delta =
        Math.abs(normal.px[o] - hidden.px[o])
        + Math.abs(normal.px[o + 1] - hidden.px[o + 1])
        + Math.abs(normal.px[o + 2] - hidden.px[o + 2]);
      total++;
      if (delta < minDelta) continue;
      changed++;
      const dr = normal.px[o] - hidden.px[o];
      const db = normal.px[o + 2] - hidden.px[o + 2];
      if (dr > db + 2) warm++;
      else if (db > dr + 2) cold++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  return {
    changed,
    total,
    changedRatio: +(changed / Math.max(1, total)).toFixed(5),
    spanX: changed ? +((maxX - minX + 1) / width).toFixed(4) : 0,
    spanY: changed ? +((maxY - minY + 1) / height).toFixed(4) : 0,
    warm,
    cold,
    warmOfChanged: +(warm / Math.max(1, changed)).toFixed(4),
    coldOfChanged: +(cold / Math.max(1, changed)).toFixed(4),
  };
}

function edgeStats(file, cssW, cssH, excludeTop = false) {
  const { w, h, ch, px } = decodePng(fs.readFileSync(file));
  const scale = Math.min(w / cssW, h / cssH);
  const band = Math.max(2, Math.round(7 * scale));
  let total = 0, dark = 0, light = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onEdge =
        x < band
        || x >= w - band
        || y >= h - band
        || (!excludeTop && y < band);
      if (!onEdge) continue;
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

function expectedBoardPieces(fen) {
  const board = new Chess(fen).board();
  const files = 'abcdefgh';
  const out = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (piece) out.push({ sq: `${files[f]}${8 - r}`, color: piece.color, type: piece.type });
    }
  }
  return out.sort((a, b) => a.sq.localeCompare(b.sq));
}

function renderedPiecesMatchFen(pieces, fen) {
  if (!Array.isArray(pieces) || !fen) return false;
  const actual = pieces
    .map(({ sq, color, type }) => ({ sq, color, type }))
    .sort((a, b) => a.sq.localeCompare(b.sq));
  return JSON.stringify(actual) === JSON.stringify(expectedBoardPieces(fen));
}

function auditChessReplyOptions(fen, options) {
  const problems = [];
  let legal = [];
  try {
    const game = new Chess(fen);
    legal = game.moves({ verbose: true }).map((move) => ({
      key: `${move.from}-${move.to}-${move.promotion || ''}`,
      from: move.from,
      to: move.to,
      promotion: move.promotion || '',
      afterFen: move.after,
      branchCount: count(move.after, 1),
    }));
  } catch (error) {
    return { ok: false, legalCount: 0, problems: [`回应根 FEN 无法解析：${error?.message || error}`] };
  }
  const expected = new Map(legal.map((move) => [move.key, move]));
  const seen = new Set();
  for (const option of options || []) {
    const key = `${option.from}-${option.to}-${option.promotion || ''}`;
    const truth = expected.get(key);
    if (!truth) problems.push(`DOM 含非法回应 ${key}`);
    if (seen.has(key)) problems.push(`DOM 回应重复 ${key}`);
    seen.add(key);
    if (truth && option.afterFen !== truth.afterFen) problems.push(`${key} after FEN 不同源`);
    if (truth && option.branchCount !== truth.branchCount) {
      problems.push(`${key} 走后分叉 ${option.branchCount}≠${truth.branchCount}`);
    }
  }
  if ((options || []).length !== legal.length) {
    problems.push(`DOM ${options?.length || 0} 条≠棋核 ${legal.length} 条`);
  }
  for (const key of expected.keys()) {
    if (!seen.has(key)) problems.push(`DOM 漏回应 ${key}`);
  }
  return { ok: problems.length === 0, legalCount: legal.length, problems };
}

function auditPrincipalVariation(fen, result) {
  const problems = [];
  const pv = Array.isArray(result?.pv) ? result.pv : [];
  if (!result || !Array.isArray(result.pv)) {
    return { ok: false, problems: ['pv 不是数组'], replayFen: fen, terminal: false };
  }
  if (result.depth === 0 && pv.length !== 0) {
    problems.push(`depth=0 却给了 ${pv.length} 手主变`);
  }
  if (result.depth > 0 && pv.length === 0) {
    problems.push(`depth=${result.depth} 却没有主变`);
  }
  if (pv.length > result.depth) {
    problems.push(`主变 ${pv.length} 手 > 完成深度 ${result.depth}`);
  }
  if (pv.length) {
    const first = pv[0];
    if (
      first.from !== result.move?.from
      || first.to !== result.move?.to
      || (first.promotion || '') !== (result.move?.promotion || '')
      || first.san !== result.san
    ) {
      problems.push('pv[0] 与 search.move/search.san 不同源');
    }
  }
  const replay = new Chess(fen);
  for (let index = 0; index < pv.length; index++) {
    const step = pv[index];
    const legal = replay.moves({ verbose: true }).find((move) =>
      move.from === step?.from
      && move.to === step?.to
      && (move.promotion || '') === (step?.promotion || ''));
    if (!legal) {
      problems.push(`PV 第 ${index + 1} 手非法 ${step?.from}-${step?.to}`);
      break;
    }
    if (legal.san !== step.san) {
      problems.push(`PV 第 ${index + 1} 手 SAN ${step.san}≠${legal.san}`);
    }
    if (legal.after !== step.after) {
      problems.push(`PV 第 ${index + 1} 手 after FEN 不同源`);
    }
    replay.move({
      from: legal.from,
      to: legal.to,
      ...(legal.promotion ? { promotion: legal.promotion } : {}),
    });
    if (replay.fen() !== step.after) {
      problems.push(`PV 第 ${index + 1} 手重放 FEN 不一致`);
    }
  }
  if (result.depth > 0 && pv.length < result.depth && !replay.isGameOver()) {
    problems.push(`非终局 PV ${pv.length} 手 < 完成深度 ${result.depth}`);
  }
  return {
    ok: problems.length === 0,
    problems,
    replayFen: replay.fen(),
    terminal: replay.isGameOver(),
  };
}

function auditBoardDom(snapshot) {
  const actual = snapshot.pieces
    .map(({ sq, color, type }) => ({ sq, color, type }))
    .sort((a, b) => a.sq.localeCompare(b.sq));
  const expected = expectedBoardPieces(snapshot.fen);
  const exactFen = JSON.stringify(actual) === JSON.stringify(expected);
  const colorCounts = { w: 0, b: 0 };
  const typeCounts = { w: {}, b: {} };
  for (const piece of snapshot.pieces) {
    colorCounts[piece.color] = (colorCounts[piece.color] || 0) + 1;
    typeCounts[piece.color][piece.type] = (typeCounts[piece.color][piece.type] || 0) + 1;
  }
  const initialProfile = colorCounts.w === 16 && colorCounts.b === 16
    && ['w', 'b'].every((color) =>
      typeCounts[color].p === 8
      && typeCounts[color].r === 2
      && typeCounts[color].n === 2
      && typeCounts[color].b === 2
      && typeCounts[color].q === 1
      && typeCounts[color].k === 1);

  const geometryByType = new Map();
  for (const piece of snapshot.pieces) {
    if (!geometryByType.has(piece.type)) geometryByType.set(piece.type, new Set());
    geometryByType.get(piece.type).add(piece.geometry);
  }
  const sameGeometryAcrossColors =
    geometryByType.size === 6
    && [...geometryByType.values()].every((signatures) => signatures.size === 1);
  const sixDistinctModels =
    new Set([...geometryByType.values()].map((signatures) => [...signatures][0])).size === 6;
  const templateTypes = snapshot.templates.map((template) => template.type).sort().join('');
  const templateGeometry = new Map(snapshot.templates.map((template) => [template.type, template.geometry]));
  const instancesMatchTemplates = snapshot.pieces.every(
    (piece) => piece.geometry === templateGeometry.get(piece.type),
  );
  const layeredTemplates =
    templateTypes === 'bknpqr'
    && snapshot.templates.every((template) => template.parts >= 6)
    && snapshot.pieces.every((piece) => piece.parts >= 6);
  const templateDepthRoles = snapshot.templates.every(
    (template) =>
      template.sideParts >= 1
      && template.shineParts >= 1
      && template.groundShadows === 1,
  );

  const whiteMaterials = new Set(snapshot.pieces.filter((p) => p.color === 'w').map((p) => p.material));
  const blackMaterials = new Set(snapshot.pieces.filter((p) => p.color === 'b').map((p) => p.material));
  const materialOk =
    whiteMaterials.size === 1
    && blackMaterials.size === 1
    && [...whiteMaterials][0]
    && [...blackMaterials][0]
    && [...whiteMaterials][0] !== [...blackMaterials][0];

  const cell = snapshot.boardRect.w / 8;
  const boundsOk = snapshot.pieces.every((piece) => {
    const file = piece.sq.charCodeAt(0) - 97;
    const row = 8 - Number(piece.sq[1]);
    const left = snapshot.boardRect.x + file * cell;
    const top = snapshot.boardRect.y + row * cell;
    return piece.rect.w >= cell * .34
      && piece.rect.h >= cell * .48
      && piece.rect.x >= left - 1
      && piece.rect.y >= top - 1
      && piece.rect.right <= left + cell + 1
      && piece.rect.bottom <= top + cell + 1;
  });

  return {
    exactFen,
    initialProfile,
    sameGeometryAcrossColors,
    sixDistinctModels,
    instancesMatchTemplates,
    layeredTemplates,
    templateDepthRoles,
    materialOk,
    boundsOk,
    colorCounts,
    typeCounts,
    actual,
    expected,
  };
}

function auditExplorerPreview(snapshot) {
  const actual = (snapshot?.previewPieces || [])
    .map(({ sq, color, type }) => ({ sq, color, type }))
    .sort((a, b) => a.sq.localeCompare(b.sq));
  const expected = expectedBoardPieces(snapshot.renderedFen);
  const cell = snapshot.boardRect.w / 8;
  const boundsOk = snapshot.previewPieces.every((piece) => {
    const file = piece.sq.charCodeAt(0) - 97;
    const row = 8 - Number(piece.sq[1]);
    const left = snapshot.boardRect.x + file * cell;
    const top = snapshot.boardRect.y + row * cell;
    return piece.rect.w >= cell * .34
      && piece.rect.h >= cell * .48
      && piece.rect.x >= left - 1
      && piece.rect.y >= top - 1
      && piece.rect.right <= left + cell + 1
      && piece.rect.bottom <= top + cell + 1;
  });
  const whiteMaterials = new Set(
    snapshot.previewPieces.filter((piece) => piece.color === 'w').map((piece) => piece.material),
  );
  const blackMaterials = new Set(
    snapshot.previewPieces.filter((piece) => piece.color === 'b').map((piece) => piece.material),
  );
  const geometryByType = new Map();
  for (const piece of snapshot.previewPieces) {
    if (!geometryByType.has(piece.type)) geometryByType.set(piece.type, new Set());
    geometryByType.get(piece.type).add(piece.geometry);
  }
  return {
    exactFen: JSON.stringify(actual) === JSON.stringify(expected),
    actualCount: actual.length,
    expectedCount: expected.length,
    boundsOk,
    vector3d:
      snapshot.renderModes.length === 1
      && snapshot.renderModes[0] === 'vector-3d',
    materialOk:
      whiteMaterials.size === 1
      && blackMaterials.size === 1
      && [...whiteMaterials][0]
      && [...blackMaterials][0]
      && [...whiteMaterials][0] !== [...blackMaterials][0],
    sixModels:
      geometryByType.size === 6
      && [...geometryByType.values()].every((shapes) => shapes.size === 1),
  };
}

function fenTurnContext(fen) {
  const fields = String(fen || '').trim().split(/\s+/);
  const side = fields[1];
  const fullmove = Number(fields[5]);
  if ((side !== 'w' && side !== 'b') || !Number.isInteger(fullmove) || fullmove < 1) {
    throw new Error(`无效 FEN 回合字段：${fen}`);
  }
  const completedPly = (fullmove - 1) * 2 + (side === 'b' ? 1 : 0);
  return {
    side,
    sideLabel: side === 'w' ? '白方' : '黑方',
    fullmove,
    completedPly,
    absolutePly: completedPly + 1,
  };
}

function auditTree2d(snapshot) {
  const problems = [];
  let nodeCount = 0;
  if (!snapshot?.rootFen) return { ok: false, problems: ['没有根 FEN'], nodeCount };
  if (snapshot.rootFen !== snapshot.gameFen) {
    problems.push('树根 FEN 不是当前实战 FEN');
  }
  try {
    const expectedRootContext = fenTurnContext(snapshot.rootFen);
    const actualRootContext = snapshot.rootContext || {};
    if (
      actualRootContext.completedPly !== expectedRootContext.completedPly
      || actualRootContext.fullmove !== expectedRootContext.fullmove
      || actualRootContext.side !== expectedRootContext.side
      || !actualRootContext.text?.includes(`已走 ${expectedRootContext.completedPly} 手`)
      || !actualRootContext.text?.includes(`第 ${expectedRootContext.fullmove} 回合`)
      || !actualRootContext.text?.includes(expectedRootContext.sideLabel)
    ) {
      problems.push(
        `根回合显示不是 FEN 实值：${JSON.stringify(actualRootContext)}`
        + `，应为已走${expectedRootContext.completedPly}手/第${expectedRootContext.fullmove}回合/${expectedRootContext.sideLabel}`,
      );
    }
  } catch (error) {
    problems.push(`根回合字段无法验：${error.message}`);
  }
  const expectedRoot = count(snapshot.rootFen, 1);
  if (snapshot.rootCount !== expectedRoot) {
    problems.push(`根分支 ${snapshot.rootCount}≠${expectedRoot}`);
  }
  for (const level of snapshot.levels || []) {
    const expectedParent =
      level.depth === 1
        ? snapshot.rootFen
        : snapshot.path[level.depth - 2]?.after;
    if (level.parentFen !== expectedParent) {
      problems.push(`L${level.depth} 父 FEN 没接上`);
    }
    try {
      const expectedTurn = fenTurnContext(level.parentFen);
      if (
        level.relativeDepth !== level.depth
        || level.absolutePly !== expectedTurn.absolutePly
        || level.fullmove !== expectedTurn.fullmove
        || level.side !== expectedTurn.side
        || !level.heading.includes(`第 ${expectedTurn.fullmove} 回合`)
        || !level.heading.includes(`${expectedTurn.sideLabel}走`)
        || !level.heading.includes(`未来第 ${level.depth} 步`)
      ) {
        problems.push(
          `L${level.depth} 回合显示=${level.heading || '空'}`
          + ` / rel=${level.relativeDepth} abs=${level.absolutePly}`
          + ` fullmove=${level.fullmove} side=${level.side}`,
        );
      }
    } catch (error) {
      problems.push(`L${level.depth} 回合字段无法验：${error.message}`);
    }
    let expectedCards = null;
    try {
      const parent = new Chess(level.parentFen);
      const legal = parent.moves({ verbose: true });
      expectedCards = count(level.parentFen, 1);
      const expectedMoveSet = legal.map((move) =>
        `${move.from}:${move.to}:${move.promotion || ''}:${move.san}:${move.after}`).sort();
      const actualMoveSet = level.cards.map((node) =>
        `${node.from}:${node.to}:${node.promotion || ''}:${node.san}:${node.after}`).sort();
      if (JSON.stringify(actualMoveSet) !== JSON.stringify(expectedMoveSet)) {
        problems.push(`L${level.depth} 节点集合有重复、遗漏或伪造走法`);
      }
    } catch (error) {
      problems.push(`L${level.depth} 父 FEN 无法计数：${error.message}`);
    }
    if (
      expectedCards !== null
      && (level.cardCount !== expectedCards || level.claimedTotal !== expectedCards)
    ) {
      problems.push(
        `L${level.depth} DOM/标题/合法数=${level.cardCount}/${level.claimedTotal}/${expectedCards}`,
      );
    }
    if (level.edgeCount !== level.cardCount) {
      problems.push(`L${level.depth} 入边/卡片=${level.edgeCount}/${level.cardCount}`);
    }
    const shouldSelect = level.depth <= snapshot.path.length ? 1 : 0;
    if (level.selectedCards !== shouldSelect || level.selectedEdges !== shouldSelect) {
      problems.push(
        `L${level.depth} 选中卡/边=${level.selectedCards}/${level.selectedEdges}，应为 ${shouldSelect}`,
      );
    }
    if (shouldSelect) {
      const selected = level.cards.find((node) => node.selected);
      const step = snapshot.path[level.depth - 1];
      if (
        !selected
        || !step
        || selected.after !== step.after
        || selected.from !== step.from
        || selected.to !== step.to
        || selected.san !== step.san
        || selected.edgeSelected !== true
      ) {
        problems.push(`L${level.depth} 高亮节点/入边不是主路径对应走法`);
      }
    }
    for (const node of level.cards) {
      nodeCount++;
      if (node.parentFen !== level.parentFen || node.depth !== level.depth) {
        problems.push(`L${level.depth} ${node.san} 的父 FEN/层号错误`);
      }
      if (node.visible && (!node.badgeVisible || !node.edgeVisible)) {
        problems.push(
          `L${level.depth} ${node.san} 可见卡的分叉徽章/入边不可见=${node.badgeVisible}/${node.edgeVisible}`,
        );
      }
      try {
        const replay = new Chess(node.parentFen);
        const played = replay.move({
          from: node.from,
          to: node.to,
          ...(node.promotion ? { promotion: node.promotion } : {}),
        });
        if (!played || played.san !== node.san || replay.fen() !== node.after) {
          problems.push(`L${level.depth} ${node.san} 的 SAN/FEN 不能独立重放`);
        }
        const expectedBranches = count(node.after, 1);
        if (
          node.branchCount !== expectedBranches
          || !node.branchText.includes(String(expectedBranches))
        ) {
          problems.push(
            `L${level.depth} ${node.san} 走后分支 ${node.branchCount}≠${expectedBranches}`,
          );
        }
      } catch (error) {
        problems.push(`L${level.depth} ${node.san} 重放异常：${error.message}`);
      }
    }
  }
  if (snapshot.full && snapshot.path.length > 0) {
    if (snapshot.pathConnectors.length !== snapshot.path.length) {
      problems.push(
        `连续主干 ${snapshot.pathConnectors.length} 段，应为路径 ${snapshot.path.length} 段`,
      );
    }
    for (let index = 0; index < snapshot.path.length; index++) {
      const depth = index + 1;
      const step = snapshot.path[index];
      const connector = snapshot.pathConnectors.find((link) => link.depth === depth);
      const selected = snapshot.levels
        .find((level) => level.depth === depth)
        ?.cards.find((node) => node.selected);
      const source = depth === 1
        ? snapshot.rootRect
        : snapshot.levels
          .find((level) => level.depth === depth - 1)
          ?.cards.find((node) => node.selected)?.rect;
      const expectedFromFen = depth === 1 ? snapshot.rootFen : snapshot.path[index - 1].after;
      const close = (actual, expected) =>
        Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 2;
      if (
        !connector
        || !connector.drawn
        || connector.fromFen !== expectedFromFen
        || connector.toFen !== step.after
        || !source
        || !selected
        || !close(connector.from.x, source.x + source.w / 2)
        || !close(connector.from.y, source.bottom)
        || !close(connector.to.x, selected.rect.x + selected.rect.w / 2)
        || !close(connector.to.y, selected.rect.y)
      ) {
        problems.push(`主路径第 ${depth} 段没有从上一节点连续画到选中节点`);
      }
    }
  }
  const frontierCount = snapshot.levels.at(-1)?.cardCount || 0;
  if (
    snapshot.mode === '2d'
    && (
      !snapshot.hud.stats.includes(`已选 ${snapshot.path.length} 步`)
      || !snapshot.hud.stats.includes(`当前层 ${frontierCount} 个可选分支`)
      || !snapshot.hud.count.includes(`${frontierCount}`)
    )
  ) {
    problems.push(`2D HUD 没有同步路径 ${snapshot.path.length} / 当前层 ${frontierCount}`);
  }
  try {
    const replay = new Chess(snapshot.rootFen);
    for (const step of snapshot.path) {
      const played = replay.move({
        from: step.from,
        to: step.to,
        ...(step.promotion ? { promotion: step.promotion } : {}),
      });
      if (!played || played.san !== step.san || replay.fen() !== step.after) {
        problems.push(`主路径第 ${step.depth} 步没有连续接上`);
        break;
      }
    }
    if (replay.fen() !== snapshot.renderedFen) {
      problems.push('树的 renderedFen 与主路径重放不一致');
    }
  } catch (error) {
    problems.push(`主路径重放异常：${error.message}`);
  }
  return { ok: problems.length === 0, problems, nodeCount };
}

function explorerPreviewOk(audit) {
  return audit.exactFen
    && audit.boundsOk
    && audit.vector3d
    && audit.materialOk
    && audit.sixModels;
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// 用“正常截图 - 隐藏棋子层截图”取得真实像素掩膜，避免只相信 DOM 上写了什么颜色。
function boardPiecePixelStats(normalFile, blankFile, snapshot, viewport) {
  const normal = decodePng(fs.readFileSync(normalFile));
  const blank = decodePng(fs.readFileSync(blankFile));
  if (normal.w !== blank.w || normal.h !== blank.h || normal.ch !== blank.ch) {
    throw new Error('棋盘像素对照图尺寸不一致');
  }
  const sx = normal.w / viewport.w;
  const sy = normal.h / viewport.h;
  const cellW = snapshot.boardRect.w / 8;
  const cellH = snapshot.boardRect.h / 8;
  const pieces = [];
  const allByColor = { w: [], b: [] };
  const UPPER_REGION_RATIO = .68; // 排除 y≈36 之后六类共有的底座，只看真正区分棋种的上半身。
  for (const piece of snapshot.pieces) {
    const file = piece.sq.charCodeAt(0) - 97;
    const row = 8 - Number(piece.sq[1]);
    const x0 = Math.max(0, Math.floor((snapshot.boardRect.x + file * cellW + cellW * .03) * sx));
    const x1 = Math.min(normal.w, Math.ceil((snapshot.boardRect.x + (file + 1) * cellW - cellW * .03) * sx));
    const y0 = Math.max(0, Math.floor((snapshot.boardRect.y + row * cellH + cellH * .02) * sy));
    const y1 = Math.min(normal.h, Math.ceil((snapshot.boardRect.y + (row + 1) * cellH - cellH * .02) * sy));
    const luminance = [];
    const maskW = Math.max(1, x1 - x0);
    const maskH = Math.max(1, y1 - y0);
    const mask = new Uint8Array(maskW * maskH);
    const upperRows = Math.max(1, Math.floor(maskH * UPPER_REGION_RATIO));
    let minVisibleY = maskH, maxVisibleY = -1, upperPixels = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * normal.w + x) * normal.ch;
        const delta =
          Math.abs(normal.px[o] - blank.px[o])
          + Math.abs(normal.px[o + 1] - blank.px[o + 1])
          + Math.abs(normal.px[o + 2] - blank.px[o + 2]);
        if (delta < 30) continue;
        const localY = y - y0;
        mask[localY * maskW + (x - x0)] = 1;
        minVisibleY = Math.min(minVisibleY, localY);
        maxVisibleY = Math.max(maxVisibleY, localY);
        if (localY < upperRows) upperPixels++;
        const lum = normal.px[o] * .2126 + normal.px[o + 1] * .7152 + normal.px[o + 2] * .0722;
        luminance.push(lum);
        allByColor[piece.color].push(lum);
      }
    }
    const cropArea = Math.max(1, (x1 - x0) * (y1 - y0));
    pieces.push({
      sq: piece.sq,
      color: piece.color,
      type: piece.type,
      pixels: luminance.length,
      coverage: luminance.length / cropArea,
      p10: quantile(luminance, .1),
      median: quantile(luminance, .5),
      p90: quantile(luminance, .9),
      visibleHeightRatio: maxVisibleY >= minVisibleY
        ? (maxVisibleY - minVisibleY + 1) / maskH
        : 0,
      upperCoverage: upperPixels / Math.max(1, maskW * upperRows),
      mask,
      maskW,
      maskH,
    });
  }
  const white = quantile(allByColor.w, .5);
  const black = quantile(allByColor.b, .5);
  const whitePieces = pieces.filter((piece) => piece.color === 'w');
  const blackPieces = pieces.filter((piece) => piece.color === 'b');
  const byType = ['p', 'r', 'n', 'b', 'q', 'k'].map((type) => {
    const whiteType = whitePieces.filter((piece) => piece.type === type).map((piece) => piece.median);
    const blackType = blackPieces.filter((piece) => piece.type === type).map((piece) => piece.median);
    const whiteMedian = quantile(whiteType, .5);
    const blackMedian = quantile(blackType, .5);
    return {
      type,
      white: whiteMedian,
      black: blackMedian,
      gap: whiteType.length && blackType.length ? whiteMedian - blackMedian : Infinity,
    };
  });
  const SHAPE_GRID = 18;
  const SHAPE_ROWS = 15; // 只比上方轮廓，避开六类共有的底座。
  const shapeVector = (piece) => {
    const vector = [];
    for (let gy = 0; gy < SHAPE_ROWS; gy++) {
      const y0 = Math.floor(gy * piece.maskH / SHAPE_GRID);
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * piece.maskH / SHAPE_GRID));
      for (let gx = 0; gx < SHAPE_GRID; gx++) {
        const x0 = Math.floor(gx * piece.maskW / SHAPE_GRID);
        const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * piece.maskW / SHAPE_GRID));
        let on = 0, total = 0;
        for (let y = y0; y < Math.min(y1, piece.maskH); y++) {
          for (let x = x0; x < Math.min(x1, piece.maskW); x++) {
            on += piece.mask[y * piece.maskW + x];
            total++;
          }
        }
        vector.push(on / Math.max(1, total));
      }
    }
    return vector;
  };
  const shapeStats = (colorPieces) => {
    const typeShapes = new Map();
    for (const type of ['p', 'r', 'n', 'b', 'q', 'k']) {
      const vectors = colorPieces.filter((piece) => piece.type === type).map(shapeVector);
      if (!vectors.length) continue;
      typeShapes.set(type, vectors[0].map((_, i) =>
        vectors.reduce((sum, vector) => sum + vector[i], 0) / vectors.length));
    }
    const shapePairs = [];
    const shapeEntries = [...typeShapes.entries()];
    for (let i = 0; i < shapeEntries.length; i++) {
      for (let j = i + 1; j < shapeEntries.length; j++) {
        const [aType, a] = shapeEntries[i], [bType, b] = shapeEntries[j];
        const distance = a.reduce((sum, value, k) => sum + Math.abs(value - b[k]), 0) / a.length;
        shapePairs.push({ types: `${aType}/${bType}`, distance });
      }
    }
    shapePairs.sort((a, b) => a.distance - b.distance);
    return {
      typeCount: typeShapes.size,
      minDistance: shapePairs[0]?.distance || 0,
      closestTypes: shapePairs[0]?.types || '',
    };
  };
  const whiteShape = shapeStats(whitePieces);
  const blackShape = shapeStats(blackPieces);
  return {
    white,
    black,
    gap: white - black,
    minWhiteMedian: Math.min(...whitePieces.map((piece) => piece.median)),
    maxBlackMedian: Math.max(...blackPieces.map((piece) => piece.median)),
    minTypeGap: Math.min(...byType.map((row) => row.gap)),
    byType,
    whiteShape,
    blackShape,
    minVisibleHeightRatio: Math.min(...pieces.map((piece) => piece.visibleHeightRatio)),
    minUpperCoverage: Math.min(...pieces.map((piece) => piece.upperCoverage)),
    minCoverage: Math.min(...pieces.map((piece) => piece.coverage)),
    minToneRange: Math.min(...pieces.map((piece) => piece.p90 - piece.p10)),
    pieces: pieces.map(({ mask, maskW, maskH, ...piece }) => piece),
  };
}

// ─────────────────────────── 验收
const EXPECTED_RESULTS = 115;
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
    if (last?.error) throw new Error(`路径网 Worker 报错: ${last.error}`);
    if (last && last.growing === false && last.depth >= 4) return last;
    await sleep(400);
  }
  throw new Error('等路径网长满超时，最后状态: ' + JSON.stringify(last));
}

async function waitCloudPreview(timeoutMs = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await evalJs('typeof window.__cloudStats === "function" ? window.__cloudStats() : null');
    if (last?.error) throw new Error(`路径网 Worker 报错: ${last.error}`);
    if (
      last
      && last.growing === false
      && last.depth === 3
      && last.deepPending === true
      && hasExactCloudDepths(last, 3)
      && !last.layers.some((layer) => layer.depth === 4)
    ) return last;
    await sleep(80);
  }
  throw new Error('等路径网缩略态稳定超时，最后状态: ' + JSON.stringify(last));
}

async function openCloudAndWait(timeoutMs = 90000, useTouch = false) {
  const alreadyFull = await evalJs('document.body.classList.contains("cloud-full")');
  if (!alreadyFull) {
    const opened = useTouch
      ? await touchSelector('#cloudOpen')
      : await clickSelector('#cloudOpen');
    if (!opened) throw new Error('找不到「放大探索」按钮');
  }
  return waitCloud(timeoutMs);
}

async function closeCloudAndWaitPreview(useTouch = false) {
  const full = await evalJs('document.body.classList.contains("cloud-full")');
  if (full) {
    const closed = useTouch
      ? await touchSelector('#cloudClose')
      : await clickSelector('#cloudClose');
    if (!closed) throw new Error('找不到「收起」按钮');
  }
  return waitCloudPreview();
}

async function waitCloudRenderIdle(timeoutMs = 5000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const first = await evalJs('({ raf: window.__rafAudit.read(), render: window.__test.renderStats() })');
    if (first.raf.pending === 0 && first.render.scheduled === false) {
      await sleep(160);
      const second = await evalJs('({ raf: window.__rafAudit.read(), render: window.__test.renderStats() })');
      const cameraStable = first.render.cameraMatrix.every(
        (value, index) => Math.abs(value - second.render.cameraMatrix[index]) <= 1e-7,
      );
      if (
        second.raf.pending === 0
        && second.render.scheduled === false
        && second.render.rendererFrame === first.render.rendererFrame
        && cameraStable
      ) return second;
      last = second;
    } else {
      last = first;
      await sleep(80);
    }
  }
  throw new Error(`路径网未进入静止态: ${JSON.stringify(last)}`);
}

function hasExactCloudDepths(stats, maxDepth) {
  const actual = stats?.layers?.map((layer) => layer.depth) || [];
  const expected = Array.from({ length: maxDepth + 1 }, (_, depth) => depth);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function checkNodesMatchCount(stats, tag) {
  const actualDepths = stats.layers.map((layer) => layer.depth);
  const expectedDepths = Array.from({ length: stats.depth + 1 }, (_, depth) => depth);
  record(
    hasExactCloudDepths(stats, stats.depth),
    `①${tag} 路径网层集合完整且连续`,
    `页面 ${JSON.stringify(actualDepths)} vs 应有 ${JSON.stringify(expectedDepths)}`);
  // ① __cloudStats().nodes 与 count(同 fen 同 depth) 完全相等
  const expect = count(stats.fen, stats.depth);
  record(stats.nodes === expect,
    `①${tag} __cloudStats().nodes == count(fen, ${stats.depth})`,
    `页面 ${stats.nodes} vs verify.mjs count() ${expect}｜fen=${stats.fen}`);
  // 顺手把每一层都对一遍，比只对最深一层狠
  for (const l of stats.layers) {
    const e = count(stats.fen, l.depth);
    record(l.nodes === e, `①${tag} 第 ${l.depth} 层路径边数`, `页面 ${l.nodes} vs count() ${e}`);
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

async function clickSelectorHit(selector) {
  const quoted = JSON.stringify(selector);
  for (let attempt = 0; attempt < 2; attempt++) {
    const center = await selectorCenter(selector);
    if (!center) return false;
    const hit = await evalJs(`(() => {
      const expected = document.querySelector(${quoted});
      const actual = document.elementFromPoint(${center.x}, ${center.y});
      return !!expected && actual?.closest('button') === expected;
    })()`);
    if (!hit) continue;
    await clickAt(center.x, center.y);
    await settleLayout();
    return true;
  }
  return false;
}

async function touchSelector(selector) {
  const center = await selectorCenter(selector);
  if (!center) return false;
  await touchAt(center.x, center.y);
  await sleep(100);
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

async function runCoachChecks() {
  // ⑥-1 真触摸棋子：先在 390px 手机上做，确认这不是只有测试钩子能触发的影子状态。
  await evalJs('window.__test.reset()');
  await setViewport(390, 844, 'portraitPrimary');
  const coachStateBeforeTouch = await evalJs('window.__test.state()');
  const touchedPiece = await touchSelector('#boardSquares rect[data-sq="e2"]');
  await evalJs('document.getElementById("coachPanel").scrollIntoView({ block: "center" })');
  await settleLayout();
  const mobileCoach = await evalJs(`(() => {
    const coach = window.__test.coach();
    const panel = document.getElementById('coachPanel');
    const r = panel.getBoundingClientRect();
    const cards = [...panel.querySelectorAll('button.coach-card')].map((card) => {
      const b = card.getBoundingClientRect();
      return { w: b.width, h: b.height };
    });
    const root = document.documentElement;
    return {
      coach,
      state: window.__test.state(),
      panel: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height },
      cardBoxes: cards,
      viewport: { w: innerWidth, h: innerHeight },
      rootW: { client: root.clientWidth, scroll: root.scrollWidth },
    };
  })()`);
  const minMobileCoachCardH = mobileCoach.cardBoxes.length
    ? Math.min(...mobileCoach.cardBoxes.map((box) => box.h))
    : 0;
  record(
    touchedPiece
      && mobileCoach.coach.selected === 'e2'
      && mobileCoach.coach.state === 'ready'
      && mobileCoach.coach.cardCount > 0
      && mobileCoach.state.fen === coachStateBeforeTouch.fen
      && JSON.stringify(mobileCoach.state.history) === JSON.stringify(coachStateBeforeTouch.history)
      && mobileCoach.panel.left >= -1
      && mobileCoach.panel.right <= mobileCoach.viewport.w + 1
      && mobileCoach.panel.bottom > 0
      && mobileCoach.panel.top < mobileCoach.viewport.h
      && mobileCoach.cardBoxes.length === mobileCoach.coach.cardCount
      && mobileCoach.cardBoxes.every((box) => box.h >= 43.9 && box.w > 0)
      && mobileCoach.rootW.scroll <= mobileCoach.rootW.client + 1,
    '⑥ 真实触摸白棋会打开手机可用的棋子助手，且不改变 FEN',
    `selected=${mobileCoach.coach.selected}｜state=${mobileCoach.coach.state}`
      + `｜候选 ${mobileCoach.coach.cardCount}｜panel x=${Math.round(mobileCoach.panel.left)}..${Math.round(mobileCoach.panel.right)}`
      + `｜最小卡高 ${minMobileCoachCardH.toFixed(1)}`
      + `｜history=${JSON.stringify(mobileCoach.state.history)}`);

  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();

  const coach = await evalJs('window.__test.coach()');
  const legalMoves = new Chess(coach.fen).moves({ square: coach.selected, verbose: true });
  const legalByKey = new Map(legalMoves.map((move) => [
    `${move.from}:${move.to}:${move.promotion || ''}`,
    move,
  ]));
  const candidateProblems = [];
  for (const card of coach.cards) {
    const legal = legalByKey.get(`${card.from}:${card.to}:${card.promotion || ''}`);
    if (!legal) candidateProblems.push(`${card.san} 不是 ${coach.selected} 的合法走法`);
    else {
      if (legal.san !== card.san) candidateProblems.push(`${card.from}-${card.to} SAN ${card.san}≠${legal.san}`);
      if (legal.after !== card.after) candidateProblems.push(`${card.san} after FEN 不符`);
    }
  }
  record(
    coach.selected === 'e2'
      && coach.modelTotal === legalMoves.length
      && coach.cardCount === Math.min(3, legalMoves.length)
      && coach.cards.every((card) => card.from === coach.selected)
      && candidateProblems.length === 0,
    '⑥ 助手候选全部来自所选棋子，并与 chess.js 合法走法逐项一致',
    candidateProblems.length
      ? candidateProblems.join('; ')
      : `e2 合法/声明/DOM=${legalMoves.length}/${coach.modelTotal}/${coach.cardCount}`
        + `｜${coach.cards.map((card) => card.san).join('/')}`);

  const replyInputs = coach.cards.map((card) => ({ after: card.after }));
  const expectedReplies = await evalJs(`(async () => {
    const { rankMoves } = await import('./engine.js');
    const inputs = ${JSON.stringify(replyInputs)};
    return inputs.map(({ after }) => {
      const move = rankMoves(after, { depth: 2 })[0] || null;
      return move ? {
        san: move.san, from: move.from, to: move.to,
        promotion: move.promotion || '', piece: move.piece, score: move.score,
      } : null;
    });
  })()`, true);
  const replyProblems = [];
  coach.cards.forEach((card, index) => {
    const expected = expectedReplies[index];
    if (!expected) {
      if (card.reply.san) replyProblems.push(`${card.san} 本应无回应却显示 ${card.reply.san}`);
      return;
    }
    if (
      card.reply.san !== expected.san
      || card.reply.from !== expected.from
      || card.reply.to !== expected.to
      || card.reply.piece !== expected.piece
      || card.reply.score !== expected.score
    ) {
      replyProblems.push(`${card.san} 显示 ${card.reply.san}/${card.reply.piece}，首选应为 ${expected.san}/${expected.piece}`);
      return;
    }
    try {
      const replay = new Chess(coach.fen);
      replay.move(card.san);
      const firstFen = replay.fen();
      const reply = replay.move(card.reply.san);
      if (firstFen !== card.after || reply.piece !== card.reply.piece) {
        replyProblems.push(`${card.san} ${card.reply.san} 重放结果不符`);
      }
    } catch (error) {
      replyProblems.push(`${card.san} ${card.reply.san} 无法重放：${error.message}`);
    }
  });
  record(
    coach.cards.length > 0
      && replyProblems.length === 0
      && coach.cards.every((card) => card.reply.kind === 'analysis-suggestion' && !card.reply.selected)
      && coach.replyChips.length > 0
      && coach.replyChips.every((chip) => chip.analysisOnly),
    '⑥ 对方回应是可独立重放的引擎分析建议，不冒充已选未来',
    replyProblems.length
      ? replyProblems.join('; ')
      : coach.cards.map((card) => `${card.san}→${card.reply.piece} ${card.reply.san}`).join('　'));

  const animationState = await evalJs('window.__test.state()');
  const animationCoach = await evalJs('window.__test.coach()');
  const activeCard = animationCoach.cards.find((card) => card.active) || null;
  const youPath = animationCoach.paths.find((path) => path.step === 'you') || null;
  const animationLineIds = new Set(animationCoach.paths.map((path) => path.lineId).filter(Boolean));
  const animatedPath = (path) =>
    !!path
    && path.pathLength === 1
    && path.d.includes('Q')
    && path.animationName !== 'none'
    && parseFloat(path.animationDuration) > 0
    && path.animationIterationCount === '1';
  await sleep(2400);
  const settledCoach = await evalJs('({ coach: window.__test.coach(), render: window.__test.renderStats() })');
  record(
    animationCoach.paths.length === 1
      && animationLineIds.size === 1
      && animatedPath(youPath)
      && !!activeCard
      && youPath.san === activeCard.san
      && youPath.from === activeCard.from
      && youPath.to === activeCard.to
      && animationCoach.preview?.replySource === 'unselected-analysis'
      && animationCoach.preview?.reply === null
      && animationCoach.preview?.drawnReply === false
      && animationState.fen === coach.fen
      && animationCoach.fen === coach.fen
      && animationState.history.length === 0
      && settledCoach.coach.paths.length === 1
      && settledCoach.render.runningAnimations === 0,
    '⑥ 助手只播放确定的我方首步，未选回应不落子也不画成既定未来',
    `lineId=${[...animationLineIds][0] || '无'}`
      + `｜steps=${animationCoach.paths.map((path) => `${path.step}:${path.animationName}/${path.animationDuration}`).join('　')}`
      + `｜回应来源=${animationCoach.preview?.replySource || '无'}/${animationCoach.preview?.drawnReply ? '已绘制' : '未绘制'}`
      + `｜结束后 running=${settledCoach.render.runningAnimations}`
      + `｜FEN 未变=${animationState.fen === coach.fen}`);

  const oldLineId = [...animationLineIds][0] || '';
  const switchedPiece = await clickSelector('#boardSquares rect[data-sq="g1"]');
  const switchedCoach = await evalJs('window.__test.coach()');
  const switchedIds = new Set(switchedCoach.paths.map((path) => path.lineId).filter(Boolean));
  const resetClicked = await clickSelector('#btnReset');
  const resetCoach = await evalJs('window.__test.coach()');
  const selectedAgain = await clickSelector('#boardSquares rect[data-sq="e2"]');
  const movePreview = await evalJs('window.__test.coach()');
  const moveLineId = movePreview.paths[0]?.lineId || '';
  const realMoveClicked = await clickSelector('#boardSquares rect[data-sq="e4"]');
  const afterRealMove = await evalJs('({ coach: window.__test.coach(), state: window.__test.state() })');
  const finalResetClicked = await clickSelector('#btnReset');
  record(
    switchedPiece
      && switchedCoach.selected === 'g1'
      && switchedCoach.paths.length === 1
      && switchedIds.size === 1
      && !switchedIds.has(oldLineId)
      && resetClicked
      && resetCoach.selected === null
      && resetCoach.paths.length === 0
      && resetCoach.state === 'idle'
      && selectedAgain
      && moveLineId
      && realMoveClicked
      && afterRealMove.state.history.length >= 1
      && afterRealMove.state.history[0] === 'e4'
      && afterRealMove.coach.selected === null
      && afterRealMove.coach.paths.every((path) => path.lineId !== moveLineId)
      && finalResetClicked,
    '⑥ 切换棋子、重开和真实落子都会取消旧助手动画',
    `e2 ${oldLineId || '无'} → g1 ${[...switchedIds][0] || '无'}`
      + `｜reset paths=${resetCoach.paths.length}`
      + `｜落子后 history=${JSON.stringify(afterRealMove.state.history)}`
      + `｜旧 lineId 残留=${afterRealMove.coach.paths.some((path) => path.lineId === moveLineId)}`);

  await clickSelector('#boardSquares rect[data-sq="e2"]');
  const scoreCoach = await evalJs('window.__test.coach()');
  const fixedLanguage = await evalJs(`[
    [100000, 'mate-win', '将死'],
    [150, 'white-clear', '+1.50'],
    [50, 'white-edge', '+0.50'],
    [0, 'balanced', '+0.00'],
    [-50, 'black-edge', '-0.50'],
    [-150, 'black-clear', '-1.50'],
    [-100000, 'mate-loss', '被将死'],
  ].map(([score, expectedKey, expectedRaw]) => ({
    score, expectedKey, expectedRaw,
    actual: window.__test.scoreLanguage(score, 200),
  }))`);
  const engineScores = await evalJs(`(async () => {
    const { rankMoves } = await import('./engine.js');
    return rankMoves(window.__test.state().fen, { depth: 2 }).map((move, rank) => ({
      rank, san: move.san, from: move.from, to: move.to,
      promotion: move.promotion || '', score: move.score,
    }));
  })()`, true);
  const scoreDom = await evalJs(`(() => {
    return [...document.querySelectorAll('#coachMoves button.coach-card')].map((card) => ({
      rank: Number(card.dataset.rank),
      score: Number(card.dataset.score),
      situation: card.dataset.situation || '',
      quality: card.dataset.quality || '',
      rawText: card.querySelector('.coach-raw')?.textContent.trim() || '',
      situationText: card.querySelector('.coach-situation')?.textContent.trim() || '',
    }));
  })()`);
  const actualLanguages = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#coachMoves button.coach-card')];
    const best = ${JSON.stringify(engineScores[0]?.score ?? 0)};
    return cards.map((card) => window.__test.scoreLanguage(Number(card.dataset.score), best));
  })()`);
  const fixedOk = fixedLanguage.every((row) =>
    row.actual.situation.key === row.expectedKey
    && row.actual.raw === row.expectedRaw
    && row.actual.situation.label
    && row.actual.situation.label !== row.actual.raw);
  const scoreProblems = [];
  scoreCoach.cards.forEach((card, index) => {
    const engine = engineScores[card.rank];
    const dom = scoreDom[index];
    const language = actualLanguages[index];
    if (
      !engine
      || engine.san !== card.san
      || engine.from !== card.from
      || engine.to !== card.to
      || engine.promotion !== card.promotion
      || engine.score !== card.score
    ) {
      scoreProblems.push(`${card.san} raw score 与 engine 不符`);
    } else if (
      !dom
      || dom.rank !== card.rank
      || dom.score !== card.score
      || dom.situation !== language?.situation?.key
      || dom.quality !== language?.quality?.key
      || dom.situationText !== language?.situation?.label
      || !dom.rawText.includes(language?.raw || '\u0000')
    ) {
      scoreProblems.push(`${card.san} DOM 人话/原分不同源`);
    }
  });
  const blackQuality = await evalJs(`({
    best: window.__test.scoreLanguage(-30, -30, false).quality,
    worse: window.__test.scoreLanguage(80, -30, false).quality,
  })`);
  const promotionAudit = await evalJs(`(() => {
    const loaded = window.__test.loadFen('8/Pk6/8/8/8/8/8/K7 w - - 0 1');
    const played = window.__test.tryMove('a7', 'a8');
    const state = window.__test.state();
    const coach = window.__test.coach();
    window.__test.reset();
    return { loaded, played, state, coach };
  })()`);
  const terminalAudit = await evalJs(`(() => {
    const loaded = window.__test.loadFen('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
    const played = window.__test.tryMove('f7', 'g7');
    const state = window.__test.state();
    const coach = window.__test.coach();
    window.__test.reset();
    return { loaded, played, state, coach };
  })()`);
  const keyboardAudit = await evalJs(`(() => {
    const square = document.querySelector('#boardSquares rect[data-sq="e2"]');
    square.focus();
    square.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const coach = window.__test.coach();
    const pressed = document.querySelector('#coachMoves button.coach-card[aria-pressed="true"]');
    window.__test.reset();
    return {
      selected: coach.selected,
      state: coach.state,
      paths: coach.paths.length,
      activePressed: !!pressed,
      squareTabIndex: square.getAttribute('tabindex'),
    };
  })()`);
  const specialCoachOk =
    blackQuality.best.key === 'best'
    && blackQuality.worse.key === 'risky'
    && promotionAudit.loaded
    && promotionAudit.played
    && promotionAudit.state.history[0]?.includes('=Q')
    && promotionAudit.coach.prediction?.candidate?.promotion === 'q'
    && promotionAudit.coach.prediction?.candidate?.san?.includes('=Q')
    && terminalAudit.loaded
    && terminalAudit.played
    && terminalAudit.state.over
    && terminalAudit.state.thinking === false
    && terminalAudit.coach.state === 'outcome'
    && terminalAudit.coach.paths.length === 1
    && terminalAudit.coach.paths[0].step === 'you'
    && terminalAudit.coach.prediction === null
    && terminalAudit.coach.title.includes('棋局结束')
    && keyboardAudit.selected === 'e2'
    && keyboardAudit.state === 'ready'
    && keyboardAudit.paths === 1
    && keyboardAudit.activePressed
    && keyboardAudit.squareTabIndex === '0';
  record(
    fixedOk
      && scoreCoach.cards.length > 0
      && scoreDom.length === scoreCoach.cards.length
      && scoreProblems.length === 0
      && specialCoachOk,
    '⑥ 人话/原分同源，黑方方向、默认升后、一步终局和键盘入口均正确',
    !fixedOk
      ? fixedLanguage.map((row) => `${row.score}:${row.actual.situation.key}/${row.actual.raw}`).join('　')
      : scoreProblems.length
        ? scoreProblems.join('; ')
        : `${fixedLanguage.map((row) => `${row.score}:${row.actual.situation.short}`).join('　')}`
          + `｜候选 ${scoreCoach.cards.map((card) => `${card.san}:${card.score}/${card.situation}`).join('　')}`
          + `｜黑方 quality=${blackQuality.best.key}/${blackQuality.worse.key}`
          + `｜升变=${JSON.stringify(promotionAudit.state.history)}/${promotionAudit.coach.prediction?.candidate?.san || '无预测'}`
          + `｜终局=${terminalAudit.coach.state}/${terminalAudit.coach.title}`
          + `｜键盘=${keyboardAudit.selected}/${keyboardAudit.activePressed}`);

  const attackFen = '6k1/6b1/8/8/3N4/2P5/8/6K1 w - - 0 1';
  const attackPosition = new Chess(attackFen);
  const expectedKnightAttack = {
    attackers: attackPosition.attackers('d4', 'b').sort(),
    defenders: attackPosition.attackers('d4', 'w').sort(),
  };
  const currentAttackAudit = await evalJs(`(() => {
    const loaded = window.__test.loadFen('${attackFen}');
    const coach = window.__test.coach();
    return {
      loaded,
      state: window.__test.state(),
      coach,
      rings: [...document.querySelectorAll('#boardOverlay .board-threat-ring')].map((ring) => ({
        square: ring.dataset.square || '',
        piece: ring.dataset.piece || '',
        attackers: (ring.dataset.attackers || '').split(',').filter(Boolean).sort(),
        defenders: (ring.dataset.defenders || '').split(',').filter(Boolean).sort(),
        certainty: ring.dataset.certainty || '',
      })),
      stripText: document.getElementById('coachThreatStrip')?.textContent.trim() || '',
    };
  })()`);
  const knightAttack = currentAttackAudit.coach.currentAttacks?.find((row) => row.square === 'd4');
  const knightRing = currentAttackAudit.rings.find((row) => row.square === 'd4');
  record(
    currentAttackAudit.loaded
      && currentAttackAudit.state.fen === attackFen
      && knightAttack?.piece === 'n'
      && knightAttack?.certainty === 'geometric'
      && JSON.stringify([...(knightAttack?.attackers || [])].sort()) === JSON.stringify(expectedKnightAttack.attackers)
      && JSON.stringify([...(knightAttack?.defenders || [])].sort()) === JSON.stringify(expectedKnightAttack.defenders)
      && knightRing?.piece === 'n'
      && knightRing?.certainty === 'geometric'
      && JSON.stringify(knightRing.attackers) === JSON.stringify(expectedKnightAttack.attackers)
      && JSON.stringify(knightRing.defenders) === JSON.stringify(expectedKnightAttack.defenders)
      && currentAttackAudit.stripText.includes('攻击线')
      && !currentAttackAudit.stripText.includes('必丢'),
    '⑥ 当前威胁只标真实几何攻击线，攻击者/保护者与 chess.js 对得上',
    `d4 attackers=${JSON.stringify(knightAttack?.attackers || [])}`
      + ` defenders=${JSON.stringify(knightAttack?.defenders || [])}`
      + `｜rings=${currentAttackAudit.rings.length}`
      + `｜${currentAttackAudit.stripText || '无说明'}`);

  const threatCaseInputs = [
    { key: 'hanging', fen: 'k6r/8/8/6Q1/8/8/8/K7 w - - 0 1', from: 'g5', to: 'h5' },
    { key: 'protected', fen: 'k6r/8/8/6R1/6P1/8/8/K7 w - - 0 1', from: 'g5', to: 'h5' },
    { key: 'badTrade', fen: 'k6r/8/8/6Q1/6P1/8/8/K7 w - - 0 1', from: 'g5', to: 'h5' },
    { key: 'pinned', fen: '4k3/4r3/3Q4/8/6B1/8/8/K3R3 w - - 0 1', from: 'd6', to: 'd7' },
    { key: 'elsewhere', fen: 'k6r/8/8/7Q/8/8/P7/K7 w - - 0 1', from: 'a2', to: 'a3' },
  ].map((row) => {
    const position = new Chess(row.fen);
    const move = position.move({ from: row.from, to: row.to, promotion: 'q' });
    return { ...row, san: move?.san || '', after: move?.after || '' };
  });
  const threatCases = await evalJs(`(() => {
    const cases = ${JSON.stringify(threatCaseInputs)};
    return cases.map((row) => ({
      ...row,
      analysis: row.after && typeof window.__test.threatAnalysis === 'function'
        ? window.__test.threatAnalysis(row.after, row.to)
        : null,
    }));
  })()`);
  const threatByKey = Object.fromEntries(threatCases.map((row) => [row.key, row]));
  const hangingCapture = threatByKey.hanging.analysis?.captures?.find((row) => row.targetSquare === 'h5');
  const protectedCapture = threatByKey.protected.analysis?.captures?.find((row) => row.targetSquare === 'h5');
  const badTradeCapture = threatByKey.badTrade.analysis?.captures?.find((row) => row.targetSquare === 'h5');
  const pinnedCapture = threatByKey.pinned.analysis?.captures?.find((row) => row.targetSquare === 'd7');
  record(
    hangingCapture?.kind === 'hanging'
      && hangingCapture.recapturable === false
      && hangingCapture.recaptures.length === 0
      && threatByKey.hanging.analysis?.movedPieceEnPrise === true
      && protectedCapture?.kind === 'protected-trade'
      && protectedCapture.recapturable === true
      && protectedCapture.recaptures.length > 0
      && badTradeCapture?.kind === 'bad-trade'
      && badTradeCapture.recapturable === true
      && badTradeCapture.victim.value > badTradeCapture.attacker.value
      && !pinnedCapture
      && threatByKey.pinned.analysis?.legalCaptureCount === 0
      && threatByKey.elsewhere.analysis?.topReply.isCapture === true
      && threatByKey.elsewhere.analysis?.topReply.capturesMovedPiece === false
      && threatByKey.elsewhere.analysis?.movedPieceEnPrise === false,
    '⑥ 一步威胁能区分悬子、可回吃、亏交换、被钉假攻击和首选吃别处',
    `hanging=${hangingCapture?.kind || '无'}`
      + `｜protected=${protectedCapture?.kind || '无'}`
      + `｜badTrade=${badTradeCapture?.kind || '无'}`
      + `｜pinned captures=${threatByKey.pinned.analysis?.legalCaptureCount ?? '无'}`
      + `｜elsewhere top/moved=${threatByKey.elsewhere.analysis?.topReply.isCapture ?? '无'}`
      + `/${threatByKey.elsewhere.analysis?.movedPieceEnPrise ?? '无'}`);

  const tradeFen = 'k6r/8/8/6R1/6P1/8/8/K7 w - - 0 1';
  const tradePosition = new Chess(tradeFen);
  const tradeMove = tradePosition.move({ from: 'g5', to: 'h5' });
  const cardThreatAudit = await evalJs(`(() => {
    const hangingFen = 'r5k1/8/8/8/8/8/P7/6K1 w - - 0 1';
    window.__test.loadFen(hangingFen);
    document.querySelector('#boardSquares rect[data-sq="a2"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    const hanging = window.__test.coach();
    const hangingText = document.getElementById('coachMoves')?.textContent || '';

    const epFen = 'k7/8/8/8/3p4/8/4P3/K7 w - - 0 1';
    window.__test.loadFen(epFen);
    document.querySelector('#boardSquares rect[data-sq="e2"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    const ep = window.__test.coach();
    const e4 = ep.cards.find((card) => card.from === 'e2' && card.to === 'e4') || null;

    const tradeFen = '${tradeFen}';
    const tradeAfter = '${tradeMove.after}';
    const beforePlay = {
      depth1: typeof window.__test.rankedReplies === 'function'
        ? window.__test.rankedReplies(tradeAfter, 1)[0]?.san || ''
        : '',
      depth2: typeof window.__test.rankedReplies === 'function'
        ? window.__test.rankedReplies(tradeAfter, 2)[0]?.san || ''
        : '',
    };
    window.__test.loadFen(tradeFen);
    const played = window.__test.tryMove('g5', 'h5');
    const prediction = window.__test.coach().prediction;
    window.__test.reset();
    return { hangingFen, hanging, hangingText, ep, e4, beforePlay, played, prediction };
  })()`);
  const hangingCardsOk = cardThreatAudit.hanging.cards.length === 2
    && cardThreatAudit.hanging.cards.every((card) =>
      card.threat?.kind === 'high'
      && card.threat.movedPieceEnPrise
      && card.threat.hangingCount === 1
      && card.threat.targets.includes(card.to));
  record(
    hangingCardsOk
      && cardThreatAudit.hangingText.includes('无合法回吃')
      && !cardThreatAudit.hangingText.includes('必丢')
      && cardThreatAudit.e4?.threat?.movedPieceEnPrise === true
      && cardThreatAudit.e4.threat.targets.includes('e4')
      && !cardThreatAudit.e4.threat.targets.includes('e3')
      && cardThreatAudit.beforePlay.depth1
      && cardThreatAudit.beforePlay.depth2
      && cardThreatAudit.beforePlay.depth1 !== cardThreatAudit.beforePlay.depth2
      && cardThreatAudit.played
      && cardThreatAudit.prediction?.replies?.[0]?.san === cardThreatAudit.beforePlay.depth2,
    '⑥ 卡片呈现真实高危与吃过路兵目标，强回应会看到对方下一手回吃',
    `hanging=${cardThreatAudit.hanging.cards.map((card) => `${card.san}:${card.threat?.kind}/${card.threat?.targets.join(',')}`).join('　')}`
      + `｜EP e4 targets=${cardThreatAudit.e4?.threat?.targets.join(',') || '无'}`
      + `｜trade depth1/depth2/prediction=${cardThreatAudit.beforePlay.depth1}/${cardThreatAudit.beforePlay.depth2}`
      + `/${cardThreatAudit.prediction?.replies?.[0]?.san || '无'}`);
  await clickSelector('#btnReset');
}

async function runTree2dChecks() {
  await evalJs('window.__test.reset()');
  await waitCloudPreview();

  // ① 缩略态也必须有明确入口；每张节点卡的下一层数量由 Node 独立重放后对撞。
  const previewGameBefore = await evalJs('window.__test.state()');
  const switchedToTree = await clickSelector('#cloudMode');
  await sleep(180);
  const previewTree = await evalJs('window.__test.tree2d()');
  const previewAudit = auditTree2d(previewTree);
  const terminalLoaded = await evalJs(
    `window.__test.loadFen('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1')`,
  );
  await waitCloudPreview();
  const terminalTree = await evalJs('window.__test.tree2d()');
  const terminalTreeAudit = auditTree2d(terminalTree);
  const mateNode = terminalTree.levels[0]?.cards.find((node) => node.san === 'Qg7#');
  await evalJs('window.__test.reset()');
  await waitCloudPreview();
  const switchedBack3d = await clickSelector('#cloudMode');
  await sleep(180);
  const preview3d = await evalJs('window.__test.tree2d()');
  record(
    switchedToTree
      && previewTree.mode === '2d'
      && previewTree.tree.visible
      && previewTree.canvas.visible === false
      && previewTree.canvas.pointerEvents === 'none'
      && previewTree.modeButton.visible
      && previewTree.modeButton.pressed === 'true'
      && previewTree.modeButton.rect.h >= 43.9
      && previewTree.levels.length === 1
      && previewTree.levels[0].cardCount === count(previewTree.rootFen, 1)
      && previewAudit.ok
      && previewTree.gameFen === previewGameBefore.fen
      && JSON.stringify(previewTree.gameHistory) === JSON.stringify(previewGameBefore.history)
      && terminalLoaded
      && terminalTreeAudit.ok
      && mateNode?.branchCount === 0
      && mateNode?.branchText.includes('0')
      && switchedBack3d
      && preview3d.mode === '3d'
      && preview3d.modeButton.pressed === 'false'
      && preview3d.tree.visible === false
      && preview3d.canvas.visible,
    '② 3D 缩略图可切成真实 2D 树；根走法与每张卡的走后分叉数都能独立对账',
    previewAudit.ok
      ? `根 ${previewTree.rootCount} 条｜${previewAudit.nodeCount} 张节点逐一对账`
        + `｜将死节点 ${mateNode?.san || '缺失'} 后 ${mateNode?.branchCount ?? '？'} 条`
        + `｜canvas ${previewTree.canvas.visible ? '可见' : '隐藏且不可点'}｜切回 ${preview3d.mode}`
      : [...previewAudit.problems, ...terminalTreeAudit.problems].slice(0, 5).join('；'));

  // ② 从完整 L4 切到 2D 必须真的释放 L4；重新放大 2D 也不能暗中续算 WebGL。
  const full3d = await openCloudAndWait();
  const switchedFullToTree = await clickSelector('#cloudMode');
  const released = await waitCloudPreview();
  await waitCloudRenderIdle();
  const idleBefore = await evalJs(
    '({ raf: window.__rafAudit.read(), render: window.__test.renderStats(), tree: window.__test.tree2d() })',
  );
  await sleep(700);
  const idleAfter = await evalJs(
    '({ raf: window.__rafAudit.read(), render: window.__test.renderStats(), tree: window.__test.tree2d() })',
  );
  const closedTree = await clickSelector('#cloudClose');
  await waitCloudPreview();
  const reopenedTree = await clickSelector('#cloudOpen');
  await sleep(350);
  const directTreeCloud = await evalJs('window.__cloudStats()');
  const directTree = await evalJs('window.__test.tree2d()');
  const directRender = await evalJs('window.__test.renderStats()');
  const restartedDeep = await evalJs(`(() => {
    window.__test.setCloudMode('3d');
    return window.__test.tree2d().mode === '3d';
  })()`);
  const partialDeep = await evalJs('window.__cloudStats()');
  const cancelledDeep = await evalJs(`(() => {
    window.__test.setCloudMode('2d');
    return window.__test.tree2d().mode === '2d';
  })()`);
  const cancelledPreview = await waitCloudPreview();
  await sleep(700);
  const afterLateWindow = await evalJs('window.__cloudStats()');
  const rapidSwitch = await evalJs(`(() => {
    window.__test.setCloudMode('3d');
    const reset = window.__test.reset();
    const cloudBefore = window.__cloudStats();
    const chosen = window.__test.chooseExplorer(0);
    const pathBefore = window.__test.explorer().path;
    window.__test.setCloudMode('2d');
    const pathAfter = window.__test.explorer().path;
    return {
      reset,
      chosen,
      cloudBefore,
      pathBefore,
      pathAfter,
      modeAfter: window.__test.tree2d().mode,
    };
  })()`);
  await waitCloudPreview();
  await settleLayout();
  const rapidSettledTree = await evalJs('window.__test.tree2d()');
  const rapidSettledAudit = auditTree2d(rapidSettledTree);
  const lifecycleChecks = {
    full3d: full3d.depth === 4 && full3d.layers.some((layer) => layer.depth === 4),
    switchedFullToTree,
    released:
      hasExactCloudDepths(released, 3)
      && released.deepPending
      && !released.growing,
    treeVisible:
      idleBefore.tree.mode === '2d'
      && idleBefore.tree.full
      && idleBefore.tree.tree.visible,
    idle:
      idleAfter.raf.fired === idleBefore.raf.fired
      && idleAfter.raf.pending === 0
      && idleAfter.render.rendererFrame === idleBefore.render.rendererFrame
      && idleAfter.render.scheduled === false,
    reopened: closedTree && reopenedTree && directTree.full && directTree.mode === '2d',
    directL3:
      directTreeCloud.depth === 3
      && directTreeCloud.deepPending
      && !directTreeCloud.growing
      && !directTreeCloud.layers.some((layer) => layer.depth === 4),
    noGpuResize:
      directRender.pixelWidth === idleBefore.render.pixelWidth
      && directRender.pixelHeight === idleBefore.render.pixelHeight
      && directRender.dpr === idleBefore.render.dpr,
    partialStarted: restartedDeep && partialDeep.growing && partialDeep.depth >= 3,
    partialCancelled:
      cancelledDeep
      && hasExactCloudDepths(cancelledPreview, 3)
      && cancelledPreview.deepPending
      && !afterLateWindow.layers.some((layer) => layer.depth === 4)
      && afterLateWindow.growing === false,
    rapidPathPreserved:
      rapidSwitch.reset
      && rapidSwitch.chosen
      && rapidSwitch.cloudBefore.growing
      && rapidSwitch.cloudBefore.depth < 3
      && rapidSwitch.pathBefore.length === 1
      && JSON.stringify(rapidSwitch.pathAfter) === JSON.stringify(rapidSwitch.pathBefore)
      && rapidSwitch.modeAfter === '2d'
      && JSON.stringify(rapidSettledTree.path.map((step) => step.after))
        === JSON.stringify(rapidSwitch.pathBefore.map((step) => step.after))
      && rapidSettledAudit.ok,
  };
  record(
    Object.values(lifecycleChecks).every(Boolean),
    '② 2D 树不会加载 L4 或偷偷重绘；从 3D 切入会释放最重一层',
    `3D ${full3d.layers.map((l) => l.depth).join('/')} → 2D ${released.layers.map((l) => l.depth).join('/')}`
      + `｜700ms rAF +${idleAfter.raf.fired - idleBefore.raf.fired}`
      + ` / WebGL +${idleAfter.render.rendererFrame - idleBefore.render.rendererFrame}`
      + `｜2D 重开 depth/growing=${directTreeCloud.depth}/${directTreeCloud.growing}`
      + `｜隐藏 canvas ${idleBefore.render.pixelWidth}×${idleBefore.render.pixelHeight}`
      + `→${directRender.pixelWidth}×${directRender.pixelHeight}`
      + `｜L4 中途 depth/growing=${partialDeep.depth}/${partialDeep.growing}`
      + `｜L3 未到先切 2D 保留路径=${rapidSwitch.pathAfter.map((step) => step.san).join('→') || '无'}`
      + `｜失败条件 ${
        Object.entries(lifecycleChecks).filter(([, ok]) => !ok).map(([key]) => key).join(',') || '无'
      }`);

  // ③ 连点两层，再从第一层换兄弟：树、右侧逐格棋盘和路径 FEN 同源，但实战完全不动。
  const gameBeforePath = await evalJs(
    '({ state: window.__test.state(), ai: window.__test.ai(), pending: window.__test.aiPending() })',
  );
  const firstTreeClick = await clickSelectorHit(
    '#cloudTree2d button.tree2d-choice[data-parent-depth="0"][data-tree-rank="3"]',
  );
  let firstTreePhase = '';
  for (let sample = 0; sample < 90; sample++) {
    firstTreePhase = await evalJs(
      'document.getElementById("board")?.dataset.previewPhase || ""',
    );
    if (firstTreePhase === 'await-reply') break;
    await sleep(30);
  }
  const firstTreeReady = firstTreePhase === 'await-reply';
  const secondTreeClick = await clickSelectorHit(
    '#cloudTree2d button.tree2d-choice[data-parent-depth="1"][data-tree-rank="0"]',
  );
  const deepTree = await evalJs('window.__test.tree2d()');
  const deepTreeAudit = auditTree2d(deepTree);
  const deepExplorer = await evalJs('window.__test.explorer()');
  const deepPreviewAudit = auditExplorerPreview(deepExplorer);
  const panBefore = deepTree.levels.at(-1)?.scroller?.scrollLeft || 0;
  const pannedRight = await clickSelectorHit(
    '#cloudTree2d .tree2d-level.is-frontier button[data-tree-pan="1"]',
  );
  const panAfter = await evalJs(
    'window.__test.tree2d().levels.at(-1)?.scroller?.scrollLeft || 0',
  );
  const gameAfterPath = await evalJs(
    '({ state: window.__test.state(), ai: window.__test.ai(), pending: window.__test.aiPending() })',
  );
  const oldFirstAfter = deepTree.path[0]?.after || '';
  const changedAncestor = await clickSelectorHit(
    '#cloudTree2d button.tree2d-choice[data-parent-depth="0"][data-tree-rank="1"]',
  );
  const switchedTree = await evalJs('window.__test.tree2d()');
  const switchedTreeAudit = auditTree2d(switchedTree);
  const preservedPath = JSON.stringify(switchedTree.path);
  const switchedPathTo3d = await clickSelector('#cloudMode');
  const pathIn3d = await evalJs('window.__test.tree2d()');
  const routeIn3d = await evalJs('window.__test.cloudMap()');
  const switchedPathBack2d = await clickSelector('#cloudMode');
  await settleLayout();
  const pathBack2d = await evalJs('window.__test.tree2d()');
  const pathBack2dAudit = auditTree2d(pathBack2d);
  record(
    firstTreeClick
      && firstTreeReady
      && secondTreeClick
      && deepTree.path.length === 2
      && deepTree.levels.length === 3
      && deepTreeAudit.ok
      && deepTree.renderedFen === deepExplorer.renderedFen
      && explorerPreviewOk(deepPreviewAudit)
      && pannedRight
      && panAfter > panBefore + 10
      && deepExplorer.gameFen === gameBeforePath.state.fen
      && JSON.stringify(gameAfterPath.state.history) === JSON.stringify(gameBeforePath.state.history)
      && gameAfterPath.state.fen === gameBeforePath.state.fen
      && gameAfterPath.ai === gameBeforePath.ai
      && gameAfterPath.pending === gameBeforePath.pending
      && changedAncestor
      && switchedTree.path.length === 1
      && switchedTree.path[0].after !== oldFirstAfter
      && switchedTree.levels.length === 2
      && switchedTreeAudit.ok
      && switchedPathTo3d
      && pathIn3d.mode === '3d'
      && JSON.stringify(pathIn3d.path) === preservedPath
      && routeIn3d.routePoints === pathIn3d.path.length + 1
      && switchedPathBack2d
      && pathBack2d.mode === '2d'
      && JSON.stringify(pathBack2d.path) === preservedPath
      && pathBack2dAudit.ok,
    '② 2D 树可逐层选路和回到旧层换分支；连接线、分叉数与变体棋盘保持同一 FEN',
    deepTreeAudit.ok && switchedTreeAudit.ok
      ? `路径 ${deepTree.path.map((step) => step.san).join(' → ')}`
        + `｜首拍=${firstTreePhase}`
        + `｜DOM 节点 ${deepTreeAudit.nodeCount}｜换首步后 ${switchedTree.path[0]?.san}`
        + `｜分支箭头 ${Math.round(panBefore)}→${Math.round(panAfter)}`
        + `｜2D→3D→2D 保留 ${pathBack2d.path.map((step) => step.san).join(' → ')}`
        + `｜实战未动=${gameAfterPath.state.fen === gameBeforePath.state.fen}`
      : [...deepTreeAudit.problems, ...switchedTreeAudit.problems, ...pathBack2dAudit.problems]
        .slice(0, 6).join('；'));

  const preparedMobileDepth = await clickSelectorHit(
    '#cloudTree2d button.tree2d-choice[data-parent-depth="1"][data-tree-rank="0"]',
  );
  let preparedMobilePhase = '';
  for (let sample = 0; sample < 90; sample++) {
    preparedMobilePhase = await evalJs(
      'document.getElementById("board")?.dataset.previewPhase || ""',
    );
    if (preparedMobilePhase === 'conditional-settled'
      || preparedMobilePhase === 'conditional-static') break;
    await sleep(30);
  }
  const preparedMobileReady = preparedMobilePhase === 'conditional-settled'
    || preparedMobilePhase === 'conditional-static';

  // ④ 390px 真触摸：节点和入口可命中、同层能横滑；全屏树与底部变体棋盘互不遮挡。
  const closedForMobile = await touchSelector('#cloudClose');
  await waitCloudPreview();
  const desktopTreeLayout = await evalJs(`(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    return { cloud: box('#cloudPanel'), board: box('#boardPanel') };
  })()`);
  await setViewport(1280, 800, 'landscapePrimary');
  const shortDesktopTreeLayout = await evalJs(`(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    return { cloud: box('#cloudPanel'), board: box('#boardPanel') };
  })()`);
  await setViewport(390, 844, 'portraitPrimary');
  await selectorCenter('#cloudMode');
  const mobileTreeBefore = await evalJs('window.__test.tree2d()');
  const branchSwipe = await evalJs(`(() => {
    const scroller = document.querySelector('#cloudTree2d .tree2d-level.is-frontier .tree2d-branch-scroll');
    if (!scroller) return null;
    scroller.scrollLeft = 0;
    const r = scroller.getBoundingClientRect();
    return {
      before: scroller.scrollLeft,
      from: { x: r.right - 18, y: r.top + Math.min(52, r.height / 2) },
      to: { x: r.left + 18, y: r.top + Math.min(52, r.height / 2) },
    };
  })()`);
  if (branchSwipe) await swipeTouch(branchSwipe.from, branchSwipe.to, 12);
  const branchScrollAfter = await evalJs(
    'document.querySelector("#cloudTree2d .tree2d-level.is-frontier .tree2d-branch-scroll")?.scrollLeft || 0',
  );
  const selectedThirdMobile = await touchSelector(
    '#cloudTree2d button.tree2d-choice[data-parent-depth="2"][data-tree-rank="0"]',
  );
  const mobileThirdTree = await evalJs('window.__test.tree2d()');
  const mobileThirdAudit = auditTree2d(mobileThirdTree);
  const mobileLayout = await evalJs('window.__test.layout()');
  const openedMobileTree = await touchSelector('#cloudOpen');
  const verticalSwipe = await evalJs(`(() => {
    const scroller = document.getElementById('tree2dScroll');
    scroller.scrollTop = 0;
    const r = scroller.getBoundingClientRect();
    return {
      before: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      from: { x: r.left + r.width / 2, y: r.bottom - 28 },
      to: { x: r.left + r.width / 2, y: r.top + 64 },
    };
  })()`);
  if (verticalSwipe?.scrollHeight > verticalSwipe?.clientHeight) {
    await swipeTouch(verticalSwipe.from, verticalSwipe.to, 12);
  }
  const mobileFullTree = await evalJs('window.__test.tree2d()');
  const mobileFullBoxes = await evalJs(`(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const controls = [...document.querySelectorAll('#cloudControls button')]
      .filter((button) => getComputedStyle(button).display !== 'none')
      .map((button) => {
        const r = button.getBoundingClientRect();
        const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        return {
          id: button.id, w: r.width, h: r.height,
          inside: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
          hit: document.elementFromPoint(x, y)?.closest('button') === button,
        };
      });
    return {
      tree: rect('#cloudTree2d'),
      explorer: rect('#cloudExplorer'),
      controls,
      rootClientW: document.documentElement.clientWidth,
      rootScrollW: document.documentElement.scrollWidth,
    };
  })()`);
  const safeAreaBoxes = await evalJs(`(() => {
    const root = document.documentElement;
    const simulated = {
      '--safe-top': '47px',
      '--safe-right': '44px',
      '--safe-bottom': '34px',
      '--safe-left': '20px',
    };
    for (const [name, value] of Object.entries(simulated)) root.style.setProperty(name, value);
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    };
    const controlBottom = Math.max(...[...document.querySelectorAll('#cloudControls button')]
      .filter((button) => getComputedStyle(button).display !== 'none')
      .map((button) => button.getBoundingClientRect().bottom));
    const snapshot = {
      tree: box('#cloudTree2d'),
      explorer: box('#cloudExplorer'),
      controlBottom,
      viewport: { w: innerWidth, h: innerHeight },
    };
    for (const name of Object.keys(simulated)) root.style.removeProperty(name);
    return snapshot;
  })()`);
  const visibleMobileCards = mobileTreeBefore.levels
    .flatMap((level) => level.cards)
    .filter((card) => card.visible);
  const frontierVisibleAfterVerticalSwipe = mobileFullTree.levels.at(-1)?.cards.some((card) =>
    card.rect.bottom > mobileFullTree.tree.rect.y
    && card.rect.y < mobileFullTree.tree.rect.bottom);
  record(
    preparedMobileDepth
      && preparedMobileReady
      && closedForMobile
      && mobileTreeBefore.mode === '2d'
      && mobileTreeBefore.tree.visible
      && mobileTreeBefore.modeButton.visible
      && mobileTreeBefore.modeButton.rect.w >= 43.9
      && mobileTreeBefore.modeButton.rect.h >= 43.9
      && desktopTreeLayout.board.bottom <= desktopTreeLayout.cloud.top + 1
      && shortDesktopTreeLayout.board.bottom <= shortDesktopTreeLayout.cloud.top + 1
      && visibleMobileCards.length > 0
      && visibleMobileCards.every((card) => card.rect.w >= 43.9 && card.rect.h >= 43.9)
      && mobileTreeBefore.levels.at(-1).scroller.scrollWidth
        > mobileTreeBefore.levels.at(-1).scroller.clientWidth
      && branchScrollAfter > (branchSwipe?.before || 0) + 10
      && selectedThirdMobile
      && mobileThirdTree.path.length === 3
      && mobileThirdTree.levels.length === 3
      && mobileThirdAudit.ok
      && mobileLayout.root.scrollW <= mobileLayout.root.clientW + 1
      && openedMobileTree
      && mobileFullTree.full
      && verticalSwipe.scrollHeight > verticalSwipe.clientHeight
      && mobileFullTree.tree.scrollTop > verticalSwipe.before + 10
      && frontierVisibleAfterVerticalSwipe
      && mobileFullBoxes.tree.bottom <= mobileFullBoxes.explorer.y + 1
      && mobileFullBoxes.controls.length === 2
      && mobileFullBoxes.controls.every((button) =>
        button.w >= 43.9 && button.h >= 43.9 && button.inside && button.hit)
      && mobileFullBoxes.rootScrollW <= mobileFullBoxes.rootClientW + 1
      && safeAreaBoxes.controlBottom <= safeAreaBoxes.tree.top + 1
      && safeAreaBoxes.tree.bottom <= safeAreaBoxes.explorer.top + 1
      && safeAreaBoxes.tree.left >= 20 - 1
      && safeAreaBoxes.tree.right <= safeAreaBoxes.viewport.w - 44 + 1
      && safeAreaBoxes.explorer.bottom <= safeAreaBoxes.viewport.h - 34 + 1,
    '④ 手机缩略树可真实横滑且节点 ≥44px；全屏树与变体棋盘不遮挡',
    `可见节点 ${visibleMobileCards.length}｜最小高 ${
      visibleMobileCards.length ? Math.min(...visibleMobileCards.map((card) => card.rect.h)).toFixed(1) : 0
    }`
      + `｜桌面间距 ${Math.round(desktopTreeLayout.cloud.top - desktopTreeLayout.board.bottom)}`
      + ` / ${Math.round(shortDesktopTreeLayout.cloud.top - shortDesktopTreeLayout.board.bottom)}`
      + `｜横滑 ${branchSwipe?.before || 0}→${Math.round(branchScrollAfter)}`
      + `｜前缀 phase=${preparedMobilePhase}`
      + `｜触摸走到第 ${mobileThirdTree.path.length} 步`
      + `｜纵滑 ${verticalSwipe.before}→${Math.round(mobileFullTree.tree.scrollTop)}`
      + `｜全屏树 bottom ${Math.round(mobileFullBoxes.tree.bottom)}`
      + ` / 棋盘区 top ${Math.round(mobileFullBoxes.explorer.y)}`
      + `｜刘海模拟 controls/tree/explorer=${Math.round(safeAreaBoxes.controlBottom)}`
      + `/${Math.round(safeAreaBoxes.tree.top)}..${Math.round(safeAreaBoxes.tree.bottom)}`
      + `/${Math.round(safeAreaBoxes.explorer.top)}`
      + `｜控件 ${mobileFullBoxes.controls.length} 个全命中`);

  await touchSelector('#cloudClose');
  await waitCloudPreview();
  await evalJs('window.__test.reset()');
  await waitCloudPreview();
  const thinking2d = await evalJs(`(() => {
    const played = window.__test.tryMove('e2', 'e4');
    return {
      played,
      state: window.__test.state(),
      tree: window.__test.tree2d(),
      explorer: window.__test.explorer(),
      staleChoiceExists: !!document.querySelector('#cloudTree2d button[data-tree-rank]'),
    };
  })()`);
  let settled2d = null;
  for (let i = 0; i < 160; i++) {
    settled2d = await evalJs(`({
      state: window.__test.state(),
      ai: window.__test.ai(),
    })`);
    if (
      settled2d.ai?.painted
      && !settled2d.state.thinking
      && settled2d.state.history.length === 2
    ) break;
    await sleep(40);
  }
  await waitCloudPreview();
  const settledTree2d = await evalJs('window.__test.tree2d()');
  const settledExplorer2d = await evalJs('window.__test.explorer()');
  const settledTree2dAudit = auditTree2d(settledTree2d);
  const settledExplorer2dAudit = auditExplorerPreview(settledExplorer2d);
  record(
    thinking2d.played
      && thinking2d.state.thinking
      && thinking2d.tree.thinking
      && thinking2d.tree.tree.inert
      && thinking2d.tree.busy === 'true'
      && thinking2d.tree.levels.length === 0
      && thinking2d.tree.hud.stats.includes('等待')
      && thinking2d.explorer.thinking
      && thinking2d.explorer.inert
      && thinking2d.explorer.busy === 'true'
      && thinking2d.explorer.choices.length === 0
      && !thinking2d.staleChoiceExists
      && settled2d?.ai?.painted
      && settled2d?.state?.history.length === 2
      && settledTree2d.thinking === false
      && settledTree2d.tree.inert === false
      && settledTree2d.busy === 'false'
      && settledTree2d.rootFen === settled2d.state.fen
      && settledTree2d.gameFen === settled2d.state.fen
      && settledTree2dAudit.ok
      && settledExplorer2d.thinking === false
      && settledExplorer2d.inert === false
      && settledExplorer2d.busy === 'false'
      && settledExplorer2d.renderedFen === settled2d.state.fen
      && explorerPreviewOk(settledExplorer2dAudit),
    '② 2D 树在 AI 思考时禁用旧分支，真实应手绘制后再按新 FEN 重建',
    `思考态 tree=${thinking2d.tree.busy}/${thinking2d.tree.levels.length}层`
      + ` explorer=${thinking2d.explorer.busy}/${thinking2d.explorer.choices.length}项`
      + `｜完成棋谱 ${JSON.stringify(settled2d?.state?.history || [])}`
      + `｜新根对账=${settledTree2dAudit.ok}/${explorerPreviewOk(settledExplorer2dAudit)}`);

  const lateFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 37';
  const lateFenLoaded = await evalJs(`window.__test.loadFen('${lateFen}')`);
  await waitCloudPreview();
  const lateFenTree = await evalJs('window.__test.tree2d()');
  const lateFenAudit = auditTree2d(lateFenTree);
  const advancedLevel = settledTree2d.levels[0] || {};
  const lateLevel = lateFenTree.levels[0] || {};
  record(
    settled2d?.state?.history.length === 2
      && settledTree2d.rootContext?.completedPly === 2
      && settledTree2d.rootContext?.fullmove === 2
      && advancedLevel.depth === 1
      && advancedLevel.relativeDepth === 1
      && advancedLevel.absolutePly === 3
      && advancedLevel.fullmove === 2
      && advancedLevel.side === 'w'
      && advancedLevel.heading.includes('第 2 回合')
      && advancedLevel.heading.includes('未来第 1 步')
      && settledTree2dAudit.ok
      && lateFenLoaded
      && lateFenTree.gameHistory.length === 0
      && lateFenTree.rootContext?.completedPly === 73
      && lateFenTree.rootContext?.fullmove === 37
      && lateLevel.depth === 1
      && lateLevel.relativeDepth === 1
      && lateLevel.absolutePly === 74
      && lateLevel.fullmove === 37
      && lateLevel.side === 'b'
      && lateLevel.heading.includes('第 37 回合')
      && lateLevel.heading.includes('黑方走')
      && lateLevel.heading.includes('未来第 1 步')
      && lateFenAudit.ok,
    '② 2D 全景树显示真实棋局回合，不会每个新局面都冒充第一步',
    `实战两手后 root=${JSON.stringify(settledTree2d.rootContext || null)}`
      + `｜L1=${advancedLevel.heading || '缺失'}`
      + `｜第37回合空 history=${lateFenTree.gameHistory.length}`
      + ` root=${JSON.stringify(lateFenTree.rootContext || null)}`
      + `｜L1=${lateLevel.heading || '缺失'}`
      + `｜审计=${settledTree2dAudit.ok}/${lateFenAudit.ok}`,
  );

  await touchSelector('#cloudMode');
  await evalJs('window.__test.reset()');
  await waitCloudPreview();
}

async function runMobileChecks() {
  const shotBase = SHOT.replace(/\.png$/i, '');
  try {

  // 390×844 竖屏：页面本身只纵向滚，棋盘 → 分叉 → 路径网都能到达。
  await setViewport(390, 844, 'portraitPrimary');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const portrait = await evalJs('window.__test.layout()');
  let releasedFullCloud = null;
  for (let i = 0; i < 75; i++) {
    releasedFullCloud = await evalJs('window.__cloudStats()');
    if (
      releasedFullCloud.depth === 3
      && releasedFullCloud.deepPending
      && !releasedFullCloud.layers.some((layer) => layer.depth === 4)
    ) break;
    await sleep(40);
  }
  await sleep(250);
  const releasedIdleCloud = await evalJs('window.__cloudStats()');
  const portraitProblems = layoutProblems(portrait);
  const portraitBoard = await evalJs('window.__test.board()');
  const portraitBoardAudit = auditBoardDom(portraitBoard);
  record(
    portraitBoardAudit.exactFen
      && portraitBoard.unicodeGlyphs === 0
      && portraitBoard.renderModes.length === 1
      && portraitBoard.renderModes[0] === 'vector-3d'
      && portraitBoardAudit.instancesMatchTemplates
      && portraitBoardAudit.templateDepthRoles
      && portraitBoardAudit.boundsOk,
    '⑤ 手机竖屏的全部棋子仍用统一 3D 模型并逐格吻合 FEN',
    `实际 ${portraitBoard.total} 枚｜逐格 ${portraitBoardAudit.exactFen ? '一致' : '不一致'}`
      + `｜renderer=${portraitBoard.renderModes.join('/')}｜边界=${portraitBoardAudit.boundsOk}`);

  const portraitBoardFile = `${shotBase}-mobile-board.png`;
  const portraitBoardShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(portraitBoardFile, Buffer.from(portraitBoardShot.data, 'base64'));
  await evalJs('document.getElementById("boardPieces").style.visibility = "hidden"');
  await settleLayout();
  const portraitBlankFile = `${shotBase}-mobile-board-blank.png`;
  const portraitBlankShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(portraitBlankFile, Buffer.from(portraitBlankShot.data, 'base64'));
  await evalJs('document.getElementById("boardPieces").style.visibility = ""');
  await settleLayout();
  const portraitPixels = boardPiecePixelStats(
    portraitBoardFile,
    portraitBlankFile,
    portraitBoard,
    portrait.viewport,
  );
  record(
    portraitPixels.white >= 150
      && portraitPixels.black <= 120
      && portraitPixels.gap >= 70
      && portraitPixels.minWhiteMedian >= 150
      && portraitPixels.maxBlackMedian <= 120
      && portraitPixels.minTypeGap >= 60
      && portraitPixels.whiteShape.typeCount === 6
      && portraitPixels.blackShape.typeCount === 6
      && portraitPixels.whiteShape.minDistance >= .02
      && portraitPixels.blackShape.minDistance >= .02
      && portraitPixels.minVisibleHeightRatio >= .62
      && portraitPixels.minUpperCoverage >= .035
      && portraitPixels.minCoverage >= .045
      && portraitPixels.minToneRange >= 24,
    '⑤ 手机真实截图中白棋没有发黑，黑白材质和立体明暗都保留',
    `白中位 ${portraitPixels.white.toFixed(1)}｜黑中位 ${portraitPixels.black.toFixed(1)}`
      + `｜差 ${portraitPixels.gap.toFixed(1)}`
      + `｜逐枚白最低/黑最高 ${portraitPixels.minWhiteMedian.toFixed(1)}/${portraitPixels.maxBlackMedian.toFixed(1)}`
      + `｜逐类型最小差 ${portraitPixels.minTypeGap.toFixed(1)}`
      + `｜白最近轮廓 ${portraitPixels.whiteShape.closestTypes} Δ${portraitPixels.whiteShape.minDistance.toFixed(3)}`
      + `｜黑最近轮廓 ${portraitPixels.blackShape.closestTypes} Δ${portraitPixels.blackShape.minDistance.toFixed(3)}`
      + `｜逐枚最小可见高度 ${(portraitPixels.minVisibleHeightRatio * 100).toFixed(1)}%`
      + `｜逐枚最小上半区覆盖 ${(portraitPixels.minUpperCoverage * 100).toFixed(1)}%`
      + `｜最小覆盖 ${(portraitPixels.minCoverage * 100).toFixed(1)}%`
      + `｜最小明暗跨度 ${portraitPixels.minToneRange.toFixed(1)}`);
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
      : `viewport ${portrait.viewport.w}×${portrait.viewport.h}｜真实滑动到 y=${Math.round(portraitScrollY)}｜顺序 棋盘→分叉→路径网`);

  const boardOk =
    Math.abs(portrait.board.w - portrait.board.h) <= 1
    && portrait.board.w / 8 >= 36
    && portrait.board.docX >= -1
    && portrait.board.docRight <= portrait.viewport.w + 1;
  const targets = [...portrait.controls.buttons, portrait.controls.firstCard].filter(Boolean);
  const targetsOk = targets.length > 0 && targets.every((r) => r.h >= 43.9);
  const minTarget = targets.length ? Math.min(...targets.map((r) => r.h)) : 0;
  record(boardOk && targetsOk,
    '④ 手机棋盘保持正方形，按钮和走法卡触控目标不小于 44px',
    `棋盘 ${Math.round(portrait.board.w)}×${Math.round(portrait.board.h)}｜单格 ${(portrait.board.w / 8).toFixed(1)}px｜最小目标 ${minTarget.toFixed(1)}px`);

  // 助手抬高了 stageHead；先把真实滚动容器带回视口，再从屏幕坐标发 touch 手势。
  // 不能直接给 scrollLeft 赋目标值来冒充用户横滑。
  await evalJs('window.__futureTest.rewind(0)');
  await evalJs('document.getElementById("forkWrap").scrollIntoView({ block: "center", inline: "nearest" })');
  await settleLayout();
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

  // 第二列以后现在是条件路线，不能再像旧测试那样直接点最后一列跳过前缀。
  // 先走五列分叉图自己的选路入口逐层建立四步前缀，再用真触摸选最后一列。
  // 不能用 __futureTest.selectNode 搭这个前缀：它属于全屏探索器，按性能契约只展开 3 层。
  const mobilePrefixUnlock = [];
  await evalJs('window.__futureTest.rewind(0)');
  for (let depth = 0; depth < 4; depth++) {
    const picked = await evalJs(`(() => {
      const card = document.querySelector('#fork g.card[data-col="${depth}"][data-idx="1"]')
        || document.querySelector('#fork g.card[data-col="${depth}"]');
      return {
        found: !!card,
        accepted: card ? window.__test.pickBranch(${depth}, Number(card.dataset.idx)) : false,
        san: card?.dataset.san || '',
      };
    })()`);
    let phase = '';
    for (let sample = 0; sample < 90; sample++) {
      phase = await evalJs('document.getElementById("board")?.dataset.previewPhase || ""');
      const ready = depth === 0
        ? phase === 'await-reply' || phase === 'terminal'
        : phase === 'conditional-settled' || phase === 'conditional-static';
      if (ready) break;
      await sleep(30);
    }
    mobilePrefixUnlock.push({ ...picked, depth, phase });
  }

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
    const lastCol = Math.max(...cards.map((card) => Number(card.dataset.col)));
    const target = cards.find((card) => Number(card.dataset.col) === lastCol && Number(card.dataset.idx) === 1)
      || cards.find((card) => Number(card.dataset.col) === lastCol);
    const initialChosenRank = Number(
      cards.find((card) => Number(card.dataset.col) === lastCol && card.dataset.selected === 'true')
        ?.dataset.idx,
    );
    let wr = wrap.getBoundingClientRect();
    let r = target.getBoundingClientRect();
    wrap.scrollTop = Math.max(
      0,
      Math.min(
        wrap.scrollHeight - wrap.clientHeight,
        wrap.scrollTop + (r.top + r.bottom - wr.top - wr.bottom) / 2,
      ),
    );
    wr = wrap.getBoundingClientRect();
    r = target.getBoundingClientRect();
    const x = Math.max(wr.left + 2, Math.min(wr.right - 2, (r.left + r.right) / 2));
    const y = Math.max(wr.top + 2, Math.min(wr.bottom - 2, (r.top + r.bottom) / 2));
    const hit = document.elementFromPoint(x, y)?.closest?.('g.card');
    return {
      cards: cards.length, clientW: wrap.clientWidth, scrollW: wrap.scrollWidth,
      visible:
        r.right > wr.left && r.left < wr.right
        && r.bottom > wr.top && r.top < wr.bottom,
      hittable: hit === target,
      scrollTop: wrap.scrollTop,
      lastCol,
      initialChosenRank,
      target: {
        x, y, col: lastCol, rank: Number(target.dataset.idx), san: target.dataset.san,
      },
      rootScrollW: document.documentElement.scrollWidth,
      rootClientW: document.documentElement.clientWidth,
    };
  })()`);
  if (forkReach.target) {
    await touchAt(forkReach.target.x, forkReach.target.y);
    await sleep(120);
  }
  const touchedRoute = forkReach.target
    ? await evalJs(`({
        column: window.__forkStats()[${forkReach.target.col}],
        future: window.__futureTest.snapshot(),
        explorer: window.__test.explorer(),
        state: window.__test.state(),
      })`)
    : null;
  const touchedBranch = touchedRoute?.column?.chosenSan || null;
  const selectedPathAudit = (() => {
    const path = touchedRoute?.future?.selectedPath || [];
    let replay;
    try { replay = new Chess(touchedRoute?.future?.root?.fen || ''); }
    catch (error) { return { ok: false, detail: error.message }; }
    for (const [index, step] of path.entries()) {
      const played = replay.move({
        from: step.from,
        to: step.to,
        ...(step.promotion ? { promotion: step.promotion } : {}),
      });
      if (
        !played
        || played.san !== step.label
        || replay.fen() !== step.afterFen
        || step.branchCount !== count(step.afterFen, 1)
      ) return { ok: false, detail: `L${index + 1} ${step.label}` };
    }
    return { ok: true, detail: path.map((step) => step.label).join('→') };
  })();
  const explorerPrefix = touchedRoute?.explorer?.path || [];
  const selectedPath = touchedRoute?.future?.selectedPath || [];
  record(
    forkReach.cards > 0
      && gestureScrollLeft > 10
      && mobilePrefixUnlock.length === 4
      && mobilePrefixUnlock.every((step, depth) =>
        step.found && step.accepted
          && (depth === 0
            ? step.phase === 'await-reply' || step.phase === 'terminal'
            : step.phase === 'conditional-settled' || step.phase === 'conditional-static'))
      && forkReach.scrollW > forkReach.clientW
      && forkReach.visible
      && forkReach.hittable
      && forkReach.lastCol === 4
      && forkReach.target?.rank !== forkReach.initialChosenRank
      && touchedBranch === forkReach.target?.san
      && touchedRoute?.column?.chosenRank === forkReach.target?.rank
      && selectedPath.length === 5
      && selectedPathAudit.ok
      && touchedRoute?.state?.history?.length === 0
      && touchedRoute?.state?.fen === touchedRoute?.future?.root?.fen
      && explorerPrefix.length === 3
      && explorerPrefix.every((step, index) => step.after === selectedPath[index]?.afterFen)
      && forkReach.rootScrollW <= forkReach.rootClientW + 1,
    '④ 分叉可真实横滑，最后一列可触摸选择',
    `手势滑到 ${Math.round(gestureScrollLeft)}px`
      + `｜前缀 ${mobilePrefixUnlock.map((step) => `${step.san}:${step.phase}`).join('→')}`
      + `｜纵滚 ${Math.round(forkReach.scrollTop || 0)}px / hit=${forkReach.hittable}`
      + `｜末列点 ${forkReach.target?.san || '无卡片'}→${touchedBranch || '未选'}`
      + `｜五步 ${selectedPathAudit.detail} / explorer=${explorerPrefix.length}`
      + `｜根页面 ${forkReach.rootClientW}/${forkReach.rootScrollW}px`);

  const resetUi = await evalJs(`(() => {
    const before = {
      scrollLeft: document.getElementById('forkWrap').scrollLeft,
      status: document.getElementById('status').textContent,
      foot: document.getElementById('forkFoot').textContent,
    };
    window.scrollTo(0, 0);
    window.__test.reset();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      before,
      after: {
        scrollLeft: document.getElementById('forkWrap').scrollLeft,
        status: document.getElementById('status').textContent,
        foot: document.getElementById('forkFoot').textContent,
        state: window.__test.state(),
        ai: window.__test.ai(),
        pending: window.__test.aiPending(),
      },
    }))));
  })()`, true);
  record(
    resetUi.before.scrollLeft > 10
      && resetUi.after.scrollLeft <= 2
      && resetUi.after.state.history.length === 0
      && resetUi.after.state.thinking === false
      && resetUi.after.ai === null
      && resetUi.after.pending === null
      && resetUi.after.status.includes('你执白')
      && resetUi.after.foot.includes('第一步由你选择')
      && !resetUi.after.foot.includes(forkReach.target?.san || '\u0000'),
    '④ 重开会清掉旧状态、走法详情和分叉横滚位置',
    `scrollLeft ${Math.round(resetUi.before.scrollLeft)}→${Math.round(resetUi.after.scrollLeft)}`
      + `｜history=${JSON.stringify(resetUi.after.state.history)}`
      + `｜AI/pending=${resetUi.after.ai}/${resetUi.after.pending}`
      + `｜状态「${resetUi.after.status}」`);

  let offscreenCloud = null;
  for (let i = 0; i < 100; i++) {
    offscreenCloud = await evalJs(`({
      stats: window.__cloudStats(),
      sky: (() => {
        const r = document.getElementById('skyBox').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      })(),
    })`);
    if (
      !offscreenCloud.stats.growing
      && offscreenCloud.stats.depth >= 3
    ) break;
    await sleep(40);
  }
  record(
    releasedFullCloud.depth === 3
      && releasedFullCloud.deepPending === true
      && hasExactCloudDepths(releasedFullCloud, 3)
      && !releasedFullCloud.layers.some((layer) => layer.depth === 4)
      && hasExactCloudDepths(releasedIdleCloud, 3)
      && Math.abs(releasedIdleCloud.ms - releasedFullCloud.ms) <= 2
      && offscreenCloud.stats.depth === 3
      && offscreenCloud.stats.growing === false
      && offscreenCloud.stats.deepPending === true
      && hasExactCloudDepths(offscreenCloud.stats, 3)
      && !offscreenCloud.stats.error
      && (
        offscreenCloud.sky.top >= portrait.viewport.h
        || offscreenCloud.sky.bottom <= 0
      ),
    '④ 手机缩略窗无论在视口内外都只铺真实 L3，静置不会继续计算',
    `缩略态 layers=${JSON.stringify(releasedFullCloud.layers.map((layer) => layer.depth))}`
      + `｜闲置 250ms 的 active ms ${releasedFullCloud.ms}→${releasedIdleCloud.ms}`
      + `｜屏外 sky y=${Math.round(offscreenCloud.sky.top)}..${Math.round(offscreenCloud.sky.bottom)}`
      + `｜layers=${JSON.stringify(offscreenCloud.stats.layers.map((layer) => layer.depth))}`
      + `｜growing=${offscreenCloud.stats.growing}`
      + `｜deepPending=${offscreenCloud.stats.deepPending}｜error=${offscreenCloud.stats.error || '无'}`);

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
  // 滚到底后的 viewport 顶沿可能正好切过正文；这里只量页面真正露底的左右与底边。
  const bottomEdge = edgeStats(bottomFile, portrait.viewport.w, portrait.viewport.h, true);
  record(
    topEdge.darkRatio > 0.98
      && bottomEdge.darkRatio > 0.98
      && bottomPosition.y >= bottomPosition.max - 1,
    '④ 手机背景从页面顶部铺到底部，外侧与底边无白边或透明断层',
    `顶部四边深色 ${topEdge.darkRatio}｜滚底左右/底边深色 ${bottomEdge.darkRatio}｜滚动 ${Math.round(bottomPosition.y)}/${Math.round(bottomPosition.max)}`);
  const mobilePreviewCloud = await waitCloudPreview();
  const mobileOpenTouched = await touchSelector('#cloudOpen');
  const mobileEnteredCloud = await waitCloud(60000);

  // 全屏要真占满 viewport，四角的命中层也必须属于路径网，而不是后面的面板。
  const full = await evalJs(`(() => {
    const l = window.__test.layout();
    const w = l.viewport.visualW, h = l.viewport.visualH;
    const points = [[1,1],[w-2,1],[1,h-2],[w-2,h-2]];
    const cornersHit = points.every(([x,y]) => {
      const el = document.elementFromPoint(x,y);
      return !!(el && el.closest('#cloudPanel'));
    });
    return {
      layout: l,
      cornersHit,
      backgroundInert:
        document.getElementById('boardPanel').inert
        && document.getElementById('stage').inert,
    };
  })()`);
  const fsb = full.layout.skyBox, fsc = full.layout.skyCanvas;
  const pxRatio = Math.min(full.layout.viewport.dpr, 1.25);
  const fullGeometryOk =
    mobileOpenTouched
    && full.layout.cloudFull
    && Math.abs(fsb.x) <= 1 && Math.abs(fsb.y) <= 1
    && Math.abs(fsb.w - full.layout.viewport.visualW) <= 1
    && Math.abs(fsb.h - full.layout.viewport.visualH) <= 1
    && full.cornersHit
    && full.backgroundInert
    && Math.abs(fsc.pixelW - fsc.w * pxRatio) <= 2
    && Math.abs(fsc.pixelH - fsc.h * pxRatio) <= 2;

  const mobileExplorerUi = await evalJs(`(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const panel = box('#cloudExplorer');
    const board = box('#exploreBoard');
    const summary = box('#exploreSummary');
    const choices = box('#exploreChoices');
    const choiceButtons = [...document.querySelectorAll('#exploreChoices button')];
    const buttons = choiceButtons.map((button) => {
      const r = button.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const targetButtons = [
      ...document.querySelectorAll('#cloudControls button'),
      document.getElementById('exploreReset'),
      document.querySelector('#explorePath button'),
      choiceButtons[0],
      document.querySelector('button.cloud-root-label'),
    ].filter(Boolean);
    const targets = targetButtons.map((button) => {
      const r = button.getBoundingClientRect();
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        id: button.id || button.textContent.trim(),
        w: r.width, h: r.height,
        inside: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
        hit: !!hit && hit.closest('button') === button,
      };
    });
    return {
      panel, board, summary, choices, buttons, targets,
      choicesClientH: document.getElementById('exploreChoices').clientHeight,
      choicesScrollH: document.getElementById('exploreChoices').scrollHeight,
      rootClientW: document.documentElement.clientWidth,
      rootScrollW: document.documentElement.scrollWidth,
      viewport: { w: innerWidth, h: innerHeight },
      explorer: window.__test.explorer(),
    };
  })()`);
  const mobileExplorerFile = `${shotBase}-mobile-explorer.png`;
  const mobileExplorerShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(mobileExplorerFile, Buffer.from(mobileExplorerShot.data, 'base64'));
  const mobileExplorerPreview = auditExplorerPreview(mobileExplorerUi.explorer);
  const choicesSwipe = await evalJs(`(() => {
    const choices = document.getElementById('exploreChoices');
    choices.scrollTop = 0;
    const r = choices.getBoundingClientRect();
    return {
      from: { x: r.left + r.width / 2, y: r.bottom - 12 },
      to: { x: r.left + r.width / 2, y: r.top + 12 },
    };
  })()`);
  await swipeTouch(choicesSwipe.from, choicesSwipe.to, 10);
  const choicesScrollTop = await evalJs('document.getElementById("exploreChoices").scrollTop');
  record(
    mobileExplorerUi.panel.x >= -1
      && mobileExplorerUi.panel.y >= -1
      && mobileExplorerUi.panel.right <= mobileExplorerUi.viewport.w + 1
      && mobileExplorerUi.panel.bottom <= mobileExplorerUi.viewport.h + 1
      && mobileExplorerUi.board.w >= 136
      && Math.abs(mobileExplorerUi.board.w - mobileExplorerUi.board.h) <= 1
      && mobileExplorerUi.summary.bottom <= mobileExplorerUi.choices.y + 1
      && mobileExplorerUi.buttons.length > 0
      && mobileExplorerUi.buttons.every((button) => button.h >= 43.9)
      && mobileExplorerUi.targets.length >= 8
      && mobileExplorerUi.targets.every((target) =>
        target.w >= 43.9 && target.h >= 43.9 && target.inside && target.hit)
      && mobileExplorerUi.choicesScrollH > mobileExplorerUi.choicesClientH
      && choicesScrollTop > 10
      && mobileExplorerUi.rootScrollW <= mobileExplorerUi.rootClientW + 1
      && explorerPreviewOk(mobileExplorerPreview),
    '④ 手机放大探索同时看得到棋盘、说明和可滚动走法，触控项不小于 44px',
    `面板 ${Math.round(mobileExplorerUi.panel.w)}×${Math.round(mobileExplorerUi.panel.h)}`
      + `｜预演棋盘 ${Math.round(mobileExplorerUi.board.w)}px`
      + `｜走法 ${mobileExplorerUi.buttons.length} 个`
      + `｜真实滚动 ${Math.round(choicesScrollTop)}/${mobileExplorerUi.choicesScrollH - mobileExplorerUi.choicesClientH}`
      + `｜触控命中 ${mobileExplorerUi.targets.length} 个`
      + `｜说明/走法重叠=${mobileExplorerUi.summary.bottom > mobileExplorerUi.choices.y + 1}`
      + `｜根宽 ${mobileExplorerUi.rootClientW}/${mobileExplorerUi.rootScrollW}`
      + `｜截图 ${mobileExplorerFile}`);

  // 全屏标签直接读实际 DOM 盒子/computedStyle，合法性则由 Node 端 chess.js 独立判断。
  await sleep(260);
  await settleLayout();
  const fullStateBeforeLabel = await evalJs('window.__test.state()');
  const legalFullSans = new Set(new Chess(fullStateBeforeLabel.fen).moves());
  const fullMap = await evalJs('window.__test.cloudMap()');
  const fullExplorer = await evalJs('window.__test.explorer()');
  const visibleLabels = fullMap.labels.filter((label) => label.visible);
  const visibleRoots = visibleLabels.filter((label) => label.depth === 0 && label.text.includes('现在'));
  const firstLevelLabels = fullMap.labels.filter((label) => label.depth === 1 && label.san);
  const visibleMoves = visibleLabels.filter((label) => label.depth === 1 && label.san);
  const pathLabels = fullMap.labels.filter((label) => label.depth >= 2 && label.san);
  const visibleSans = visibleLabels.filter((label) => label.depth >= 1 && label.san);
  const labelsOk =
    visibleRoots.length === 1
    && visibleSans.length >= 1
    && visibleLabels.length <= 6
    && firstLevelLabels.every((label) => legalFullSans.has(label.san))
    && new Set(firstLevelLabels.map((label) => label.san)).size === firstLevelLabels.length
    && firstLevelLabels.length === Math.min(8, fullExplorer.choices.length)
    && pathLabels.length === 0
    && fullMap.routePoints === 0;
  record(
    labelsOk,
    '④ 手机全屏有「现在」和可点的真实候选标签，未选择前不伪造主路径',
    `可见 ${visibleLabels.length} 个（现在 ${visibleRoots.length} + SAN ${visibleSans.length}）`
      + `｜根走法 ${visibleMoves.map((label) => label.san).join('/')}`
      + `｜selected-route position.count=${fullMap.routePoints}`);

  // 真触摸一个当前可见的走法标签；它更新右侧/底部预演棋盘，但不得偷偷落子。
  const labelTarget = visibleMoves[0] || null;
  const historyBeforeLabel = fullStateBeforeLabel.history;
  if (labelTarget) {
    await touchAt(labelTarget.x, labelTarget.y);
    await sleep(280);
    await settleLayout();
  }
  const stateAfterLabel = await evalJs('window.__test.state()');
  const explorerAfterLabel = await evalJs('window.__test.explorer()');
  const mapAfterLabel = await evalJs('window.__test.cloudMap()');
  const previewAfterLabel = auditExplorerPreview(explorerAfterLabel);
  let labelReplayFen = '';
  try {
    const replay = new Chess(fullExplorer.rootFen);
    replay.move(labelTarget?.san);
    labelReplayFen = replay.fen();
  } catch {}
  const secondLabelTarget = explorerAfterLabel.labels.find(
    (label) => label.visible && label.depth === 2,
  ) || null;
  if (secondLabelTarget) {
    await touchAt(secondLabelTarget.x, secondLabelTarget.y);
    await sleep(280);
    await settleLayout();
  }
  const stateAfterSecondLabel = await evalJs('window.__test.state()');
  const explorerAfterSecondLabel = await evalJs('window.__test.explorer()');
  const mapAfterSecondLabel = await evalJs('window.__test.cloudMap()');
  const previewAfterSecondLabel = auditExplorerPreview(explorerAfterSecondLabel);
  let secondLabelReplayFen = '';
  try {
    const replay = new Chess(fullExplorer.rootFen);
    replay.move(labelTarget?.san);
    replay.move(secondLabelTarget?.san);
    secondLabelReplayFen = replay.fen();
  } catch {}
  const labelPickOk =
    !!labelTarget
    && legalFullSans.has(labelTarget.san)
    && explorerAfterLabel.path.length === 1
    && explorerAfterLabel.path[0].san === labelTarget.san
    && explorerAfterLabel.renderedFen === labelReplayFen
    && explorerPreviewOk(previewAfterLabel)
    && stateAfterLabel.fen === fullStateBeforeLabel.fen
    && JSON.stringify(stateAfterLabel.history) === JSON.stringify(historyBeforeLabel)
    && mapAfterLabel.routePoints === 2
    && !!secondLabelTarget
    && explorerAfterSecondLabel.path.length === 2
    && explorerAfterSecondLabel.path[1].san === secondLabelTarget.san
    && explorerAfterSecondLabel.renderedFen === secondLabelReplayFen
    && explorerPreviewOk(previewAfterSecondLabel)
    && stateAfterSecondLabel.fen === fullStateBeforeLabel.fen
    && JSON.stringify(stateAfterSecondLabel.history) === JSON.stringify(historyBeforeLabel)
    && mapAfterSecondLabel.routePoints === 3;
  record(
    labelPickOk,
    '④ 连续触摸两层线旁标签会更新变体棋盘，逐格结果正确且实战棋谱不动',
    `点 ${labelTarget?.san || '无'}→${secondLabelTarget?.san || '无'}`
      + `｜预演 path=${explorerAfterSecondLabel.path.map((move) => move.san).join('→')}`
      + `｜preview=${previewAfterSecondLabel.actualCount}/${previewAfterSecondLabel.expectedCount}`
      + `｜history ${JSON.stringify(historyBeforeLabel)}→${JSON.stringify(stateAfterLabel.history)}`
      + `｜路线点 ${mapAfterLabel.routePoints}→${mapAfterSecondLabel.routePoints}`);

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
    && hiddenAfterDrag > 0
    && visibilityChanged;
  record(
    dragOk,
    '④ 真实拖动会转动相机并重排标签，画面同时有显有隐',
    `拖动 ${cloudDrag ? `${Math.round(cloudDrag.from.x)},${Math.round(cloudDrag.from.y)}→${Math.round(cloudDrag.to.x)},${Math.round(cloudDrag.to.y)}` : '没找到画布空白'}`
      + `｜camera Δ${matrixDelta.toFixed(3)}｜标签最大位移 ${maxLabelMove.toFixed(1)}px`
      + `｜显/隐 ${visibleAfterDrag}/${hiddenAfterDrag}｜显隐集合变化=${visibilityChanged}`);

  const motionBefore = await evalJs('window.__test.renderStats()');
  const motionTouched = await touchSelector('#cloudMotion');
  await sleep(260);
  const motionDuring = await evalJs('window.__test.renderStats()');
  const motionMoved = motionBefore.cameraMatrix.some(
    (value, index) => Math.abs(value - motionDuring.cameraMatrix[index]) > 1e-4,
  );

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
    backgroundInert:
      document.getElementById('boardPanel').inert
      || document.getElementById('stage').inert,
    render: window.__test.renderStats(),
  }))()`);
  const fullOk =
    fullGeometryOk
    && closeTap.visible
    && closeTap.w >= 47.9 && closeTap.h >= 43.9
    && motionTouched
    && motionDuring.auto === true
    && motionDuring.rendererFrame > motionBefore.rendererFrame
    && motionMoved
    && !closed.layout.cloudFull
    && closed.closeDisplay === 'none'
    && closed.backgroundInert === false
    && closed.render.auto === false;
  record(fullOk, '④ 手机路径网是真全屏；巡航只在主动开启时运行，收起会停止并恢复背景',
    `真实触摸开/按钮关｜盒子 ${Math.round(fsb.x)},${Math.round(fsb.y)} ${Math.round(fsb.w)}×${Math.round(fsb.h)}`
      + `｜画布 ${fsc.pixelW}×${fsc.pixelH}｜四角命中 ${full.cornersHit}`
      + `｜巡航 frame ${motionBefore.rendererFrame}→${motionDuring.rendererFrame}`
      + `｜收起按钮 ${Math.round(closeTap.w)}×${Math.round(closeTap.h)}`
      + `｜关闭后 full/auto/inert=${closed.layout.cloudFull}/${closed.render.auto}/${closed.backgroundInert}`);

  await evalJs('document.getElementById("board").scrollIntoView({ block: "center" })');
  await settleLayout();
  let mobileLeftCloud = null;
  for (let i = 0; i < 75; i++) {
    mobileLeftCloud = await evalJs('window.__cloudStats()');
    if (
      mobileLeftCloud.depth === 3
      && mobileLeftCloud.deepPending
      && !mobileLeftCloud.layers.some((layer) => layer.depth === 4)
    ) break;
    await sleep(40);
  }
  const mobileLeftMap = await evalJs('window.__test.cloudMap()');
  await evalJs('document.getElementById("skyBox").scrollIntoView({ block: "center" })');
  await settleLayout();
  const mobileReopenTouched = await touchSelector('#cloudOpen');
  const mobileReenteredCloud = await waitCloud(60000);
  await settleLayout();
  const mobileReenteredMap = await evalJs('window.__test.cloudMap()');
  const mobileReenteredRender = await evalJs('window.__test.renderStats()');
  const mobileClosedAgain = await closeCloudAndWaitPreview(true);
  const mobileClosedMap = await evalJs('window.__test.cloudMap()');
  const idleStart = await waitCloudRenderIdle();
  await sleep(700);
  const idleEnd = await evalJs('({ raf: window.__rafAudit.read(), render: window.__test.renderStats() })');
  const postCloseRaf = idleEnd.raf.fired - idleStart.raf.fired;
  const postCloseFrames = idleEnd.render.rendererFrame - idleStart.render.rendererFrame;
  const postCloseCameraStable = idleStart.render.cameraMatrix.every(
    (value, index) => Math.abs(value - idleEnd.render.cameraMatrix[index]) <= 1e-7,
  );
  record(
    offscreenCloud.stats.depth === 3
      && hasExactCloudDepths(offscreenCloud.stats, 3)
      && mobilePreviewCloud.depth === 3
      && hasExactCloudDepths(mobilePreviewCloud, 3)
      && mobileEnteredCloud.depth === 4
      && hasExactCloudDepths(mobileEnteredCloud, 4)
      && mobileEnteredCloud.layers.some((layer) => layer.depth === 4)
      && mobileLeftCloud.depth === 3
      && hasExactCloudDepths(mobileLeftCloud, 3)
      && mobileLeftCloud.deepPending === true
      && !mobileLeftCloud.layers.some((layer) => layer.depth === 4)
      && !mobileLeftMap.layers.some((layer) => layer.depth === 4)
      && mobileLeftMap.orphanRenderObjects === 0
      && mobileReopenTouched
      && mobileReenteredCloud.depth === 4
      && hasExactCloudDepths(mobileReenteredCloud, 4)
      && mobileReenteredCloud.layers.some((layer) => layer.depth === 4)
      && mobileReenteredCloud.nodes === count(mobileReenteredCloud.fen, 4)
      && mobileReenteredMap.layers.every((layer) => layer.objects === 1)
      && mobileReenteredRender.renderCalls <= 7
      && mobileClosedAgain.depth === 3
      && hasExactCloudDepths(mobileClosedAgain, 3)
      && mobileClosedMap.layers.every((layer) => layer.depth <= 3 && layer.objects === 1)
      && idleEnd.render.geometries < mobileReenteredRender.geometries
      && idleEnd.render.auto === false
      && idleEnd.render.scheduled === false
      && idleEnd.render.runningAnimations === 0
      && postCloseRaf <= 1
      && postCloseFrames <= 1
      && postCloseCameraStable,
    '④ 手机只有放大时加载 L4，收起即释放；再次放大仍能完整长回',
    `缩略 ${JSON.stringify(mobilePreviewCloud.layers.map((layer) => layer.depth))}`
      + ` → 放大 ${JSON.stringify(mobileEnteredCloud.layers.map((layer) => layer.depth))}/${mobileEnteredCloud.nodes}`
      + ` → 收起 ${JSON.stringify(mobileLeftCloud.layers.map((layer) => layer.depth))}/pending=${mobileLeftCloud.deepPending}`
      + `/scene=${JSON.stringify(mobileLeftMap.layers.map((layer) => layer.depth))}`
      + ` → 再放大 ${JSON.stringify(mobileReenteredCloud.layers.map((layer) => layer.depth))}/${mobileReenteredCloud.nodes}`
      + ` calls=${mobileReenteredRender.renderCalls}`
      + ` → 再收起 ${JSON.stringify(mobileClosedAgain.layers.map((layer) => layer.depth))}`
      + ` geometries=${mobileReenteredRender.geometries}→${idleEnd.render.geometries}`
      + `｜静置 rAF/WebGL=${postCloseRaf}/${postCloseFrames}`);

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
    if (mobileAi?.painted && touched.length >= 2 && !mobileState.state.thinking) break;
    await sleep(50);
  }
  const mobileAiWall = Date.now() - mobileAiStart;
  record(
    touched[0] === 'e4'
      && touched.length === 2
      && mobileAi?.painted === true
      && mobileAi?.totalMs <= 3000
      && mobileAiWall <= 3000,
    '④ 手机真实触摸能走 e4，AI 仍在 3 秒内合法应手',
    `外部秒表 ${mobileAiWall}ms｜棋谱 ${JSON.stringify(touched)}｜${mobileAi ? `搜到 ${mobileAi.depth} 层` : 'AI 未返回'}`);

  // 844×390 短横屏：允许页面纵滚，但不能再把棋盘裁到屏外或压住路径网。
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

  // 844×390 也是常见 iPhone 横屏宽度，不能只验普通页面、却让全屏变体棋盘沿用桌面布局被裁掉。
  await waitCloudPreview();
  const wideFullOpened = await touchSelector('#cloudOpen');
  await sleep(220);
  await settleLayout();
  const wideFull = await evalJs(`(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const targetButtons = [
      ...document.querySelectorAll('#cloudControls button'),
      document.getElementById('exploreReset'),
      document.querySelector('#explorePath button'),
      document.querySelector('#exploreChoices button'),
      document.querySelector('button.cloud-root-label'),
    ].filter(Boolean);
    const choices = document.getElementById('exploreChoices');
    return {
      full: document.body.classList.contains('cloud-full'),
      panel: box('#cloudExplorer'),
      board: box('#exploreBoard'),
      summary: box('#exploreSummary'),
      choices: box('#exploreChoices'),
      choicesClientH: choices.clientHeight,
      choicesScrollH: choices.scrollHeight,
      targets: targetButtons.map((button) => {
        const r = button.getBoundingClientRect();
        const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          id: button.id || button.textContent.trim(),
          w: r.width, h: r.height,
          inside: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
          hit: !!hit && hit.closest('button') === button,
        };
      }),
      render: window.__test.renderStats(),
      viewport: { w: innerWidth, h: innerHeight },
      backgroundInert:
        document.getElementById('boardPanel').inert
        && document.getElementById('stage').inert,
    };
  })()`);
  const wideFullFile = `${shotBase}-mobile-844-landscape-explorer.png`;
  const wideFullShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(wideFullFile, Buffer.from(wideFullShot.data, 'base64'));
  const wideFullClosed = await closeCloudAndWaitPreview(true);
  const wideFullOk =
    wideFullOpened
    && wideFull.full
    && wideFull.panel.x >= -1
    && wideFull.panel.y >= -1
    && wideFull.panel.right <= wideFull.viewport.w + 1
    && wideFull.panel.bottom <= wideFull.viewport.h + 1
    && wideFull.panel.w <= wideFull.viewport.w * .5
    && wideFull.board.w >= 108
    && wideFull.board.w <= 140
    && Math.abs(wideFull.board.w - wideFull.board.h) <= 1
    && wideFull.summary.bottom <= wideFull.choices.y + 1
    && wideFull.choicesClientH >= 80
    && wideFull.choicesScrollH > wideFull.choicesClientH
    && wideFull.targets.length >= 9
    && wideFull.targets.every((target) =>
      target.w >= 43.9 && target.h >= 43.9 && target.inside && target.hit)
    && wideFull.render.dpr <= 1.25
    && wideFull.backgroundInert
    && wideFullClosed.depth === 3;
  record(
    wideFullOk,
    '④ 844×390 真实手机横屏的放大探索也完整可看、可点、可滚动、可收起',
    `panel=${Math.round(wideFull.panel.w)}×${Math.round(wideFull.panel.h)}`
      + `｜board=${Math.round(wideFull.board.w)}`
      + `｜choices=${Math.round(wideFull.choicesClientH)}/${Math.round(wideFull.choicesScrollH)}`
      + `｜targets=${wideFull.targets.length}`
      + ` bad=${wideFull.targets.filter((target) =>
        target.w < 43.9 || target.h < 43.9 || !target.inside || !target.hit)
        .map((target) => target.id).join(',') || '无'}`
      + `｜DPR=${wideFull.render.dpr}｜截图 ${wideFullFile}`);

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
  await waitCloudPreview();
  const smallFullOpened = await touchSelector('#cloudOpen');
  await sleep(220);
  await settleLayout();
  const smallFull = await evalJs(`(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const targetButtons = [
      ...document.querySelectorAll('#cloudControls button'),
      document.getElementById('exploreReset'),
      document.querySelector('#explorePath button'),
      document.querySelector('#exploreChoices button'),
      document.querySelector('button.cloud-root-label'),
    ].filter(Boolean);
    return {
      full: document.body.classList.contains('cloud-full'),
      panel: box('#cloudExplorer'),
      board: box('#exploreBoard'),
      summary: box('#exploreSummary'),
      choices: box('#exploreChoices'),
      targets: targetButtons.map((button) => {
        const r = button.getBoundingClientRect();
        const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          id: button.id || button.textContent.trim(),
          w: r.width, h: r.height,
          inside: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
          hit: !!hit && hit.closest('button') === button,
        };
      }),
      choicesClientH: document.getElementById('exploreChoices').clientHeight,
      choicesScrollH: document.getElementById('exploreChoices').scrollHeight,
      render: window.__test.renderStats(),
      viewport: { w: innerWidth, h: innerHeight },
      rootW: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      backgroundInert:
        document.getElementById('boardPanel').inert
        && document.getElementById('stage').inert,
    };
  })()`);
  const smallFullFile = `${shotBase}-mobile-landscape-explorer.png`;
  const smallFullShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(smallFullFile, Buffer.from(smallFullShot.data, 'base64'));
  const smallFullClosed = await closeCloudAndWaitPreview(true);
  const smallFullClosedUi = await evalJs(`({
    full: document.body.classList.contains('cloud-full'),
    closeDisplay: getComputedStyle(document.getElementById('cloudClose')).display,
  })`);
  const smallFullChecks = {
    opened: smallFullOpened && smallFull.full,
    panel:
      smallFull.panel.x >= -1
      && smallFull.panel.y >= -1
      && smallFull.panel.right <= smallFull.viewport.w + 1
      && smallFull.panel.bottom <= smallFull.viewport.h + 1,
    board: smallFull.board.w >= 108 && Math.abs(smallFull.board.w - smallFull.board.h) <= 1,
    summary: smallFull.summary.bottom <= smallFull.choices.y + 1,
    scrollable: smallFull.choicesScrollH > smallFull.choicesClientH,
    targets:
      smallFull.targets.length >= 9
      && smallFull.targets.every((target) =>
        target.w >= 43.9 && target.h >= 43.9 && target.inside && target.hit),
    dpr: smallFull.render.dpr <= 1.25,
    rootWidth: smallFull.rootW >= smallFull.scrollW - 1,
    inert: smallFull.backgroundInert,
    closed:
      smallFullClosed.depth === 3
      && !smallFullClosedUi.full
      && smallFullClosedUi.closeDisplay === 'none',
  };
  const smallFullOk = Object.values(smallFullChecks).every(Boolean);
  const smallFullBadTargets = smallFull.targets.filter(
    (target) =>
      target.w < 43.9
      || target.h < 43.9
      || !target.inside
      || !target.hit,
  );

  await setViewport(1024, 768, 'landscapePrimary');
  await evalJs('window.scrollTo(0, 0)');
  await settleLayout();
  const tablet = await evalJs('window.__test.layout()');
  const tabletProblems = layoutProblems(tablet);
  const tabletTargets = [...tablet.controls.buttons, tablet.controls.firstCard].filter(Boolean);
  const tabletTwoColumn =
    Math.abs(tablet.panels.boardPanel.docY - tablet.panels.stage.docY) <= 1
    && tablet.panels.boardPanel.docRight <= tablet.panels.stage.docX + 1
    && tablet.panels.cloudPanel.docY > tablet.panels.boardPanel.docY;
  record(
    Math.abs(landscape.board.w - landscape.board.h) <= 1
      && landscape.board.docX >= -1
      && landscape.board.docRight <= landscape.viewport.w + 1
      && landscapeTargetsOk
      && smallProblems.length === 0
      && smallTwoColumn
      && smallTargets.length > 0 && smallTargets.every((r) => r.h >= 43.9)
      && smallFullOk
      && tabletProblems.length === 0
      && tabletTwoColumn
      && tabletTargets.length > 0 && tabletTargets.every((r) => r.h >= 43.9),
    '④ 常见手机横屏与平板均完整；667×375 放大探索可看、可点、可收起',
    `844 棋盘 ${Math.round(landscape.board.w)}px`
      + `｜667 双栏 ${smallTwoColumn ? '是' : '否'} / ${smallProblems.length ? smallProblems.join('; ') : '无重叠'}`
      + ` / 全屏=${smallFullOk} board=${Math.round(smallFull.board.w)}px DPR=${smallFull.render.dpr}`
      + ` fail=${Object.entries(smallFullChecks).filter(([, ok]) => !ok).map(([key]) => key).join('/') || '无'}`
      + ` badTargets=${smallFullBadTargets.map((target) =>
        `${target.id}:${target.w.toFixed(1)}×${target.h.toFixed(1)}/${target.inside}/${target.hit}`).join(',') || '无'}`
      + `｜1024 双栏 ${tabletTwoColumn ? '是' : '否'} / ${tabletProblems.length ? tabletProblems.join('; ') : '无重叠'}`
      + `｜横屏截图 ${smallFullFile}`);

  } finally {
    try {
      const full = await evalJs('document.body.classList.contains("cloud-full")');
      if (full) await evalJs('window.__test.toggleCloudFull()');
    } catch {}
    try { await send('Emulation.clearDeviceMetricsOverride'); } catch {}
    try { await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 }); } catch {}
  }
}

async function runPvGuideChecks() {
  try {
    const fixedPvStart = await evalJs(`(() => {
      window.__test.loadFen('7k/8/5K2/8/8/8/8/6R1 w - - 0 1');
      const played = window.__test.tryMove('g1', 'h1');
      return {
        played,
        sourceFen: window.__test.state().fen,
        pending: window.__test.aiPending(),
      };
    })()`);
    let fixedPv = null;
    for (let index = 0; index < 120; index++) {
      fixedPv = await evalJs(`({
        state: window.__test.state(),
        ai: window.__test.ai(),
        pv: window.__test.pv(),
        cols: window.__forkStats(),
      })`);
      if (fixedPv.ai?.painted && !fixedPv.state.thinking && fixedPv.pv?.active) break;
      await sleep(40);
    }
    await sleep(180);
    fixedPv = await evalJs(`({
      state: window.__test.state(),
      ai: window.__test.ai(),
      pv: window.__test.pv(),
      cols: window.__forkStats(),
    })`);

    const fullPvAudit = auditPrincipalVariation(fixedPvStart.sourceFen, fixedPv.ai);
    const expectedTail = fixedPv.ai?.pv?.slice(1) || [];
    const pvProjection = (steps) => steps.map((step) => ({
      index: step.index,
      from: step.from,
      to: step.to,
      promotion: step.promotion || '',
      san: step.san,
      after: step.after,
    }));
    const expectedProjection = expectedTail.map((step, index) => ({
      index,
      from: step.from,
      to: step.to,
      promotion: step.promotion || '',
      san: step.san,
      after: step.after,
    }));
    const railBefore = JSON.stringify(pvProjection(fixedPv.pv.steps));
    const pvDomSame = railBefore === JSON.stringify(expectedProjection);
    const samePvStep = (step, expected) =>
      !!step
      && !!expected
      && step.from === expected.from
      && step.to === expected.to
      && (step.promotion || '') === (expected.promotion || '')
      && step.san === expected.san
      && step.after === expected.after;
    const goldMappingOk = (snapshot) =>
      snapshot.goldCards.length > 0
      && snapshot.goldCards.every((card) =>
        samePvStep(card, expectedTail[card.index]))
      && snapshot.goldEdges.length === snapshot.goldCards.length
      && snapshot.goldEdges.every((edge) =>
        snapshot.goldCards.some(
          (card) => card.col === edge.col && card.index === edge.index,
        ));
    const pvFirstCard = fixedPv.pv.goldCards.find(
      (card) => card.index === 0 && card.col === 0,
    );
    const firstCol = fixedPv.cols[0];
    const altRank = firstCol
      ? [...Array(firstCol.total).keys()].find(
        (rank) => rank !== pvFirstCard?.rank && rank !== firstCol.chosenRank,
      ) ?? [...Array(firstCol.total).keys()].find((rank) => rank !== pvFirstCard?.rank) ?? -1
      : -1;
    const gameFenBeforePick = fixedPv.state.fen;
    const userPicked = altRank >= 0
      && await evalJs(`window.__test.pickBranch(0, ${altRank})`);
    const divergedPv = await evalJs(`({
      state: window.__test.state(),
      pv: window.__test.pv(),
      cols: window.__forkStats(),
    })`);
    const railAfter = JSON.stringify(pvProjection(divergedPv.pv.steps));
    const pvUiOk =
      fixedPvStart.played
      && fixedPvStart.pending?.fen === fixedPvStart.sourceFen
      && fixedPvStart.sourceFen === '7k/8/5K2/8/8/8/8/7R b - - 1 1'
      && fixedPv.ai?.pv?.[0]?.san === 'Kg8'
      && fixedPv.ai?.pv?.[0]?.after === '6k1/8/5K2/8/8/8/8/7R w - - 2 2'
      && fixedPv.state.fen === fixedPv.ai?.pv?.[0]?.after
      && fixedPv.pv.sourceFen === fixedPvStart.sourceFen
      && fixedPv.pv.rootFen === fixedPv.state.fen
      && String(fixedPv.pv.requestId) === String(fixedPvStart.pending?.id)
      && fixedPv.pv.depth === fixedPv.ai?.depth
      && fullPvAudit.ok
      && expectedTail.length > 0
      && pvDomSame
      && !!pvFirstCard
      && samePvStep(pvFirstCard, expectedTail[0])
      && goldMappingOk(fixedPv.pv)
      && fixedPv.pv.goldEdges.some((edge) => edge.col === 0)
      && fixedPv.pv.userEdges === fixedPv.cols.length
      && fixedPv.pv.userUnderlays === fixedPv.cols.length
      && userPicked
      && divergedPv.state.fen === gameFenBeforePick
      && divergedPv.cols[0]?.chosenRank === altRank
      && divergedPv.cols.every(
        (column) => column.selectedCards === 1 && column.selectedEdges === 1,
      )
      && divergedPv.pv.userEdges === divergedPv.cols.length
      && divergedPv.pv.userUnderlays === divergedPv.cols.length
      && railAfter === railBefore
      && goldMappingOk(divergedPv.pv)
      && divergedPv.pv.goldCards.every(
        (card) => card.col === 0 && card.selected === false,
      )
      && divergedPv.pv.goldEdges.length > 0
      && divergedPv.pv.goldEdges.every(
        (edge) => edge.col === 0
          && edge.route === 'engine-pv'
          && edge.selected === false,
      );
    record(
      pvUiOk,
      'AI 主变逐手同源；金线不覆盖蓝色选路，用户偏离后会在真实分歧处停止',
      pvUiOk
        ? `Worker ${fixedPv.ai.pv.map((move) => move.san).join(' → ')}`
          + `｜rail ${expectedTail.map((move) => move.san).join(' → ')}`
          + `｜用户改选 #${altRank + 1}，金边 ${fixedPv.pv.goldEdges.length}→${divergedPv.pv.goldEdges.length}`
        : [...fullPvAudit.problems,
          `DOM同源=${pvDomSame}`,
          `金卡同源=${goldMappingOk(fixedPv.pv)}/${goldMappingOk(divergedPv.pv)}`,
          `root/source=${fixedPv.pv.rootFen === fixedPv.state.fen}/${fixedPv.pv.sourceFen === fixedPvStart.sourceFen}`,
          `用户改选=${userPicked}/${divergedPv.cols[0]?.chosenRank}`,
          `金卡/边=${divergedPv.pv.goldCards.length}/${divergedPv.pv.goldEdges.length}`,
          `rail不变=${railAfter === railBefore}`].join('；'),
    );

    await evalJs('window.scrollTo(0, 0)');
    await settleLayout();
    const pvDesktopFile = SHOT.replace(/\.png$/i, '-pv-guide.png');
    const pvDesktopShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pvDesktopFile, Buffer.from(pvDesktopShot.data, 'base64'));

    await setViewport(390, 844, 'portraitPrimary');
    await evalJs(`document.getElementById('forkPvGuide').scrollIntoView({
      block: 'center',
      inline: 'nearest',
    })`);
    await settleLayout();
    const mobilePvBefore = await evalJs(`({
      pv: window.__test.pv(),
      layout: window.__test.layout(),
    })`);
    const rail = mobilePvBefore.pv.rail;
    const canSwipePv = rail && rail.scrollWidth > rail.clientWidth + 4;
    if (canSwipePv) {
      await swipeTouch(
        {
          x: rail.rect.right - 22,
          y: (rail.rect.y + rail.rect.bottom) / 2,
        },
        {
          x: rail.rect.x + 22,
          y: (rail.rect.y + rail.rect.bottom) / 2,
        },
        10,
      );
    }
    const mobilePvScrolled = await evalJs(`({
      pv: window.__test.pv(),
      layout: window.__test.layout(),
    })`);
    const pvMobileFile = SHOT.replace(/\.png$/i, '-pv-guide-mobile.png');
    const pvMobileShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pvMobileFile, Buffer.from(pvMobileShot.data, 'base64'));
    await waitCloudRenderIdle();
    const pvIdleA = await evalJs(`({
      raf: window.__rafAudit.read(),
      render: window.__test.renderStats(),
    })`);
    await sleep(250);
    const pvIdleB = await evalJs(`({
      raf: window.__rafAudit.read(),
      render: window.__test.renderStats(),
    })`);
    const guide = mobilePvScrolled.pv.guideRect;
    const noRootOverflow =
      Math.max(
        mobilePvScrolled.layout.root.scrollW,
        mobilePvScrolled.layout.body.scrollW,
      ) <= mobilePvScrolled.layout.root.clientW + 1;
    record(
      mobilePvScrolled.pv.active
        && mobilePvScrolled.pv.steps.length > 0
        && guide.w > 0 && guide.h > 0
        && guide.x >= -1 && guide.right <= 391
        && guide.bottom > 0 && guide.y < 844
        && mobilePvScrolled.pv.steps.every(
          (step) => step.rect.w > 0 && step.rect.h > 0 && step.visible,
        )
        && noRootOverflow
        && canSwipePv
        && mobilePvScrolled.pv.rail.scrollLeft > rail.scrollLeft + 10
        && pvIdleA.raf.pending === 0
        && pvIdleB.raf.pending === 0
        && pvIdleA.render.scheduled === false
        && pvIdleB.render.scheduled === false
        && pvIdleB.render.rendererFrame === pvIdleA.render.rendererFrame,
      '390px 手机能看清并横滑 AI 主变，静止后不持续重绘',
      `guide ${Math.round(guide.w)}×${Math.round(guide.h)}`
        + `｜rail ${rail.clientWidth}/${rail.scrollWidth}`
        + ` scroll ${rail.scrollLeft}→${mobilePvScrolled.pv.rail.scrollLeft}`
        + `｜根横溢=${!noRootOverflow}`
        + `｜250ms frame ${pvIdleA.render.rendererFrame}→${pvIdleB.render.rendererFrame}`
        + `｜截图 ${pvDesktopFile} / ${pvMobileFile}`,
    );
  } finally {
    try { await send('Emulation.clearDeviceMetricsOverride'); } catch {}
    try {
      await send('Emulation.setTouchEmulationEnabled', {
        enabled: false,
        maxTouchPoints: 1,
      });
    } catch {}
    try { await evalJs('window.__test.reset()'); } catch {}
    try { await settleLayout(); } catch {}
  }
}

async function runPhaseTwoNarrativeChecks() {
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await evalJs(`document.getElementById('cloudPanel').scrollIntoView({ block: 'center' })`);
  await sleep(120);
  await evalJs('window.__test.reset()');
  await sleep(32);
  const initial = await evalJs(`typeof window.__test.phaseTwoVisual === 'function'
    ? window.__test.phaseTwoVisual()
    : null`);
  if (!initial) {
    record(false, 'Phase 2 云线流动由共享 uniform 驱动且几何只增加方向属性', '旧实现没有 Phase 2 真值钩子');
    record(false, 'Phase 2 落子坍缩与 AI 搜索并行，旧云几何在动画期间守恒', '旧实现没有坍缩状态');
    record(false, 'Phase 2 思考脉冲按搜索生命周期启停并从选线末端重生新云', '旧实现没有脉冲 / 重生事件');
    record(false, 'Phase 2 数字只揭示真实值，减少动态与静置状态均完全停下', '旧实现没有数字收敛与停帧真值');
    return;
  }

  const earlyNumbers = initial.numbers;
  await waitCloudPreview();
  await waitCloudRenderIdle(8000);
  const stable = await evalJs('window.__test.phaseTwoVisual()');
  record(
    stable?.flow?.shaderMaterials === 5
      && stable?.flow?.cloudObjects > 0
      && stable?.flow?.progressAttributes === stable.flow.cloudObjects
      && stable?.flow?.directionPairsExact === true
      && stable?.flow?.geometryWritesPerFrame === 0
      && stable?.flow?.active === false,
    'Phase 2 云线流动由共享 uniform 驱动且几何只增加方向属性',
    stable
      ? `shader=${stable.flow.shaderMaterials}｜objects/progress=${stable.flow.cloudObjects}/${stable.flow.progressAttributes}`
        + `｜pairs=${stable.flow.directionPairsExact}｜frameWrites=${stable.flow.geometryWritesPerFrame}`
        + `｜active=${stable.flow.active}`
      : 'Phase 2 状态缺失',
  );

  const before = await evalJs('window.__cloudStats()');
  const started = await evalJs(`(() => {
    const played = window.__test.tryMove('e2', 'e4');
    return {
      played,
      pending: window.__test.aiPending(),
      visual: window.__test.phaseTwoVisual(),
      cloud: window.__cloudStats(),
    };
  })()`);
  await sleep(40);
  const mid = await evalJs('({ visual: window.__test.phaseTwoVisual(), cloud: window.__cloudStats() })');
  if (PHASE_TWO_ONLY) {
    const collapseShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(collapseShot.data, 'base64'));
  }
  record(
    started.played
      && !!started.pending
      && started.visual?.collapse?.active === true
      && started.visual?.collapse?.snapshotEdges === before.totalNodes
      && started.visual?.collapse?.selectedLine === true
      && started.visual?.collapse?.configuredMs >= 580
      && started.visual?.collapse?.configuredMs <= 1220
      && started.visual?.timing?.searchStartedAt > 0
      && started.visual?.timing?.collapseStartedAt >= started.visual.timing.searchStartedAt
      && started.visual.timing.collapseStartedAt - started.visual.timing.searchStartedAt < 80
      && mid.visual?.collapse?.progress >= 0
      && mid.visual?.collapse?.progress < 1
      && mid.visual?.collapse?.snapshotEdges === before.totalNodes,
    'Phase 2 落子坍缩与 AI 搜索并行，旧云几何在动画期间守恒',
    `played=${started.played}｜pending=${!!started.pending}`
      + `｜snapshot=${started.visual?.collapse?.snapshotEdges}/${before.totalNodes}`
      + `｜progress=${mid.visual?.collapse?.progress?.toFixed?.(3) ?? '无'}`
      + `｜paused=${started.visual?.narrative?.paused}:${started.visual?.narrative?.pauseReasons?.join(',') || '-'} reduced=${started.visual?.reducedMotion}`
      + `｜search→collapse=${Math.round((started.visual?.timing?.collapseStartedAt || 0) - (started.visual?.timing?.searchStartedAt || 0))}ms`
      + `｜duration=${started.visual?.collapse?.configuredMs ?? '无'}ms`,
  );

  const immediatePulse = started.visual?.pulse;
  for (let i = 0; i < 160; i++) {
    const done = await evalJs('window.__test.state().history.length >= 2 && !window.__test.state().thinking');
    if (done) break;
    await sleep(40);
  }
  let narrativeDone = false;
  for (let i = 0; i < 160; i++) {
    narrativeDone = await evalJs(`(() => {
      const visual = window.__test.phaseTwoVisual();
      return !visual.narrative.active && visual.events.some((event) => event.type === 'rebirth_completed');
    })()`);
    if (narrativeDone) break;
    await sleep(40);
  }
  const finished = await evalJs('window.__test.phaseTwoVisual()');
  const eventTypes = finished.events.map((event) => event.type);
  record(
    immediatePulse?.active === true
      && immediatePulse?.objects === 1
      && finished.pulse.active === false
      && finished.pulse.objects === 0
      && eventTypes.includes('thinking_pulse_started')
      && eventTypes.includes('thinking_pulse_stopped')
      && eventTypes.includes('collapse_completed')
      && eventTypes.includes('rebirth_started')
      && eventTypes.includes('rebirth_completed')
      && eventTypes.indexOf('thinking_pulse_started') < eventTypes.indexOf('thinking_pulse_stopped')
      && eventTypes.indexOf('rebirth_started') < eventTypes.indexOf('rebirth_completed')
      && narrativeDone,
    'Phase 2 思考脉冲按搜索生命周期启停并从选线末端重生新云',
    `pulse=${immediatePulse?.active}/${finished.pulse.active}`
      + `｜objects=${immediatePulse?.objects}/${finished.pulse.objects}`
      + `｜events=${eventTypes.join('→')}｜done=${narrativeDone}`,
  );

  await send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await sleep(100);
  await evalJs('window.__test.reset()');
  await sleep(40);
  const reducedEarly = await evalJs('window.__test.phaseTwoVisual()');
  await waitCloudPreview();
  await waitCloudRenderIdle(8000);
  const idleBefore = await evalJs('({ raf: window.__rafAudit.read(), visual: window.__test.phaseTwoVisual() })');
  await sleep(700);
  const idleAfter = await evalJs('({ raf: window.__rafAudit.read(), visual: window.__test.phaseTwoVisual() })');
  record(
    earlyNumbers?.source === 'geometry-position-count'
      && earlyNumbers?.items?.length > 0
      && earlyNumbers.items.every((item) => item.exact === true)
      && earlyNumbers.items.some((item) =>
        item.converging === true && item.animationName === 'future-count-converge')
      && reducedEarly?.reducedMotion === true
      && reducedEarly?.numbers?.activeAnimations === 0
      && reducedEarly?.numbers?.items?.every((item) => item.converging === false)
      && reducedEarly?.narrative?.active === false
      && idleAfter.raf.fired === idleBefore.raf.fired
      && idleAfter.visual.narrative.active === false,
    'Phase 2 数字只揭示真实值，减少动态与静置状态均完全停下',
    `numbers=${earlyNumbers?.items?.map((item) => `${item.depth}:${item.value}/${item.exact}/${item.converging}/${item.animationName}`).join(',') || '无'}`
      + `｜animations=${earlyNumbers?.activeAnimations ?? '无'}→${reducedEarly?.numbers?.activeAnimations ?? '无'}`
      + `｜reduced=${reducedEarly?.reducedMotion}｜700ms rAF ${idleBefore.raf.fired}→${idleAfter.raf.fired}`,
  );
  await send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await sleep(100);
  await evalJs('window.__test.reset()');
  await waitCloudPreview();
  await waitCloudRenderIdle(8000);
  await evalJs('window.scrollTo({ top: 0, behavior: "instant" })');
}

async function runPhaseThreeDetailChecks() {
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await evalJs('window.__test.reset()');
  await sleep(40);
  const visual = await evalJs(`typeof window.__test.phaseThreeVisual === 'function'
    ? window.__test.phaseThreeVisual()
    : null`);
  if (!visual) {
    record(false, 'Phase 3 国象选中棋子使用 2 秒呼吸光环且减少动态只留静态环', '旧实现没有 Phase 3 细节真值钩子');
    record(false, 'Phase 3 国象落点涟漪为 400ms 单次并在运动提交后出现', '旧实现没有落点涟漪');
    record(false, 'Phase 3 国象吃子碎裂为 8–12 粒、500ms 单次且不改棋子真值', '旧实现没有吃子碎裂');
    record(false, 'Phase 3 国象推演面板只在建立时播放约 200ms 扫描线', '旧实现没有面板扫描线');
    record(false, 'Phase 3 国象悬停连演路径按 ply 依次点亮且不改选路语义', '旧实现没有逐拍路径传导');
    return;
  }
  const panelEarly = visual.panels;
  await evalJs(`document.querySelector('#boardSquares [data-sq="e2"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(30);
  const selected = await evalJs('window.__test.phaseThreeVisual()');
  await send('Emulation.setEmulatedMedia', {
    media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await sleep(100);
  await evalJs(`(() => {
    window.__test.reset();
    document.querySelector('#boardSquares [data-sq="e2"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  const reducedSelected = await evalJs('window.__test.phaseThreeVisual()');
  record(
    selected.selection.rings === 1
      && selected.selection.square === 'e2'
      && selected.selection.animationName === 'detail-selection-breathe'
      && selected.selection.duration === '2s'
      && selected.selection.iterations === '1'
      && reducedSelected.reducedMotion === true
      && reducedSelected.selection.rings === 1
      && reducedSelected.selection.animationName === 'none',
    'Phase 3 国象选中棋子使用 2 秒呼吸光环且减少动态只留静态环',
    `normal=${JSON.stringify(selected.selection)}｜reduced=${JSON.stringify(reducedSelected.selection)}`,
  );
  await send('Emulation.setEmulatedMedia', {
    media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await sleep(100);
  await evalJs('window.__test.reset()');

  let panelBefore = null;
  for (let index = 0; index < 60; index++) {
    const first = await evalJs('window.__test.phaseThreeVisual().panels');
    await sleep(60);
    const second = await evalJs('window.__test.phaseThreeVisual().panels');
    panelBefore = second;
    if (second.active === 0 && second.started === first.started) break;
  }
  const panelSettled = await evalJs(`(() => {
    const before = window.__test.phaseThreeVisual();
    window.__test.rerenderFuture();
    const after = window.__test.phaseThreeVisual();
    return { before, after };
  })()`);
  record(
    panelEarly.configuredMs === 200
      && panelEarly.started > 0
      && panelSettled.before.panels.active === 0
      && panelSettled.after.panels.started === panelSettled.before.panels.started,
    'Phase 3 国象推演面板只在建立时播放约 200ms 扫描线',
    `early=${panelEarly.started}/${panelEarly.active}｜stable=${panelBefore?.started}/${panelBefore?.active}`
      + `｜settled=${panelSettled.before.panels.completed}/${panelSettled.before.panels.started}`
      + `｜rerender=${panelSettled.after.panels.started}`,
  );

  const captureStarted = await evalJs(`(() => {
    window.__test.loadFen('4k3/8/8/8/8/3p4/4P3/4K3 w - - 0 1');
    return window.__test.tryMove('e2', 'd3');
  })()`);
  let captureVisual = null;
  for (let index = 0; index < 30; index++) {
    captureVisual = await evalJs('window.__test.phaseThreeVisual()');
    if (captureVisual.capture.particles >= 8 && captureVisual.landing.objects === 1) break;
    await sleep(30);
  }
  const captureEvents = captureVisual.events.filter((event) =>
    ['piece_motion_completed', 'landing_ripple_started', 'capture_shatter_started'].includes(event.type)
      && event.source === 'player');
  const capturePieceTruth = await evalJs('window.__test.board().pieces.length');
  const impactShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    SHOT.replace(/\.png$/i, '-phase3-impact.png'),
    Buffer.from(impactShot.data, 'base64'),
  );
  record(
    captureStarted
      && captureVisual.landing.objects === 1
      && captureVisual.landing.duration === '0.4s'
      && captureVisual.landing.iterations === '1'
      && captureEvents.map((event) => event.type).join(',')
        === 'piece_motion_completed,landing_ripple_started,capture_shatter_started',
    'Phase 3 国象落点涟漪为 400ms 单次并在运动提交后出现',
    `objects=${captureVisual.landing.objects}｜duration=${captureVisual.landing.duration}`
      + `｜events=${captureEvents.map((event) => event.type).join('→')}`
      + `｜all=${captureVisual.events.map((event) => `${event.source || ''}:${event.type}`).join('/')}`,
  );
  await sleep(560);
  const captureCleared = await evalJs('window.__test.phaseThreeVisual()');
  record(
    captureVisual.capture.particles >= 8
      && captureVisual.capture.particles <= 12
      && captureVisual.capture.batches === 1
      && captureVisual.capture.duration === '0.5s'
      && captureVisual.capture.iterations === '1'
      && captureVisual.capture.renderedPieces === capturePieceTruth
      && capturePieceTruth === 3
      && captureCleared.capture.particles === 0,
    'Phase 3 国象吃子碎裂为 8–12 粒、500ms 单次且不改棋子真值',
    `particles=${captureVisual.capture.particles}→${captureCleared.capture.particles}`
      + `｜duration=${captureVisual.capture.duration}｜pieces=${captureVisual.capture.renderedPieces}/${capturePieceTruth}`,
  );

  await evalJs('window.__test.reset()');
  for (let index = 0; index < 100; index++) {
    const ready = await evalJs('!!document.querySelector("#fork g.card[data-col=\\"0\\"]")');
    if (ready) break;
    await sleep(40);
  }
  await evalJs(`(() => {
    const card = document.querySelector('#fork g.card[data-col="0"]');
    card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  })()`);
  let propagation = null;
  for (let index = 0; index < 80; index++) {
    propagation = await evalJs('window.__test.phaseThreeVisual()');
    if (propagation.propagation.kind === 'hover' && propagation.propagation.paths.length >= 4) break;
    await sleep(50);
  }
  const pathOrders = propagation.propagation.paths.map((path) => path.order);
  const propagationShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    SHOT.replace(/\.png$/i, '-phase3-hover.png'),
    Buffer.from(propagationShot.data, 'base64'),
  );
  await setViewport(390, 844, 'portraitPrimary');
  await sleep(80);
  const propagationMobileShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    SHOT.replace(/\.png$/i, '-phase3-hover-mobile.png'),
    Buffer.from(propagationMobileShot.data, 'base64'),
  );
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await settleLayout();
  record(
    propagation.propagation.kind === 'hover'
      && propagation.propagation.paths.length >= 4
      && pathOrders.every((order, index) => order === index + 1)
      && propagation.propagation.paths.every((path) => path.pathLength === 1)
      && propagation.propagation.paths.filter((path) => path.state === 'current').length === 1
      && propagation.propagation.paths.some((path) =>
        path.state === 'current'
        && path.animationName === 'detail-path-conduct'
        && path.animationDuration === '0.3s')
      && propagation.propagation.selectedPathLength === 0,
    'Phase 3 国象悬停连演路径按 ply 依次点亮且不改选路语义',
    `kind=${propagation.propagation.kind}｜orders=${pathOrders.join('/')}`
      + `｜states=${propagation.propagation.paths.map((path) => path.state).join('/')}`
      + `｜selected=${propagation.propagation.selectedPathLength}`,
  );
  await evalJs(`document.querySelector('#fork').dispatchEvent(new PointerEvent('pointerleave', {
    bubbles: true, pointerType: 'mouse'
  }))`);
}

async function runPhaseOneVisualChecks() {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    screenWidth: 1440, screenHeight: 900,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await evalJs('window.__test.reset()');
  await waitCloudPreview();
  const fullCloud = await openCloudAndWait();
  await waitCloudRenderIdle();

  const visual = await evalJs(`typeof window.__test.phaseOneVisual === 'function'
    ? window.__test.phaseOneVisual()
    : null`);
  record(
    visual?.composerCount === 1
      && visual?.passes?.filter((pass) => pass === 'UnrealBloomPass').length === 1
      && visual?.bloom?.enabled === true
      && visual?.bloom?.layer === 1
      && visual?.bloom?.eligibleObjects > 0
      && visual?.bloom?.outsideLayer === 0
      && visual?.dom?.labelsInWebgl === 0
      && visual?.renderer?.preserveDrawingBuffer === false,
    'Phase 1 单 Composer 选择性 bloom 只接管云线与“现在”节点',
    visual
      ? `composer=${visual.composerCount}｜passes=${visual.passes.join('/')}`
        + `｜layer=${visual.bloom.layer}｜eligible/outside=${visual.bloom.eligibleObjects}/${visual.bloom.outsideLayer}`
        + `｜preserve=${visual.renderer.preserveDrawingBuffer}`
      : '旧实现没有 Phase 1 渲染真值钩子',
  );
  record(
    visual?.materials?.cloudLineObjects > 0
      && visual?.materials?.additiveObjects === visual.materials.cloudLineObjects
      && visual?.now?.objects === 1
      && visual?.now?.countedInCloudStats === false
      && visual?.palette?.depths?.length === 5
      && visual.palette.depths.every((entry, index, list) =>
        index === 0 || entry.luminance <= list[index - 1].luminance + 0.001)
      && visual.palette.warm.r > visual.palette.warm.b
      && visual.palette.cold.b > visual.palette.cold.r
      && fullCloud.nodes === count(fullCloud.fen, fullCloud.depth),
    'Phase 1 加法混合、逐层降亮与暖白/冷蓝语义不污染路径真值',
    visual
      ? `additive=${visual.materials.additiveObjects}/${visual.materials.cloudLineObjects}`
        + `｜now=${visual.now.objects}/${visual.now.countedInCloudStats}`
        + `｜L=${visual.palette.depths.map((entry) => entry.luminance.toFixed(3)).join('→')}`
        + `｜nodes=${fullCloud.nodes}`
      : '旧实现仍是 NormalBlending 且没有独立“现在”节点',
  );

  let bloomDiff = null;
  let bloomImageStats = null;
  let bloomRestored = false;
  if (visual && typeof visual.bloom?.enabled === 'boolean') {
    const bloomOnFile = SHOT.replace(/\.png$/i, '-phase1-bloom-on.png');
    const bloomOffFile = SHOT.replace(/\.png$/i, '-phase1-bloom-off.png');
    await evalJs('window.__test.setBloomEnabled(true)');
    await settleLayout();
    const bloomOn = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(bloomOnFile, Buffer.from(bloomOn.data, 'base64'));
    await evalJs('window.__test.setBloomEnabled(false)');
    await settleLayout();
    const bloomOff = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(bloomOffFile, Buffer.from(bloomOff.data, 'base64'));
    bloomRestored = await evalJs('window.__test.setBloomEnabled(true)');
    await settleLayout();
    const skyRect = await evalJs('window.__test.skyRect()');
    bloomDiff = cloudPathPixelDiff(bloomOnFile, bloomOffFile, skyRect, 1);
    bloomImageStats = shotStats(bloomOnFile, skyRect);
  }
  record(
    bloomRestored
      && bloomDiff?.changedRatio > 0.0001
      && bloomDiff?.changedRatio < 0.25
      && bloomDiff?.spanX > 0.08
      && bloomDiff?.spanY > 0.10
      && bloomImageStats?.brightRatio < 0.20,
    'Phase 1 bloom 开关在真实截图的密集云区产生克制像素差',
    bloomDiff
      ? `changed=${bloomDiff.changed}/${bloomDiff.total} (${bloomDiff.changedRatio})`
        + `｜span=${bloomDiff.spanX}/${bloomDiff.spanY}`
        + `｜bright=${bloomImageStats?.brightRatio}｜restored=${bloomRestored}`
      : '旧实现没有可对撞的 bloom 开关',
  );

  const cinemaUrl = new URL(URL_);
  cinemaUrl.searchParams.set('cinema', '1');
  await send('Page.navigate', { url: cinemaUrl.href });
  let cinemaReady = false;
  for (let i = 0; i < 200; i++) {
    try {
      cinemaReady = await evalJs('typeof window.__test === "object"');
      if (cinemaReady) break;
    } catch {}
    await sleep(25);
  }
  await send('Page.bringToFront');
  let cinema = null;
  if (cinemaReady) {
    const hasVisualHook = await evalJs('typeof window.__test.phaseOneVisual === "function"');
    if (hasVisualHook) {
      await waitCloud();
      await waitCloudRenderIdle();
    } else {
      await sleep(700);
    }
    cinema = await evalJs(`(() => {
      const visible = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      };
      const canvas = document.getElementById('sky').getBoundingClientRect();
      const cloud = window.__cloudStats();
      return {
        visual: typeof window.__test.phaseOneVisual === 'function'
          ? window.__test.phaseOneVisual() : null,
        cloud,
        legend: document.getElementById('cloudLayerLegend').textContent.trim(),
        visible: {
          canvas: visible('#sky'), legend: visible('#cloudLayerLegend'),
          product: visible('#productBar'), board: visible('#boardPanel'), stage: visible('#stage'),
          controls: visible('#cloudControls'), explorer: visible('#cloudExplorer'),
          labels: visible('#cloudLabels'), hint: visible('#skyHint'), cloudTitle: visible('#cloudPanel > h1'),
        },
        canvas: { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height },
        viewport: { w: innerWidth, h: innerHeight },
      };
    })()`);
    const cinemaShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      SHOT.replace(/\.png$/i, '-phase1-cinema.png'),
      Buffer.from(cinemaShot.data, 'base64'),
    );
  }
  const hiddenUi = cinema && Object.entries(cinema.visible)
    .filter(([name]) => !['canvas', 'legend'].includes(name))
    .every(([, visible]) => !visible);
  const expectedLegend = cinema?.cloud?.layers
    ?.map((layer) => `${layer.depth === 0 ? '现在' : `${layer.depth}步后`} ${layer.nodes.toLocaleString('en-US')}`)
    .join('　·　');
  record(
    cinema?.visual?.cinema?.enabled === true
      && cinema?.visual?.cinema?.full === true
      && cinema?.cloud?.depth === 4
      && cinema?.cloud?.growing === false
      && cinema?.visible?.canvas
      && cinema?.visible?.legend
      && hiddenUi
      && cinema?.legend === expectedLegend
      && cinema?.canvas?.x <= 1 && cinema?.canvas?.y <= 1
      && Math.abs(cinema.canvas.w - cinema.viewport.w) <= 2
      && Math.abs(cinema.canvas.h - cinema.viewport.h) <= 2,
    'Phase 1 ?cinema=1 只保留全屏云图与真实层数行',
    cinema
      ? `depth=${cinema.cloud.depth}｜legend=${cinema.legend}`
        + `｜canvas=${Math.round(cinema.canvas.w)}×${Math.round(cinema.canvas.h)}`
        + `｜hidden=${hiddenUi}`
      : '影院模式未就绪',
  );
}

async function main() {
  if (PORT > 0) {
    if (await portInUse(PORT)) throw new Error(`CDP 端口 ${PORT} 已被占用，请换一个 --port`);
  }
  if (!URL_) URL_ = await serveLocal();
  else URL_ = chessPageUrl(URL_);
  chromeProcess = await launchChrome();
  console.log(`验收目标: ${URL_}（CDP ${PORT}）\n`);
  await attach();

  // 独立包裹真实 rAF：性能断言不相信页面自记的“我已经停了”，而是从导航前开始数浏览器实际回调。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const realRaf = window.requestAnimationFrame.bind(window);
      const realCaf = window.cancelAnimationFrame.bind(window);
      let requested = 0, fired = 0, cancelled = 0;
      const pending = new Set();
      window.requestAnimationFrame = (callback) => {
        requested++;
        let id;
        id = realRaf((time) => {
          pending.delete(id);
          fired++;
          callback(time);
        });
        pending.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        if (pending.delete(id)) cancelled++;
        return realCaf(id);
      };
      window.__rafAudit = { read: () => ({ requested, fired, cancelled, pending: pending.size }) };
      const visibilityStates = [document.visibilityState];
      document.addEventListener('visibilitychange', () => visibilityStates.push(document.visibilityState));
      window.__visibilityAudit = { read: () => visibilityStates.slice() };
    })();`,
  });
  await send('Page.navigate', { url: URL_ });
  let ready = false;
  for (let i = 0; i < 160; i++) {
    try {
      ready = await evalJs('typeof window.__test === "object"');
      if (ready) break;
    } catch {}
    await sleep(25);
  }
  if (!ready) throw new Error('页面自检钩子未就绪');
  await send('Page.bringToFront');

  if (PHASE_ONE_ONLY) {
    await runPhaseOneVisualChecks();
    record(pageErrors.length === 0, '页面无 JS 报错', pageErrors.slice(0, 3).join(' | ') || '零报错');
    await finishRun(5);
    return;
  }
  if (PHASE_TWO_ONLY) {
    await runPhaseTwoNarrativeChecks();
    record(pageErrors.length === 0, '页面无 JS 报错', pageErrors.slice(0, 3).join(' | ') || '零报错');
    await finishRun(5);
    return;
  }
  if (PHASE_THREE_ONLY) {
    await runPhaseThreeDetailChecks();
    record(pageErrors.length === 0, '页面无 JS 报错', pageErrors.slice(0, 3).join(' | ') || '零报错');
    await finishRun(6);
    return;
  }

  // 用户不会等第四层云长满才落子：首屏一能操作就立刻走，AI 仍必须守住 3 秒。
  const coldStartedAt = Date.now();
  const coldStart = await evalJs(`(() => {
    const reset = window.__test.reset();
    const cloud = window.__cloudStats();
    const played = window.__test.tryMove('e2', 'e4');
    return { reset, cloud, played };
  })()`);
  const coldCloud = coldStart.cloud;
  const coldPlayed = coldStart.played;
  let coldAi = null, coldState = null;
  while (Date.now() - coldStartedAt < 6000) {
    const current = await evalJs('({ ai: window.__test.ai(), state: window.__test.state() })');
    coldAi = current.ai;
    coldState = current.state;
    if (coldAi?.painted && coldState.history.length >= 2 && !coldState.thinking) break;
    await sleep(40);
  }
  const coldWall = Date.now() - coldStartedAt;
  let coldReplayOk = false;
  try {
    const replay = new Chess();
    for (const san of coldState?.history || []) replay.move(san);
    coldReplayOk = replay.fen() === coldState?.fen && coldState?.history?.length === 2;
  } catch {}
  record(
    coldStart.reset
      && coldCloud.growing === true
      && coldCloud.depth < 4
      && coldPlayed === true
      && !!coldAi
      && coldAi.painted === true
      && coldWall <= 3000
      && coldReplayOk,
    '首屏云仍在计算时立即落子，AI 仍在 3 秒内合法应手',
    `落子时云 depth=${coldCloud.depth}/growing=${coldCloud.growing}`
      + `｜外部 ${coldWall}ms｜页面 ${coldAi?.totalMs ?? '无'}ms`
      + `｜${coldAi?.fallback ? `保底(${coldAi.reason})` : `搜到 ${coldAi?.depth ?? '无'} 层`}`
      + `｜棋谱 ${JSON.stringify(coldState?.history || [])}`);
  await evalJs('window.__test.reset()');

  // 1) 缩略窗只铺到 L3，并且稳定后浏览器不再持续 requestAnimationFrame / WebGL 重绘。
  const preview1 = await waitCloudPreview();
  await settleLayout();
  const idleBefore = await evalJs('({ raf: window.__rafAudit.read(), render: window.__test.renderStats() })');
  await sleep(700);
  const idleAfter = await evalJs('({ raf: window.__rafAudit.read(), render: window.__test.renderStats() })');
  const idleRafFired = idleAfter.raf.fired - idleBefore.raf.fired;
  const idleRenderFrames = idleAfter.render.rendererFrame - idleBefore.render.rendererFrame;
  const idleCameraStable = idleBefore.render.cameraMatrix.every(
    (value, index) => Math.abs(value - idleAfter.render.cameraMatrix[index]) <= 1e-7,
  );
  record(
    preview1.depth === 3
      && preview1.deepPending === true
      && hasExactCloudDepths(preview1, 3)
      && idleRafFired <= 1
      && idleRenderFrames <= 1
      && idleAfter.raf.pending === 0
      && idleAfter.render.scheduled === false
      && idleAfter.render.auto === false
      && idleCameraStable,
    '② 缩略路径网只建真实 L3，静置 700ms 后没有持续 rAF 或 WebGL 重绘',
    `layers=${JSON.stringify(preview1.layers.map((layer) => layer.depth))}`
      + `｜rAF +${idleRafFired} / WebGL frame +${idleRenderFrames}`
      + `｜pending=${idleAfter.raf.pending}/${idleAfter.render.scheduled}`
      + `｜camera stable=${idleCameraStable}`);

  // L3 已完整、L4 Worker 刚启动但首批尚未到达时切后台，是最容易丢 deepPending 的竞态窗口。
  const visibilityRaceStart = await evalJs(`(() => {
    window.__test.toggleCloudFull(true);
    const cloud = window.__cloudStats();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    document.querySelector('#exploreChoices button[data-explore-rank]')?.click();
    return { cloud, hiddenCloud: window.__cloudStats(), explorer: window.__test.explorer() };
  })()`);
  let lifecycleError = '';
  try {
    await sleep(160);
    await evalJs(`(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
      delete document.visibilityState;
    })()`);
    await send('Page.bringToFront');
  } catch (err) {
    lifecycleError = err?.message || String(err);
  }
  let visibilityRaceEnd = null;
  const visibilityRaceDeadline = Date.now() + 15000;
  while (!lifecycleError && Date.now() < visibilityRaceDeadline) {
    visibilityRaceEnd = await evalJs('window.__cloudStats()');
    if (visibilityRaceEnd.error || (!visibilityRaceEnd.growing && visibilityRaceEnd.depth >= 4)) break;
    await sleep(160);
  }
  const visibilityStates = await evalJs('window.__visibilityAudit.read()');
  const visibilityExplorerEnd = await evalJs('window.__test.explorer()');
  record(
    !lifecycleError
      && visibilityRaceStart.cloud.depth === 3
      && visibilityRaceStart.cloud.growing === true
      && !visibilityRaceStart.cloud.layers.some((layer) => layer.depth === 4)
      && visibilityRaceStart.explorer.path.length === 1
      && visibilityRaceStart.hiddenCloud.depth === 3
      && visibilityRaceStart.hiddenCloud.growing === false
      && visibilityRaceStart.hiddenCloud.deepPending === true
      && !visibilityRaceStart.hiddenCloud.layers.some((layer) => layer.depth === 4)
      && visibilityStates.includes('hidden')
      && visibilityStates.at(-1) === 'visible'
      && visibilityRaceEnd?.depth === 4
      && visibilityRaceEnd?.growing === false
      && visibilityRaceEnd?.deepPending === false
      && hasExactCloudDepths(visibilityRaceEnd, 4)
      && visibilityExplorerEnd.path.length === 1
      && visibilityExplorerEnd.path[0].after === visibilityRaceStart.explorer.path[0].after
      && visibilityExplorerEnd.gameFen === visibilityRaceStart.explorer.gameFen,
    '② L4 首批到达前切后台再回来，保留 L3 与选路并能自动续满 L4',
    `起点 depth/growing=${visibilityRaceStart.cloud.depth}/${visibilityRaceStart.cloud.growing}`
      + `｜后台 depth/growing/pending=${visibilityRaceStart.hiddenCloud.depth}`
      + `/${visibilityRaceStart.hiddenCloud.growing}/${visibilityRaceStart.hiddenCloud.deepPending}`
      + `｜visibility=${visibilityStates.join('→')}`
      + `｜回来 depth/growing/pending=${visibilityRaceEnd?.depth ?? '无'}`
      + `/${visibilityRaceEnd?.growing ?? '无'}/${visibilityRaceEnd?.deepPending ?? '无'}`
      + `｜选路 ${visibilityRaceStart.explorer.path.map((step) => step.san).join('→')}`
      + `→${visibilityExplorerEnd.path.map((step) => step.san).join('→')}`
      + `｜协议错误=${lifecycleError || '无'}`);
  await evalJs('document.getElementById("exploreReset").click()');
  await closeCloudAndWaitPreview();

  const futureContract = await evalJs(`(() => {
    const initial = window.__futureTest.snapshot();
    const initialButtons = {
      legacyDisabled: document.getElementById('btnPlayLine').disabled,
      commitDisabled: document.getElementById('futureCommit').disabled,
    };
    const liveBefore = window.__test.state();
    const key = initial.suggestedPath[0]?.afterFen || '';
    const selected = key ? window.__futureTest.selectNode(0, key) : false;
    const afterSelect = window.__futureTest.snapshot();
    const selectedButtons = {
      legacyDisabled: document.getElementById('btnPlayLine').disabled,
      commitDisabled: document.getElementById('futureCommit').disabled,
    };
    const liveAfterSelect = window.__test.state();
    const treeReturn = window.__futureTest.setMode('tree-2d');
    const tree = window.__futureTest.snapshot();
    const overviewReturn = window.__futureTest.setMode('overview-3d');
    const overview = window.__futureTest.snapshot();
    const rewound = window.__futureTest.rewind(0);
    const clean = window.__futureTest.snapshot();
    const cleanButtons = {
      legacyDisabled: document.getElementById('btnPlayLine').disabled,
      commitDisabled: document.getElementById('futureCommit').disabled,
    };
    return {
      initial, liveBefore, selected, afterSelect, liveAfterSelect,
      treeReturn, tree, overviewReturn, overview, rewound, clean,
      initialButtons, selectedButtons, cleanButtons,
    };
  })()`);
  const futureRootCount = count(futureContract.initial.root.fen, 1);
  const futureStep = futureContract.afterSelect.selectedPath[0];
  let futureStepReplays = false;
  try {
    const replay = new Chess(futureContract.initial.root.fen);
    const moved = replay.move({
      from: futureStep?.from,
      to: futureStep?.to,
      promotion: futureStep?.promotion || 'q',
    });
    futureStepReplays = !!moved
      && replay.fen() === futureStep?.afterFen
      && futureStep.branchCount === count(futureStep.afterFen, 1);
  } catch {}
  const futureSelectedFens = futureContract.afterSelect.selectedPath.map((step) => step.afterFen);
  record(
    futureContract.initial.schema === 1
      && futureContract.initial.game === 'chess'
      && futureContract.initial.selectedPath.length === 0
      && futureContract.initial.suggestedPath.length > 0
      && futureContract.initial.root.branchCount === futureRootCount
      && futureContract.selected === true
      && futureStepReplays
      && futureSelectedFens.length === 1
      && futureContract.afterSelect.preview.depth === 1
      && futureContract.afterSelect.preview.fen === futureStep?.afterFen
      && futureContract.liveAfterSelect.fen === futureContract.liveBefore.fen
      && JSON.stringify(futureContract.liveAfterSelect.history)
        === JSON.stringify(futureContract.liveBefore.history)
      && futureContract.treeReturn === '2d'
      && futureContract.tree.mode === 'tree-2d'
      && futureContract.overviewReturn === '3d'
      && futureContract.overview.mode === 'overview-3d'
      && futureContract.tree.preview.fen === futureContract.afterSelect.preview.fen
      && futureContract.overview.preview.fen === futureContract.afterSelect.preview.fen
      && JSON.stringify(futureContract.tree.selectedPath.map((step) => step.afterFen))
        === JSON.stringify(futureSelectedFens)
      && JSON.stringify(futureContract.overview.selectedPath.map((step) => step.afterFen))
        === JSON.stringify(futureSelectedFens)
      && futureContract.rewound === true
      && futureContract.clean.selectedPath.length === 0,
    '统一未来地图契约：推荐不冒充选路，2D/3D 共用合法预演且不改实战',
    `根=${futureRootCount}｜初始选路=${futureContract.initial.selectedPath.length}`
      + `｜选择后=${futureSelectedFens.length}｜合法=${futureStepReplays}`
      + `｜模式=${futureContract.tree.mode}→${futureContract.overview.mode}`
      + `｜实战未变=${futureContract.liveAfterSelect.fen === futureContract.liveBefore.fen}`,
  );
  record(
    futureContract.initialButtons.legacyDisabled
      && futureContract.initialButtons.commitDisabled
      && !futureContract.selectedButtons.legacyDisabled
      && !futureContract.selectedButtons.commitDisabled
      && futureContract.cleanButtons.legacyDisabled
      && futureContract.cleanButtons.commitDisabled,
    '引擎建议不能从旧按钮旁路落子，只有用户明确选路后两个确认入口才启用',
    `初始=${futureContract.initialButtons.legacyDisabled}/${futureContract.initialButtons.commitDisabled}`
      + `｜选路后=${futureContract.selectedButtons.legacyDisabled}/${futureContract.selectedButtons.commitDisabled}`
      + `｜清空后=${futureContract.cleanButtons.legacyDisabled}/${futureContract.cleanButtons.commitDisabled}`,
  );

  const hoverAuto = await evalJs(`(async () => {
    window.__futureTest.rewind(0);
    const liveBefore = window.__test.state();
    const fork = document.getElementById('fork');
    const candidates = [...fork.querySelectorAll('g.card[data-col="0"]')];
    const card = candidates.find((node) => node.dataset.idx === '1') || candidates[0];
    const first = card ? {
      from: card.dataset.from,
      to: card.dataset.to,
      promotion: card.dataset.promotion || '',
      san: card.dataset.san,
    } : null;
    card?.dispatchEvent(new PointerEvent('pointerover', {
      bubbles: true,
      pointerType: 'mouse',
    }));
    const started = performance.now();
    while (performance.now() - started < 5000) {
      const current = window.__futureTest.snapshot();
      if (current.preview.source === 'hover' && current.preview.depth === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const mouse = {
      future: window.__futureTest.snapshot(),
      state: window.__test.state(),
      board: {
        phase: document.getElementById('board').dataset.previewPhase,
        stepCount: Number(document.getElementById('board').dataset.previewStepCount),
        paths: document.querySelectorAll('#board [data-future-preview-step]').length,
      },
      bridge: {
        hidden: document.getElementById('chessPlayBridge').hidden,
        title: document.getElementById('chessPlayBridgeTitle').textContent,
        detail: document.getElementById('chessPlayBridgeDetail').textContent,
      },
      visibleAdoptButtons: [...document.querySelectorAll('button')].filter((button) => {
        const style = getComputedStyle(button);
        return button.textContent.trim() === '采纳首步继续'
          && !button.hidden
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && button.getClientRects().length > 0;
      }).length,
    };
    fork.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const cleared = window.__futureTest.snapshot();

    const keyboardCard = candidates.find((node) => node !== card) || card;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    keyboardCard?.focus({ preventScroll: true });
    const keyboardStarted = performance.now();
    while (performance.now() - keyboardStarted < 5000) {
      const current = window.__futureTest.snapshot();
      if (current.preview.source === 'hover' && current.preview.depth === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const keyboard = window.__futureTest.snapshot();
    keyboardCard?.blur();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const configured = window.__futureTest.setPreviewDepth(10);
    const depthControl = document.getElementById('chessPreviewDepth');
    card?.dispatchEvent(new PointerEvent('pointerover', {
      bubbles: true,
      pointerType: 'mouse',
    }));
    const deepStarted = performance.now();
    while (performance.now() - deepStarted < 6000) {
      const current = window.__futureTest.snapshot();
      if (current.preview.source === 'hover' && current.preview.depth === 10) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const deep = {
      future: window.__futureTest.snapshot(),
      selected: depthControl?.value || '',
      options: [...(depthControl?.options || [])].map((option) => Number(option.value)),
      height: depthControl?.getBoundingClientRect().height || 0,
      configured,
    };
    fork.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    window.__futureTest.setPreviewDepth(4);
    return { liveBefore, first, mouse, cleared, keyboard, deep };
  })()`, true);
  let hoverReplayOk = hoverAuto.mouse.future.preview.path.length === 4;
  try {
    const replay = new Chess(hoverAuto.mouse.future.root.fen);
    for (const step of hoverAuto.mouse.future.preview.path) {
      const played = replay.move({
        from: step.from,
        to: step.to,
        ...(step.promotion ? { promotion: step.promotion } : {}),
      });
      if (!played || replay.fen() !== step.afterFen) {
        hoverReplayOk = false;
        break;
      }
    }
  } catch {
    hoverReplayOk = false;
  }
  let deepReplayOk = hoverAuto.deep.future.preview.path.length === 10;
  try {
    const replay = new Chess(hoverAuto.deep.future.root.fen);
    for (const step of hoverAuto.deep.future.preview.path) {
      const played = replay.move({
        from: step.from,
        to: step.to,
        ...(step.promotion ? { promotion: step.promotion } : {}),
      });
      if (!played || replay.fen() !== step.afterFen) {
        deepReplayOk = false;
        break;
      }
    }
  } catch {
    deepReplayOk = false;
  }
  const hoverChecks = {
    candidate: !!hoverAuto.first,
    mouseSource: hoverAuto.mouse.future.preview.source === 'hover',
    mouseDepth: hoverAuto.mouse.future.preview.depth === 4,
    noSelection: hoverAuto.mouse.future.selectedPath.length === 0,
    firstFrom: hoverAuto.mouse.future.preview.path[0]?.from === hoverAuto.first?.from,
    firstTo: hoverAuto.mouse.future.preview.path[0]?.to === hoverAuto.first?.to,
    stepCount: hoverAuto.mouse.board.stepCount === 4,
    paths: hoverAuto.mouse.board.paths === 4,
    bridgeVisible: !hoverAuto.mouse.bridge.hidden,
    bridgeTitle: hoverAuto.mouse.bridge.title.includes('悬停连演'),
    bridgeDetail: hoverAuto.mouse.bridge.detail.includes('移到另一候选'),
    oneVisibleAdopt: hoverAuto.mouse.visibleAdoptButtons === 1,
    legal: hoverReplayOk,
    sameFen: hoverAuto.mouse.state.fen === hoverAuto.liveBefore.fen,
    sameHistory: hoverAuto.mouse.state.history.length === hoverAuto.liveBefore.history.length,
    cleared: hoverAuto.cleared.preview.depth === 0,
    keyboardSource: hoverAuto.keyboard.preview.source === 'hover',
    keyboardDepth: hoverAuto.keyboard.preview.depth === 4,
    keyboardNoSelection: hoverAuto.keyboard.selectedPath.length === 0,
    deepConfigured: hoverAuto.deep.configured === 10,
    deepSelected: hoverAuto.deep.selected === '10',
    deepOptions: JSON.stringify(hoverAuto.deep.options) === JSON.stringify([1,2,3,4,5,6,7,8,9,10]),
    deepTouchTarget: hoverAuto.deep.height >= 44,
    deepSource: hoverAuto.deep.future.preview.source === 'hover',
    deepDepth: hoverAuto.deep.future.preview.depth === 10,
    deepNoSelection: hoverAuto.deep.future.selectedPath.length === 0,
    deepLegal: deepReplayOk,
  };
  record(
    Object.values(hoverChecks).every(Boolean),
    '鼠标或键盘按 1–10 ply 设置连演，默认 4、深线合法且不冒充实战选择',
    `首着=${hoverAuto.first?.san || '无'}｜鼠标=${hoverAuto.mouse.future.preview.source}`
      + `/${hoverAuto.mouse.future.preview.depth} ply`
      + `｜键盘=${hoverAuto.keyboard.preview.source}/${hoverAuto.keyboard.preview.depth} ply`
      + `｜深线=${hoverAuto.deep.future.preview.source}/${hoverAuto.deep.future.preview.depth} ply`
      + `｜selected=${hoverAuto.mouse.future.selectedPath.length}`
      + `｜合法=${hoverReplayOk}/${deepReplayOk}｜实战未变=${hoverAuto.mouse.state.fen === hoverAuto.liveBefore.fen}`
      + `｜fail=${Object.entries(hoverChecks).filter(([, ok]) => !ok).map(([key]) => key).join('/') || '无'}`,
  );

  let uncertainReplies = null;
  let uncertainRepliesError = '';
  try {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    uncertainReplies = await evalJs(`(async () => {
      const board = document.getElementById('board');
      const read = () => {
        const list = document.querySelector('[data-future-reply-list]');
        return {
          phase: board?.dataset.previewPhase || '',
          rootFen: board?.dataset.previewRootFen || '',
          displayFen: board?.dataset.previewDisplayFen || '',
          lineId: board?.dataset.previewLineId || '',
          stepIndex: Number(board?.dataset.previewStepIndex || 0),
          stepCount: Number(board?.dataset.previewStepCount || 0),
          boardReadOnly: board?.getAttribute('aria-readonly') || '',
          tabbableSquares: board?.querySelectorAll('#boardSquares [tabindex="0"]').length || 0,
          disabledSquares: board?.querySelectorAll('#boardSquares [aria-disabled="true"]').length || 0,
          motions: [...(board?.querySelectorAll('[data-future-motion-piece="true"]') || [])].map((node) => ({
            lineId: node.dataset.previewLineId || '',
            step: node.dataset.previewStep || '',
          })),
          paths: [...(board?.querySelectorAll('[data-future-preview-step]') || [])].map((node) => ({
            lineId: node.dataset.previewLineId || '',
            step: node.dataset.futurePreviewStep || '',
            from: node.dataset.previewFrom || '',
            to: node.dataset.previewTo || '',
          })),
          pieces: [...document.querySelectorAll('#boardPieces g.piece3d')].map((piece) => ({
            sq: piece.dataset.sq || '', color: piece.dataset.color || '', type: piece.dataset.type || '',
          })),
          replyCount: Number(list?.dataset.replyCount ?? -1),
          replyText: list?.textContent?.replace(/\\s+/g, ' ').trim() || '',
          options: [...document.querySelectorAll('[data-future-reply-option]')].map((option) => ({
            from: option.dataset.from || '',
            to: option.dataset.to || '',
            promotion: option.dataset.promotion || '',
            afterFen: option.dataset.afterFen || '',
            branchCount: Number(option.dataset.branchCount),
            suggested: option.dataset.engineSuggested === 'true',
            text: (option.textContent || '').replace(/\\s+/g, ' ').trim(),
            aria: option.getAttribute('aria-label') || '',
            tag: option.tagName,
            disabled: !!option.disabled,
          })),
          continuations: [
            document.querySelector('#fork g.card[data-col="1"]'),
            document.querySelector('#cloudTree2d [data-tree-rank][data-parent-depth="1"]'),
            document.querySelector('#exploreChoices [data-explore-rank][data-parent-depth="1"]'),
          ].filter(Boolean).map((control) => ({
            kind: control.matches('#fork g.card') ? 'fork'
              : control.matches('#cloudTree2d *') ? 'tree' : 'explorer',
            disabled: control.matches('button') ? control.disabled : control.hasAttribute('disabled'),
            ariaDisabled: control.getAttribute('aria-disabled') || '',
            tabIndex: control.getAttribute('tabindex') || '',
          })),
          ids: [...(board?.querySelectorAll('[data-preview-line-id]') || [])]
            .map((node) => node.dataset.previewLineId || '').filter(Boolean),
        };
      };
      window.__futureTest.rewind(0);
      const initial = window.__futureTest.snapshot();
      const liveBefore = window.__test.state();
      const deepCard = document.querySelector('#fork g.card[data-col="2"][data-after]');
      const bypassAccepted = deepCard
        ? window.__futureTest.selectNode(2, deepCard.dataset.after || '')
        : null;
      const afterBypass = window.__futureTest.snapshot();
      const bypassButtons = {
        legacyDisabled: document.getElementById('btnPlayLine')?.disabled,
        commitDisabled: document.getElementById('futureCommit')?.disabled,
      };
      window.__futureTest.rewind(0);
      const key = initial.suggestedPath[0]?.afterFen || '';
      const prematureFirstSelected = key ? window.__futureTest.selectNode(0, key) : false;
      const prematureReplyCard = document.querySelector('#fork g.card[data-col="1"][data-after]');
      const prematureReply = {
        firstSelected: prematureFirstSelected,
        ariaDisabled: prematureReplyCard?.getAttribute('aria-disabled') || '',
        tabIndex: prematureReplyCard?.getAttribute('tabindex') || '',
        hookAccepted: prematureReplyCard
          ? window.__futureTest.selectNode(1, prematureReplyCard.dataset.after || '')
          : null,
        selectedDepth: window.__futureTest.snapshot().selectedPath.length,
      };
      window.__futureTest.rewind(0);
      const keyboardCard = [...document.querySelectorAll('#fork g.card[data-col="0"]')]
        .find((card) => card.dataset.after === key);
      keyboardCard?.focus({ preventScroll: true });
      keyboardCard?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
      const keyboardSelection = {
        selectedDepth: window.__futureTest.snapshot().selectedPath.length,
        phase: board?.dataset.previewPhase || '',
        activeTag: document.activeElement?.tagName || '',
        activeCol: document.activeElement?.dataset?.col || '',
        activeAfter: document.activeElement?.dataset?.after || '',
        activeIsBody: document.activeElement === document.body,
        board: read(),
      };
      window.__futureTest.rewind(0);
      const selected = key ? window.__futureTest.selectNode(0, key) : false;
      const afterSelect = window.__futureTest.snapshot();
      const immediate = read();
      const samples = [];
      const start = performance.now();
      let awaited = read();
      while (performance.now() - start < 2200) {
        awaited = read();
        samples.push(awaited);
        if (awaited.phase === 'await-reply') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const beforeIdleWait = read();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const afterIdleWait = read();
      const snapshotAfterAwait = window.__futureTest.snapshot();
      const choices = afterIdleWait.options;
      const suggestedIndex = choices.findIndex((option) => option.suggested);
      const secondIndex = choices.findIndex((option, index) => index !== suggestedIndex && !option.suggested);
      const firstIndex = choices.findIndex((option, index) => index !== secondIndex);
      const firstChoice = choices[firstIndex] || null;
      const secondChoice = choices[secondIndex] || null;
      const optionFor = (choice) => [...document.querySelectorAll('[data-future-reply-option]')]
        .find((option) => option.dataset.from === choice?.from
          && option.dataset.to === choice?.to
          && (option.dataset.promotion || '') === (choice?.promotion || ''));
      const replyList = document.querySelector('[data-future-reply-list]');
      if (replyList) replyList.scrollLeft = Math.min(96, replyList.scrollWidth);
      const firstButton = optionFor(firstChoice);
      firstButton?.focus({ preventScroll: true });
      const beforeFirstClick = {
        scrollLeft: replyList?.scrollLeft || 0,
        activeFrom: document.activeElement?.dataset?.from || '',
        activeTo: document.activeElement?.dataset?.to || '',
        activePromotion: document.activeElement?.dataset?.promotion || '',
      };
      firstButton?.click();
      const replacementList = document.querySelector('[data-future-reply-list]');
      const afterFirstClick = {
        scrollLeft: replacementList?.scrollLeft || 0,
        activeFrom: document.activeElement?.dataset?.from || '',
        activeTo: document.activeElement?.dataset?.to || '',
        activePromotion: document.activeElement?.dataset?.promotion || '',
        commitDisabled: document.getElementById('futureCommit')?.disabled,
      };
      await new Promise((resolve) => setTimeout(resolve, 55));
      const firstBranch = read();
      optionFor(secondChoice)?.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
      const switched = read();
      const branchStart = performance.now();
      let final = switched;
      while (performance.now() - branchStart < 2200) {
        final = read();
        if (final.phase === 'conditional-settled') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      final = read();
      const liveAfter = window.__test.state();
      const finalSnapshot = window.__futureTest.snapshot();
      const clearControl = document.getElementById('futureClear');
      const clearBefore = {
        enabled: !!clearControl && !clearControl.disabled,
        live: window.__test.state(),
      };
      clearControl?.focus({ preventScroll: true });
      clearControl?.click();
      const clearAfter = {
        preview: read(),
        snapshot: window.__futureTest.snapshot(),
        live: window.__test.state(),
        repliesHidden: document.getElementById('futureReplyPanel')?.hidden,
        clearDisabled: clearControl?.disabled,
        commitDisabled: document.getElementById('futureCommit')?.disabled,
        coachState: document.getElementById('coachPanel')?.dataset.state || '',
        coachTitle: document.getElementById('coachTitle')?.textContent || '',
        activeIsRootCard:
          document.activeElement?.matches?.('#fork g.card[data-col="0"][data-selected="true"]') || false,
      };
      return {
        selected, initial, bypassAccepted, afterBypass, bypassButtons, prematureReply,
        keyboardSelection,
        afterSelect, immediate, samples, beforeIdleWait, afterIdleWait,
        snapshotAfterAwait, firstChoice, secondChoice, beforeFirstClick, afterFirstClick,
        firstBranch, switched, final,
        liveBefore, liveAfter, finalSnapshot, clearBefore, clearAfter,
      };
    })()`, true);
  } catch (error) {
    uncertainRepliesError = error?.message || String(error);
  }
  const uncertainYou = uncertainReplies?.afterSelect?.selectedPath?.[0];
  const uncertainSamples = uncertainReplies?.samples || [];
  const uncertainMotionRoles = new Set(
    uncertainSamples.flatMap((sample) => sample.motions.map((motion) => motion.step)),
  );
  const uncertainAwait = uncertainReplies?.afterIdleWait;
  const replyAudit = auditChessReplyOptions(uncertainYou?.afterFen || '', uncertainAwait?.options || []);
  const suggestedReplies = (uncertainAwait?.options || []).filter((option) => option.suggested);
  const suggestedStep = uncertainReplies?.snapshotAfterAwait?.suggestedPath?.[0];
  const suggestedOption = suggestedReplies[0];
  const firstPath = uncertainAwait?.paths?.[0];
  record(
    !!uncertainReplies
      && uncertainReplies.selected === true
      && uncertainReplies.bypassAccepted === false
      && uncertainReplies.afterBypass.selectedPath.length === 0
      && uncertainReplies.bypassButtons.legacyDisabled === true
      && uncertainReplies.bypassButtons.commitDisabled === true
      && uncertainReplies.prematureReply.firstSelected === true
      && uncertainReplies.prematureReply.ariaDisabled === 'true'
      && uncertainReplies.prematureReply.tabIndex === '-1'
      && uncertainReplies.prematureReply.hookAccepted === false
      && uncertainReplies.prematureReply.selectedDepth === 1
      && !!uncertainYou
      && uncertainReplies.immediate.phase === 'playing'
      && uncertainReplies.immediate.options.length > 0
      && uncertainReplies.immediate.options.every((option) => option.disabled)
      && uncertainReplies.immediate.continuations.length === 3
      && uncertainReplies.immediate.continuations.every((control) =>
        control.disabled && control.ariaDisabled === 'true' && control.tabIndex === '-1')
      && uncertainAwait?.phase === 'await-reply'
      && uncertainAwait.stepIndex === 1
      && uncertainAwait.stepCount === 1
      && uncertainAwait.displayFen === uncertainYou.afterFen
      && uncertainAwait.lineId
      && uncertainAwait.paths.length === 1
      && uncertainAwait.continuations.length === 3
      && uncertainAwait.continuations.every((control) =>
        !control.disabled && control.ariaDisabled === 'false' && control.tabIndex === '0')
      && firstPath?.step === 'you'
      && firstPath?.lineId === uncertainAwait.lineId
      && firstPath?.from === uncertainYou.from
      && firstPath?.to === uncertainYou.to
      && uncertainMotionRoles.has('you')
      && !uncertainMotionRoles.has('reply')
      && uncertainSamples.every((sample) => sample.motions.length <= 1)
      && uncertainReplies.beforeIdleWait.phase === 'await-reply'
      && uncertainReplies.beforeIdleWait.lineId === uncertainAwait.lineId
      && uncertainReplies.beforeIdleWait.displayFen === uncertainAwait.displayFen
      && renderedPiecesMatchFen(uncertainAwait.pieces, uncertainYou.afterFen)
      && uncertainReplies.liveAfter.fen === uncertainReplies.liveBefore.fen
      && JSON.stringify(uncertainReplies.liveAfter.history)
        === JSON.stringify(uncertainReplies.liveBefore.history),
    '选第一步后只播放该步并稳定等待回应，未选择不能自动推进',
    uncertainRepliesError || `phase=${uncertainAwait?.phase || '无'}`
      + `｜motions=${[...uncertainMotionRoles].join('/') || '无'}`
      + `｜paths=${uncertainAwait?.paths?.map((path) => path.step).join('/') || '无'}`
      + `｜实战未变=${uncertainReplies?.liveAfter?.fen === uncertainReplies?.liveBefore?.fen}`,
  );
  record(
    !!uncertainReplies
      && uncertainReplies.keyboardSelection.selectedDepth === 1
      && uncertainReplies.keyboardSelection.phase === 'playing'
      && uncertainReplies.keyboardSelection.activeTag.toLowerCase() === 'g'
      && uncertainReplies.keyboardSelection.activeCol === '0'
      && uncertainReplies.keyboardSelection.activeAfter
        === uncertainReplies.initial.suggestedPath[0]?.afterFen
      && uncertainReplies.keyboardSelection.activeIsBody === false
      && uncertainReplies.keyboardSelection.board.boardReadOnly === 'true'
      && uncertainReplies.keyboardSelection.board.tabbableSquares === 0
      && uncertainReplies.keyboardSelection.board.disabledSquares === 64
      && uncertainAwait?.boardReadOnly === 'true'
      && uncertainAwait?.tabbableSquares === 0
      && uncertainAwait?.disabledSquares === 64,
    '键盘选首步保留分叉焦点，预演棋盘整块移出 Tab 并明确只读',
    uncertainRepliesError || `focus=${uncertainReplies?.keyboardSelection?.activeTag || '无'}`
      + `/${uncertainReplies?.keyboardSelection?.activeCol || '无'}`
      + `｜playing Tab=${uncertainReplies?.keyboardSelection?.board?.tabbableSquares ?? '？'}`
      + `｜await Tab=${uncertainAwait?.tabbableSquares ?? '？'}`,
  );
  record(
    !!uncertainReplies
      && replyAudit.ok
      && uncertainAwait.replyCount === uncertainAwait.options.length
      && uncertainAwait.options.length === replyAudit.legalCount
      && uncertainAwait.options.every((option) => option.tag === 'BUTTON' && !option.disabled)
      && suggestedReplies.length === 1
      && !!suggestedStep
      && suggestedOption?.from === suggestedStep.from
      && suggestedOption?.to === suggestedStep.to
      && (suggestedOption?.promotion || '') === (suggestedStep.promotion || '')
      && suggestedOption?.afterFen === suggestedStep.afterFen
      && /建议|推荐主线/.test(suggestedOption?.text || '')
      && /建议/.test(suggestedOption?.aria || '')
      && uncertainAwait.options
        .filter((option) => !option.suggested)
        .every((option) => /可能|假设/.test(option.aria))
      && /(?:可能|假设)回应/.test(uncertainAwait.replyText)
      && !/(?:确定|必然)回应/.test(uncertainAwait.replyText),
    '回应面板完整渲染全部合法候选，金色引擎回应只是一项建议',
    uncertainRepliesError || (replyAudit.ok
      ? `DOM/属性/棋核=${uncertainAwait?.options?.length || 0}`
        + `｜建议=${suggestedReplies.length}｜条件文案=${uncertainAwait?.replyText || '无'}`
      : replyAudit.problems.slice(0, 5).join('；')),
  );
  const conditionalFinal = uncertainReplies?.final;
  const conditionalChoice = uncertainReplies?.secondChoice;
  const conditionalPaths = conditionalFinal?.paths || [];
  record(
    !!uncertainReplies
      && !!conditionalChoice
      && conditionalChoice.suggested === false
      && uncertainReplies.firstBranch.lineId
      && uncertainReplies.switched.lineId
      && uncertainReplies.firstBranch.lineId !== uncertainReplies.switched.lineId
      && conditionalFinal.phase === 'conditional-settled'
      && conditionalFinal.lineId === uncertainReplies.switched.lineId
      && conditionalFinal.stepIndex === 2
      && conditionalFinal.stepCount === 2
      && conditionalFinal.displayFen === conditionalChoice.afterFen
      && conditionalFinal.motions.length === 0
      && conditionalPaths.length === 2
      && conditionalPaths.every((path) => path.lineId === conditionalFinal.lineId)
      && conditionalPaths.some((path) => path.step === 'you')
      && conditionalPaths.some((path) => path.step === 'reply'
        && path.from === conditionalChoice.from && path.to === conditionalChoice.to)
      && conditionalFinal.ids.every((id) => id === conditionalFinal.lineId)
      && renderedPiecesMatchFen(conditionalFinal.pieces, conditionalChoice.afterFen)
      && uncertainReplies.finalSnapshot.selectedPath.length === 2
      && uncertainReplies.finalSnapshot.selectedPath[1]?.afterFen === conditionalChoice.afterFen
      && uncertainReplies.beforeFirstClick.scrollLeft > 0
      && uncertainReplies.afterFirstClick.scrollLeft === uncertainReplies.beforeFirstClick.scrollLeft
      && uncertainReplies.beforeFirstClick.activeFrom === uncertainReplies.firstChoice.from
      && uncertainReplies.beforeFirstClick.activeTo === uncertainReplies.firstChoice.to
      && uncertainReplies.beforeFirstClick.activePromotion === uncertainReplies.firstChoice.promotion
      && uncertainReplies.afterFirstClick.activeFrom === uncertainReplies.firstChoice.from
      && uncertainReplies.afterFirstClick.activeTo === uncertainReplies.firstChoice.to
      && uncertainReplies.afterFirstClick.activePromotion === uncertainReplies.firstChoice.promotion
      && uncertainReplies.afterFirstClick.commitDisabled === false
      && uncertainReplies.liveAfter.fen === uncertainReplies.liveBefore.fen
      && JSON.stringify(uncertainReplies.liveAfter.history)
        === JSON.stringify(uncertainReplies.liveBefore.history),
    '显式点可能回应后才播放条件分支，快速换分支隔离旧代且实战不变',
    uncertainRepliesError || `line=${uncertainReplies?.firstBranch?.lineId || '无'}`
      + `→${uncertainReplies?.switched?.lineId || '无'}`
      + `｜phase=${conditionalFinal?.phase || '无'}`
      + `｜step=${conditionalFinal?.stepIndex ?? -1}/${conditionalFinal?.stepCount ?? -1}`
      + `｜display=${conditionalFinal?.displayFen === conditionalChoice?.afterFen}`
      + `｜paths=${conditionalPaths.map((path) => `${path.step}:${path.lineId === conditionalFinal?.lineId}`).join('/') || '无'}`
      + `｜ids=${conditionalFinal?.ids?.every((id) => id === conditionalFinal?.lineId)}`
      + `｜选路=${uncertainReplies?.finalSnapshot?.selectedPath?.length || 0}`
      + `｜scroll=${uncertainReplies?.beforeFirstClick?.scrollLeft ?? -1}→${uncertainReplies?.afterFirstClick?.scrollLeft ?? -1}`
      + `｜focus=${uncertainReplies?.beforeFirstClick?.activeFrom || '?'}-${uncertainReplies?.beforeFirstClick?.activeTo || '?'}`
      + `→${uncertainReplies?.afterFirstClick?.activeFrom || '?'}-${uncertainReplies?.afterFirstClick?.activeTo || '?'}`
      + `｜commit=${uncertainReplies?.afterFirstClick?.commitDisabled}`
      + `｜非建议=${conditionalChoice?.suggested === false}`
      + `｜实战未变=${uncertainReplies?.liveAfter?.fen === uncertainReplies?.liveBefore?.fen}`,
  );

  const clearAfter = uncertainReplies?.clearAfter;
  record(
    !!uncertainReplies
      && uncertainReplies.clearBefore.enabled === true
      && clearAfter?.preview?.phase === 'idle'
      && clearAfter.preview.stepCount === 0
      && clearAfter.preview.paths.length === 0
      && clearAfter.preview.options.length === 0
      && clearAfter.preview.boardReadOnly === 'false'
      && clearAfter.preview.tabbableSquares > 0
      && clearAfter.snapshot.selectedPath.length === 0
      && clearAfter.snapshot.root.fen === uncertainReplies.clearBefore.live.fen
      && clearAfter.repliesHidden === true
      && clearAfter.clearDisabled === true
      && clearAfter.commitDisabled === true
      && clearAfter.coachState === 'idle'
      && /先点一枚白棋/.test(clearAfter.coachTitle)
      && clearAfter.activeIsRootCard === true
      && clearAfter.live.fen === uncertainReplies.clearBefore.live.fen
      && JSON.stringify(clearAfter.live.history)
        === JSON.stringify(uncertainReplies.clearBefore.live.history),
    '普通视图的「回到现在」会收起回应、恢复真棋盘且不改实战',
    uncertainRepliesError || `phase=${clearAfter?.preview?.phase || '无'}`
      + `｜选路=${clearAfter?.snapshot?.selectedPath?.length ?? -1}`
      + `｜回应隐藏=${clearAfter?.repliesHidden}`
      + `｜Tab=${clearAfter?.preview?.tabbableSquares ?? -1}`
      + `｜coach=${clearAfter?.coachState || '无'}`
      + `｜焦点回根=${clearAfter?.activeIsRootCard}`
      + `｜实战未变=${clearAfter?.live?.fen === uncertainReplies?.clearBefore?.live?.fen}`,
  );

  const futurePreviewProtocol = await evalJs(`(() => {
    const board = document.getElementById('board');
    return !!board
      && board.hasAttribute('data-future-preview')
      && board.hasAttribute('data-preview-phase')
      && board.hasAttribute('data-preview-root-fen')
      && board.hasAttribute('data-preview-display-fen')
      && board.hasAttribute('data-preview-line-id')
      && board.hasAttribute('data-preview-step-index')
      && board.hasAttribute('data-preview-step-count');
  })()`);
  if (!futurePreviewProtocol) {
    const detail = '主棋盘未声明 data-future-preview 与完整 data-preview-* 协议';
    record(false, '选择首步会有限播放并停在等待可能回应的真实局面', detail);
    record(false, '快速切换路线会隔离 line-id，旧动画不能回写新预演', detail);
    record(false, '减少动态模式分别静态投影首步与显式条件回应且不改实战', detail);
  } else {
    let normalPreview = null;
    let normalPreviewError = '';
    try {
      normalPreview = await evalJs(`(async () => {
        const board = document.getElementById('board');
        const read = () => ({
          active: board.dataset.futurePreview || '',
          phase: board.dataset.previewPhase || '',
          rootFen: board.dataset.previewRootFen || '',
          displayFen: board.dataset.previewDisplayFen || '',
          lineId: board.dataset.previewLineId || '',
          stepIndex: Number(board.dataset.previewStepIndex || 0),
          stepCount: Number(board.dataset.previewStepCount || 0),
          motions: [...board.querySelectorAll('[data-future-motion-piece="true"]')].map((piece) => ({
            lineId: piece.dataset.previewLineId || '',
            step: piece.dataset.previewStep || '',
            from: piece.dataset.previewFrom || '',
            to: piece.dataset.previewTo || '',
          })),
          paths: [...board.querySelectorAll('[data-future-preview-step]')].map((path) => ({
            lineId: path.dataset.previewLineId || '',
            step: path.dataset.futurePreviewStep || '',
            from: path.dataset.previewFrom || '',
            to: path.dataset.previewTo || '',
          })),
          pieces: [...document.querySelectorAll('#boardPieces g.piece3d')].map((piece) => ({
            sq: piece.dataset.sq || '', color: piece.dataset.color || '', type: piece.dataset.type || '',
          })),
        });
        window.__futureTest.rewind(0);
        const initial = window.__futureTest.snapshot();
        const liveBefore = window.__test.state();
        const key = initial.suggestedPath[0]?.afterFen || '';
        const selected = key ? window.__futureTest.selectNode(0, key) : false;
        const afterSelect = window.__futureTest.snapshot();
        const samples = [];
        const startedAt = performance.now();
        let final = read();
        while (performance.now() - startedAt < 3200) {
          final = read();
          samples.push(final);
          if (final.active === 'active' && final.phase === 'await-reply') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        final = read();
        const you = afterSelect.selectedPath[0] || null;
        document.getElementById('exploreReset')?.click();
        await Promise.resolve();
        const afterRealReset = read();
        const liveAfterRealReset = window.__test.state();
        const reselected = key ? window.__futureTest.selectNode(0, key) : false;
        const beforeInvalidMove = read();
        const invalidAccepted = window.__test.tryMove('e2', 'e5');
        const afterInvalidMove = read();
        const liveAfterInvalidMove = window.__test.state();
        return {
          selected, initial, afterSelect, liveBefore, liveAfter: window.__test.state(),
          elapsed: performance.now() - startedAt, samples, final, you,
          afterRealReset, liveAfterRealReset, reselected, beforeInvalidMove,
          invalidAccepted, afterInvalidMove, liveAfterInvalidMove,
        };
      })()`, true);
    } catch (error) {
      normalPreviewError = error?.message || String(error);
    }
    const normalMotionSteps = new Set(
      (normalPreview?.samples || []).flatMap((sample) => sample.motions.map((motion) => motion.step)),
    );
    const normalPaths = normalPreview?.final?.paths || [];
    const normalYou = normalPreview?.you;
    const normalFinalFen = normalYou?.afterFen || '';
    const normalLiveFen = normalPreview?.liveBefore?.fen || '';
    const resetBoard = normalPreview?.afterRealReset;
    const invalidBoard = normalPreview?.afterInvalidMove;
    const invalidProtocolConsistent = !!invalidBoard
      && invalidBoard.rootFen === normalLiveFen
      && renderedPiecesMatchFen(invalidBoard.pieces, invalidBoard.displayFen)
      && (invalidBoard.active === 'active'
        ? invalidBoard.lineId.length > 0 && invalidBoard.phase !== 'idle'
        : invalidBoard.active === 'idle'
          && invalidBoard.phase === 'idle'
          && invalidBoard.lineId === ''
          && invalidBoard.displayFen === normalLiveFen);
    const normalPathsExact = normalPaths.length === 1
      && normalPaths[0]?.step === 'you'
      && normalPaths[0]?.lineId === normalPreview?.final?.lineId
      && normalPaths[0]?.from === normalYou?.from
      && normalPaths[0]?.to === normalYou?.to;
    record(
      !!normalPreview
        && normalPreview.selected === true
        && normalMotionSteps.size === 1
        && normalMotionSteps.has('you')
        && normalPreview.samples.every((sample) => sample.motions.length <= 1)
        && normalPreview.final.active === 'active'
        && normalPreview.final.phase === 'await-reply'
        && normalPreview.final.stepCount === 1
        && normalPreview.final.lineId.length > 0
        && normalPreview.final.rootFen === normalPreview.liveBefore.fen
        && normalPreview.final.displayFen === normalFinalFen
        && normalPreview.final.motions.length === 0
        && normalPathsExact
        && renderedPiecesMatchFen(normalPreview.final.pieces, normalFinalFen)
        && normalPreview.liveAfter.fen === normalPreview.liveBefore.fen
        && JSON.stringify(normalPreview.liveAfter.history) === JSON.stringify(normalPreview.liveBefore.history)
        && resetBoard?.active === 'idle'
        && resetBoard?.phase === 'idle'
        && resetBoard?.lineId === ''
        && resetBoard?.rootFen === normalLiveFen
        && resetBoard?.displayFen === normalLiveFen
        && renderedPiecesMatchFen(resetBoard?.pieces, normalLiveFen)
        && normalPreview.liveAfterRealReset?.fen === normalLiveFen
        && JSON.stringify(normalPreview.liveAfterRealReset?.history) === JSON.stringify(normalPreview.liveBefore.history)
        && normalPreview.reselected === true
        && normalPreview.beforeInvalidMove?.active === 'active'
        && normalPreview.invalidAccepted === false
        && invalidProtocolConsistent
        && normalPreview.liveAfterInvalidMove?.fen === normalLiveFen
        && JSON.stringify(normalPreview.liveAfterInvalidMove?.history) === JSON.stringify(normalPreview.liveBefore.history),
      '选择首步会有限播放并等待可能回应，回到现在/非法着后主盘与实战同源',
      normalPreviewError || `steps=${[...normalMotionSteps].join('→') || '无'}`
        + `｜phase=${normalPreview?.final?.phase || '无'}`
        + `｜display=${normalPreview?.final?.displayFen === normalFinalFen}`
        + `｜reset=${resetBoard?.active || '无'}/${renderedPiecesMatchFen(resetBoard?.pieces, normalLiveFen)}`
        + `｜非法着一致=${normalPreview?.invalidAccepted === false && invalidProtocolConsistent}`
        + `｜实战未变=${normalPreview?.liveAfterInvalidMove?.fen === normalLiveFen}`,
    );

    let rapidPreview = null;
    let rapidPreviewError = '';
    try {
      rapidPreview = await evalJs(`(async () => {
        const board = document.getElementById('board');
        const read = () => ({
          active: board.dataset.futurePreview || '',
          phase: board.dataset.previewPhase || '',
          rootFen: board.dataset.previewRootFen || '',
          displayFen: board.dataset.previewDisplayFen || '',
          lineId: board.dataset.previewLineId || '',
          stepCount: Number(board.dataset.previewStepCount || 0),
          ids: [...document.querySelectorAll('[data-preview-line-id]')]
            .map((node) => node.dataset.previewLineId || '').filter(Boolean),
          motions: [...board.querySelectorAll('[data-future-motion-piece="true"]')].map((piece) => ({
            lineId: piece.dataset.previewLineId || '', step: piece.dataset.previewStep || '',
          })),
          paths: [...board.querySelectorAll('[data-future-preview-step]')].map((path) => ({
            lineId: path.dataset.previewLineId || '', step: path.dataset.futurePreviewStep || '',
          })),
          pieces: [...document.querySelectorAll('#boardPieces g.piece3d')].map((piece) => ({
            sq: piece.dataset.sq || '', color: piece.dataset.color || '', type: piece.dataset.type || '',
          })),
        });
        window.__futureTest.rewind(0);
        const liveBefore = window.__test.state();
        const keys = [...document.querySelectorAll('#fork g.card[data-col="0"][data-after]')]
          .map((card) => card.dataset.after || '').filter((key, index, all) => key && all.indexOf(key) === index);
        const firstSelected = keys[0] ? window.__futureTest.selectNode(0, keys[0]) : false;
        let first = read();
        for (let i = 0; i < 12 && !first.lineId; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          first = read();
        }
        const firstLineId = first.lineId;
        const secondSelected = keys[1] ? window.__futureTest.selectNode(0, keys[1]) : false;
        const secondRoute = window.__futureTest.snapshot();
        let switched = read();
        for (let i = 0; i < 20 && (!switched.lineId || switched.lineId === firstLineId); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          switched = read();
        }
        const secondLineId = switched.lineId;
        const staleImmediately = switched.ids.filter((id) => id === firstLineId).length;
        const startedAt = performance.now();
        let final = switched;
        while (performance.now() - startedAt < 3200) {
          final = read();
          if (final.active === 'active' && final.phase === 'await-reply') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        final = read();
        return {
          firstSelected, secondSelected, first, switched, final, firstLineId, secondLineId,
          staleImmediately, staleFinally: final.ids.filter((id) => id === firstLineId).length,
          secondRoute, liveBefore, liveAfter: window.__test.state(),
        };
      })()`, true);
    } catch (error) {
      rapidPreviewError = error?.message || String(error);
    }
    const rapidYou = rapidPreview?.secondRoute?.selectedPath?.[0];
    const rapidFinalFen = rapidYou?.afterFen || '';
    record(
      !!rapidPreview
        && rapidPreview.firstSelected === true
        && rapidPreview.secondSelected === true
        && rapidPreview.first.phase === 'playing'
        && rapidPreview.firstLineId.length > 0
        && rapidPreview.secondLineId.length > 0
        && rapidPreview.secondLineId !== rapidPreview.firstLineId
        && rapidPreview.staleImmediately === 0
        && rapidPreview.staleFinally === 0
        && rapidPreview.switched.ids.every((id) => id === rapidPreview.secondLineId)
        && rapidPreview.final.ids.every((id) => id === rapidPreview.secondLineId)
        && rapidPreview.final.phase === 'await-reply'
        && rapidPreview.final.stepCount === 1
        && rapidPreview.final.displayFen === rapidFinalFen
        && renderedPiecesMatchFen(rapidPreview.final.pieces, rapidFinalFen)
        && rapidPreview.liveAfter.fen === rapidPreview.liveBefore.fen
        && JSON.stringify(rapidPreview.liveAfter.history) === JSON.stringify(rapidPreview.liveBefore.history),
      '快速切换路线会隔离 line-id，旧动画不能回写新预演',
      rapidPreviewError || `line ${rapidPreview?.firstLineId || '无'} → ${rapidPreview?.secondLineId || '无'}`
        + `｜旧 DOM 立即/最终=${rapidPreview?.staleImmediately ?? '-1'}/${rapidPreview?.staleFinally ?? '-1'}`
        + `｜最终局面=${rapidPreview?.final?.displayFen === rapidFinalFen}`,
    );

    let reducedPreview = null;
    let reducedPreviewError = '';
    try {
      const switchStarted = await evalJs(`(() => {
        window.__futureTest.rewind(0);
        const board = document.getElementById('board');
        const initial = window.__futureTest.snapshot();
        const liveBefore = window.__test.state();
        const key = initial.suggestedPath[0]?.afterFen || '';
        const selected = key ? window.__futureTest.selectNode(0, key) : false;
        return {
          selected,
          route: window.__futureTest.snapshot(),
          liveBefore,
          lineId: board.dataset.previewLineId || '',
          phase: board.dataset.previewPhase || '',
        };
      })()`);
      await sleep(70);
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      for (let i = 0; i < 30; i++) {
        const phase = await evalJs("document.getElementById('board')?.dataset.previewPhase || ''");
        if (phase === 'await-reply') break;
        await sleep(40);
      }
      const switched = await evalJs(`(() => {
        const board = document.getElementById('board');
        return {
          liveAfter: window.__test.state(),
          active: board.dataset.futurePreview || '',
          phase: board.dataset.previewPhase || '',
          rootFen: board.dataset.previewRootFen || '',
          displayFen: board.dataset.previewDisplayFen || '',
          lineId: board.dataset.previewLineId || '',
          stepIndex: Number(board.dataset.previewStepIndex || 0),
          stepCount: Number(board.dataset.previewStepCount || 0),
          motions: board.querySelectorAll('[data-future-motion-piece="true"]').length,
          paths: [...board.querySelectorAll('[data-future-preview-step]')].map((path) => ({
            lineId: path.dataset.previewLineId || '',
            step: path.dataset.futurePreviewStep || '',
            from: path.dataset.previewFrom || '',
            to: path.dataset.previewTo || '',
          })),
          pieces: [...document.querySelectorAll('#boardPieces g.piece3d')].map((piece) => ({
            sq: piece.dataset.sq || '', color: piece.dataset.color || '', type: piece.dataset.type || '',
          })),
        };
      })()`);
      const staticPreview = await evalJs(`(() => {
        const board = document.getElementById('board');
        const readBoard = () => ({
          active: board.dataset.futurePreview || '',
          phase: board.dataset.previewPhase || '',
          rootFen: board.dataset.previewRootFen || '',
          displayFen: board.dataset.previewDisplayFen || '',
          lineId: board.dataset.previewLineId || '',
          stepIndex: Number(board.dataset.previewStepIndex || 0),
          stepCount: Number(board.dataset.previewStepCount || 0),
          motions: board.querySelectorAll('[data-future-motion-piece="true"]').length,
          paths: [...board.querySelectorAll('[data-future-preview-step]')].map((path) => ({
            lineId: path.dataset.previewLineId || '',
            step: path.dataset.futurePreviewStep || '',
            from: path.dataset.previewFrom || '',
            to: path.dataset.previewTo || '',
          })),
          pieces: [...document.querySelectorAll('#boardPieces g.piece3d')].map((piece) => ({
            sq: piece.dataset.sq || '', color: piece.dataset.color || '', type: piece.dataset.type || '',
          })),
        });
        window.__futureTest.rewind(0);
        const initial = window.__futureTest.snapshot();
        const liveBefore = window.__test.state();
        const key = initial.suggestedPath[0]?.afterFen || '';
        const selected = key ? window.__futureTest.selectNode(0, key) : false;
        const route = window.__futureTest.snapshot();
        const firstBoard = readBoard();
        const replyButton = [...document.querySelectorAll('[data-future-reply-option]')]
          .find((button) => button.dataset.engineSuggested !== 'true')
          || document.querySelector('[data-future-reply-option]');
        const replyChoice = replyButton ? {
          from: replyButton.dataset.from || '',
          to: replyButton.dataset.to || '',
          afterFen: replyButton.dataset.afterFen || '',
        } : null;
        replyButton?.click();
        const conditionalRoute = window.__futureTest.snapshot();
        const conditionalBoard = readBoard();
        return {
          selected, route, replyClicked: !!replyButton, replyChoice, conditionalRoute,
          liveBefore, liveAfter: window.__test.state(),
          reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
          board: firstBoard,
          conditionalBoard,
        };
      })()`);
      reducedPreview = { ...staticPreview, switchStarted, switched };
    } catch (error) {
      reducedPreviewError = error?.message || String(error);
    } finally {
      try {
        await send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
      } catch {}
      try { await evalJs('window.__futureTest.rewind(0)'); } catch {}
    }
    const reducedYou = reducedPreview?.route?.selectedPath?.[0];
    const reducedFinalFen = reducedYou?.afterFen || '';
    const reducedPaths = reducedPreview?.board?.paths || [];
    const reducedConditionalReply = reducedPreview?.conditionalRoute?.selectedPath?.[1];
    const reducedConditionalFen = reducedConditionalReply?.afterFen || '';
    const reducedConditionalPaths = reducedPreview?.conditionalBoard?.paths || [];
    const switchedYou = reducedPreview?.switchStarted?.route?.selectedPath?.[0];
    const switchedFinalFen = switchedYou?.afterFen || '';
    const switchedPaths = reducedPreview?.switched?.paths || [];
    record(
      !!reducedPreview
        && reducedPreview.switchStarted.selected === true
        && reducedPreview.switchStarted.phase === 'playing'
        && reducedPreview.switched.active === 'active'
        && reducedPreview.switched.phase === 'await-reply'
        && reducedPreview.switched.lineId === reducedPreview.switchStarted.lineId
        && reducedPreview.switched.rootFen === reducedPreview.switchStarted.liveBefore.fen
        && reducedPreview.switched.displayFen === switchedFinalFen
        && reducedPreview.switched.stepIndex === 1
        && reducedPreview.switched.stepCount === 1
        && reducedPreview.switched.motions === 0
        && switchedPaths.length === 1
        && switchedPaths[0]?.step === 'you'
        && switchedPaths.every((path) => path.lineId === reducedPreview.switched.lineId)
        && renderedPiecesMatchFen(reducedPreview.switched.pieces, switchedFinalFen)
        && reducedPreview.switched.liveAfter.fen === reducedPreview.switchStarted.liveBefore.fen
        && JSON.stringify(reducedPreview.switched.liveAfter.history)
          === JSON.stringify(reducedPreview.switchStarted.liveBefore.history)
        && reducedPreview.reduced === true
        && reducedPreview.selected === true
        && reducedPreview.board.active === 'active'
        && reducedPreview.board.phase === 'await-reply'
        && reducedPreview.board.rootFen === reducedPreview.liveBefore.fen
        && reducedPreview.board.displayFen === reducedFinalFen
        && reducedPreview.board.lineId.length > 0
        && reducedPreview.board.stepIndex === 1
        && reducedPreview.board.stepCount === 1
        && reducedPreview.board.motions === 0
        && reducedPaths.length === 1
        && reducedPaths[0]?.step === 'you'
        && reducedPaths[0]?.lineId === reducedPreview.board.lineId
        && reducedPaths[0]?.from === reducedYou?.from
        && reducedPaths[0]?.to === reducedYou?.to
        && renderedPiecesMatchFen(reducedPreview.board.pieces, reducedFinalFen)
        && reducedPreview.replyClicked === true
        && reducedPreview.conditionalRoute?.selectedPath?.length === 2
        && reducedPreview.conditionalBoard?.active === 'active'
        && reducedPreview.conditionalBoard?.phase === 'conditional-static'
        && reducedPreview.conditionalBoard?.displayFen === reducedConditionalFen
        && reducedPreview.conditionalBoard?.stepIndex === 2
        && reducedPreview.conditionalBoard?.stepCount === 2
        && reducedPreview.conditionalBoard?.motions === 0
        && reducedConditionalPaths.length === 2
        && reducedConditionalPaths.every((path) => path.lineId === reducedPreview.conditionalBoard.lineId)
        && reducedConditionalPaths.some((path) => path.step === 'you')
        && reducedConditionalPaths.some((path) => path.step === 'reply'
          && path.from === reducedPreview.replyChoice?.from
          && path.to === reducedPreview.replyChoice?.to)
        && renderedPiecesMatchFen(reducedPreview.conditionalBoard?.pieces, reducedConditionalFen)
        && reducedPreview.liveAfter.fen === reducedPreview.liveBefore.fen
        && JSON.stringify(reducedPreview.liveAfter.history) === JSON.stringify(reducedPreview.liveBefore.history),
      '减少动态会静态停在首步，显式点回应后才投影两拍条件局面且不改实战',
      reducedPreviewError || `运行中=${reducedPreview?.switchStarted?.phase || '无'}→${reducedPreview?.switched?.phase || '无'}`
        + `｜phase=${reducedPreview?.board?.phase || '无'}→${reducedPreview?.conditionalBoard?.phase || '无'}`
        + `｜motion=${reducedPreview?.board?.motions ?? -1}`
        + `｜paths=${reducedPaths.map((path) => path.step).join('/') || '无'}`
        + `→${reducedConditionalPaths.map((path) => path.step).join('/') || '无'}`
        + `｜实战未变=${reducedPreview?.liveAfter?.fen === reducedPreview?.liveBefore?.fen}`,
    );
  }

  // 只有用户明确点「放大探索」才加载完整第 4 层，再逐层对数。
  const s1 = await openCloudAndWait();
  console.log('初始路径网: ' + JSON.stringify({ depth: s1.depth, nodes: s1.nodes, total: s1.totalNodes, ms: s1.ms, layers: s1.layers }));
  await checkNodesMatchCount(s1, '');

  // 路径网的「一个现在 → 向前分叉」也从 three.js 实际 LineSegments geometry 对账。
  // coherence 是首层平均方向长度 / 平均半径：球壳接近 0，向前张开的锥形会明显大于 0。
  const cloudMap1 = await evalJs('window.__test.cloudMap()');
  const cloudShape1 = analyzeCloudShape(cloudMap1);
  const firstExpected = count(s1.fen, 1);
  const rootAtOrigin =
    cloudShape1.rootPosition.length === 3
    && cloudShape1.rootPosition.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e-7);
  record(
    cloudMap1.pointObjects === 0
      && cloudShape1.rootCount === 1
      && rootAtOrigin,
    '② 路径网零发光点，并从一条终点在原点的真实根路径出发',
    `THREE.Points=${cloudMap1.pointObjects}`
      + `｜root LineSegments=${cloudShape1.rootCount}`
      + `｜终点 ${JSON.stringify(cloudShape1.rootPosition)}`);
  record(
    cloudShape1.firstCount === firstExpected && cloudMap1.firstLinks === firstExpected,
    '② 第一层真实路径边数等于合法走法数',
    `geometry 边 ${cloudShape1.firstCount}｜LineSegments ${cloudMap1.firstLinks}｜count(fen,1) ${firstExpected}`);
  record(
    cloudShape1.coherence >= 0.35 && cloudShape1.positiveRatio >= 0.8,
    '② 第一层沿未来方向展开，不再围成球壳',
    `方向一致性 ${cloudShape1.coherence.toFixed(3)}｜正向比例 ${cloudShape1.positiveRatio.toFixed(3)}`);
  record(
    cloudMap1.layers.length === s1.layers.length
      && cloudMap1.lineObjects > 0
      && cloudMap1.groupVisible === true
      && cloudMap1.hiddenLineObjects === 0
      && cloudMap1.oddVertexObjects === 0
      && cloudMap1.colorMismatchObjects === 0
      && cloudMap1.partialDrawObjects === 0
      && cloudMap1.nonLineSegmentObjects === 0
      && cloudMap1.indexedLinkObjects === 0
      && cloudMap1.orphanRenderObjects === 0
      && cloudMap1.layers.every((layer) => layer.objects === 1)
      && cloudMap1.layers.every((layer) => layer.finite),
    '② 所有路径都是真实非索引 LineSegments；L4 完成后合并为单对象降低 draw call',
    cloudMap1.layers.map((layer) => `L${layer.depth}:${layer.count}/${layer.finite ? 'finite' : 'NaN'}`).join('　')
      + `｜objects=${cloudMap1.lineObjects}`
      + `｜hidden/odd/color/draw=${cloudMap1.hiddenLineObjects}/${cloudMap1.oddVertexObjects}`
      + `/${cloudMap1.colorMismatchObjects}/${cloudMap1.partialDrawObjects}`
      + `｜wrongType/index/orphan=${cloudMap1.nonLineSegmentObjects}`
      + `/${cloudMap1.indexedLinkObjects}/${cloudMap1.orphanRenderObjects}`
      + `｜每层 objects=${cloudMap1.layers.map((layer) => layer.objects).join('/')}`);

  const board1 = await evalJs('window.__test.board()');
  const boardAudit1 = auditBoardDom(board1);
  record(
    board1.total === 32 && boardAudit1.exactFen && boardAudit1.initialProfile,
    '⑤ 初始 32 枚棋子与 FEN 逐格一致，黑白各 16 枚',
    `DOM ${board1.total}｜白/黑 ${boardAudit1.colorCounts.w}/${boardAudit1.colorCounts.b}`
      + `｜逐格 ${boardAudit1.exactFen ? '一致' : '不一致'}`
      + `｜类型 ${JSON.stringify(boardAudit1.typeCounts)}`);
  record(
    board1.unicodeGlyphs === 0
      && board1.renderModes.length === 1
      && board1.renderModes[0] === 'vector-3d'
      && boardAudit1.sameGeometryAcrossColors
      && boardAudit1.sixDistinctModels
      && boardAudit1.instancesMatchTemplates
      && boardAudit1.layeredTemplates
      && boardAudit1.templateDepthRoles
      && boardAudit1.materialOk
      && boardAudit1.boundsOk,
    '⑤ 六种棋子全部走统一 3D 矢量管线，零 Unicode 字体依赖',
    `glyph=${board1.unicodeGlyphs}｜renderer=${board1.renderModes.join('/')}`
      + `｜六种独立造型=${boardAudit1.sixDistinctModels}`
      + `｜黑白同几何=${boardAudit1.sameGeometryAcrossColors}`
      + `｜实例吻合模板=${boardAudit1.instancesMatchTemplates}`
      + `｜分层模型=${boardAudit1.layeredTemplates}`
      + `｜侧面/高光/地影=${boardAudit1.templateDepthRoles}`
      + `｜独立材质=${boardAudit1.materialOk}｜边界=${boardAudit1.boundsOk}`);

  // 搜索自己的 deadline 必须独立成立，不能只靠页面 watchdog 遮住超时。
  const deadlineProbe = await evalJs(`(async () => {
    const { search } = await import('./engine.js');
    const t0 = performance.now();
    const result = search(window.__test.state().fen, { timeBudgetMs: 0, maxDepth: 1 });
    return { depth: result.depth, nodes: result.nodes, ms: performance.now() - t0 };
  })()`, true);
  record(
    deadlineProbe.depth === 0 && deadlineProbe.nodes === 0 && deadlineProbe.ms < 100,
    'AI 搜索引擎自身会在根节点执行 deadline，不靠 watchdog 掩盖超时',
    `depth=${deadlineProbe.depth}｜nodes=${deadlineProbe.nodes}｜${deadlineProbe.ms.toFixed(2)}ms`);

  const timedDeadlineProbe = await evalJs(`(async () => {
    const { search } = await import('./engine.js');
    // 该局面白方只有 Ke2 一个合法根走法，走后黑方有 37 种回应。
    // 根层检查无法在同一棵大子树中救场，必须靠 negamax 内部的周期检查。
    const fen = 'r2n4/6k1/Bq1p1p2/1p1PQ3/Pb1pp3/3R4/1PP3PR/1NBK2r1 w - - 4 40';
    const t0 = performance.now();
    const result = search(fen, { timeBudgetMs: 140, maxDepth: 12 });
    return {
      depth: result.depth,
      nodes: result.nodes,
      searchMs: result.ms,
      elapsed: performance.now() - t0,
    };
  })()`, true);
  record(
    timedDeadlineProbe.depth >= 1
      && timedDeadlineProbe.depth < 12
      && timedDeadlineProbe.nodes > 0
      && timedDeadlineProbe.searchMs >= 90
      && timedDeadlineProbe.searchMs < 200
      && timedDeadlineProbe.elapsed < 250,
    'AI 深搜在正预算下也会周期查钟，不会困在一棵子树里',
    `depth=${timedDeadlineProbe.depth}｜nodes=${timedDeadlineProbe.nodes}`
      + `｜search=${timedDeadlineProbe.searchMs.toFixed(1)}ms`
      + `｜外部=${timedDeadlineProbe.elapsed.toFixed(1)}ms`);

  const pvProbe = await evalJs(`(async () => {
    const { Chess, search } = await import('./engine.js');
    const fen = new Chess().fen();
    return { fen, result: search(fen, { timeBudgetMs: 1800, maxDepth: 4 }) };
  })()`, true);
  const pvAudit = auditPrincipalVariation(pvProbe.fen, pvProbe.result);
  record(
    pvProbe.result.depth === 4
      && Array.isArray(pvProbe.result.pv)
      && pvProbe.result.pv.length === 4
      && pvAudit.ok,
    'AI 主变来自最后一层完整搜索，逐手合法且长度吻合深度',
    pvAudit.ok
      ? `depth=${pvProbe.result.depth}｜PV ${pvProbe.result.pv.map((move) => move.san).join(' → ')}`
      : pvAudit.problems.join('；'));

  const zeroPvProbe = await evalJs(`(async () => {
    const { Chess, search } = await import('./engine.js');
    const fen = new Chess().fen();
    return { fen, result: search(fen, { timeBudgetMs: 0, maxDepth: 4 }) };
  })()`, true);
  const zeroFallback = new Chess(zeroPvProbe.fen).moves({ verbose: true }).some((move) =>
    move.from === zeroPvProbe.result.move.from
    && move.to === zeroPvProbe.result.move.to
    && (move.promotion || '') === (zeroPvProbe.result.move.promotion || ''));
  record(
    zeroPvProbe.result.depth === 0
      && Array.isArray(zeroPvProbe.result.pv)
      && zeroPvProbe.result.pv.length === 0
      && zeroFallback,
    '零预算只返回合法保底着，不冒充已搜索主变',
    `depth=${zeroPvProbe.result.depth}`
      + `｜pv=${Array.isArray(zeroPvProbe.result.pv) ? zeroPvProbe.result.pv.length : '缺失'}`
      + `｜fallback=${zeroPvProbe.result.san}`);

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

  // 2) 截图（② 路径网清晰）：正常画布与隐藏真实 cloudGroup 后的画面对撞，
  // 避免背景、标签或 HUD 很亮时把“线其实没画出来”误判成绿。
  const originalCloudAuto = await evalJs('window.__test.renderStats().auto');
  await evalJs('window.__test.setCloudAuto(false)');
  await settleLayout();
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  const bytes = fs.statSync(SHOT).size;
  const skyRect = await evalJs('window.__test.skyRect()');
  const ss = shotStats(SHOT, skyRect);
  const hiddenCloudFile = SHOT.replace(/\.png$/i, '-cloud-hidden.png');
  const hiddenDeepFile = SHOT.replace(/\.png$/i, '-cloud-l4-hidden.png');
  let cloudVisibilityRestored = false;
  let deepVisibilityRestored = false;
  let cloudAutoRestored = false;
  try {
    await evalJs('window.__test.setCloudVisible(false)');
    await settleLayout();
    const hiddenCloudShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(hiddenCloudFile, Buffer.from(hiddenCloudShot.data, 'base64'));
  } finally {
    cloudVisibilityRestored = await evalJs('window.__test.setCloudVisible(true)');
    await settleLayout();
  }
  try {
    await evalJs('window.__test.setCloudDepthVisible(4, false)');
    await settleLayout();
    const hiddenDeepShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(hiddenDeepFile, Buffer.from(hiddenDeepShot.data, 'base64'));
  } finally {
    deepVisibilityRestored = await evalJs('window.__test.setCloudDepthVisible(4, true)');
    cloudAutoRestored = await evalJs(`window.__test.setCloudAuto(${originalCloudAuto})`) === originalCloudAuto;
    await settleLayout();
  }
  const pathPixels = cloudPathPixelDiff(SHOT, hiddenCloudFile, skyRect);
  const deepPixels = cloudPathPixelDiff(SHOT, hiddenDeepFile, skyRect, 2);
  record(
    cloudVisibilityRestored
      && deepVisibilityRestored
      && cloudAutoRestored
      && pathPixels.changedRatio > 0.002
      && pathPixels.spanX > 0.35
      && pathPixels.spanY > 0.25
      && deepPixels.changedRatio > 0.0002
      && deepPixels.spanX > 0.12
      && deepPixels.spanY > 0.12,
    '② 正常路径网、隐藏全网与单独隐藏 L4 的截图都有真实像素差',
    `${SHOT} ${bytes}B｜路径窗 ${Math.round(skyRect.w)}×${Math.round(skyRect.h)}`
      + `｜差异像素 ${pathPixels.changed}/${pathPixels.total} (${pathPixels.changedRatio})`
      + `｜横/纵跨度 ${pathPixels.spanX}/${pathPixels.spanY}`
      + `｜L4差异 ${deepPixels.changed}/${deepPixels.total} (${deepPixels.changedRatio})`
      + ` span=${deepPixels.spanX}/${deepPixels.spanY}`
      + `｜已恢复=${cloudVisibilityRestored}/${deepVisibilityRestored}/${cloudAutoRestored}`);
  record(pathPixels.warmOfChanged > 0.02 && pathPixels.coldOfChanged > 0.02,
    '② 路径网真实线条差分中暖/冷两色都看得出来',
    `暖 ${pathPixels.warm} (${pathPixels.warmOfChanged})｜冷 ${pathPixels.cold} (${pathPixels.coldOfChanged})`);

  // ＋/－/回到全景都走真实按钮，DPR 则直接读 three.js renderer。
  const zoomStart = await evalJs('window.__test.cloudMap().view');
  const zoomInClicked = await clickSelector('#cloudZoomIn');
  const zoomedIn = await evalJs('window.__test.cloudMap().view');
  const zoomOutClicked = await clickSelector('#cloudZoomOut');
  const zoomedOut = await evalJs('window.__test.cloudMap().view');
  const resetViewClicked = await clickSelector('#cloudResetView');
  const resetView = await evalJs('({ map: window.__test.cloudMap(), render: window.__test.renderStats() })');
  record(
    zoomInClicked
      && zoomOutClicked
      && resetViewClicked
      && zoomedIn.dist < zoomStart.dist
      && zoomedOut.dist > zoomedIn.dist
      && Math.abs(resetView.map.view.yaw - 0.08) <= 1e-9
      && Math.abs(resetView.map.view.pitch - 0.15) <= 1e-9
      && Math.abs(resetView.map.view.dist - 29) <= 1e-9
      && resetView.map.view.auto === false
      && resetView.render.dpr <= 1.5
      && resetView.render.pixelWidth > 0
      && resetView.render.pixelHeight > 0,
    '② 放大探索可用真实 ＋/－ 缩放并回到全景，桌面渲染倍率不超过 1.5',
    `dist ${zoomStart.dist.toFixed(2)}→${zoomedIn.dist.toFixed(2)}→${zoomedOut.dist.toFixed(2)}→${resetView.map.view.dist.toFixed(2)}`
      + `｜DPR ${resetView.render.dpr}｜画布 ${resetView.render.pixelWidth}×${resetView.render.pixelHeight}`);

  // 在右侧变体棋盘真实点两步；Node 端逐手重放，且预览 DOM 必须逐格等于结果 FEN。
  const explorerRoot = await evalJs('window.__test.explorer()');
  const preferredRootChoice = explorerRoot.choices.find((choice) => choice.san === 'e4')
    || explorerRoot.choices[0];
  const explorerFirstClicked = preferredRootChoice
    ? await clickSelector(`#exploreChoices button[data-explore-rank="${preferredRootChoice.rank}"]`)
    : false;
  const explorerAfterFirst = await evalJs('window.__test.explorer()');
  const replyChoice = explorerAfterFirst.choices[0] || null;
  const explorerReplyClicked = replyChoice
    ? await clickSelector(`#exploreChoices button[data-explore-rank="${replyChoice.rank}"]`)
    : false;
  const explorerAfterReply = await evalJs('window.__test.explorer()');
  const explorerMapAfterReply = await evalJs('window.__test.cloudMap()');
  const explorerPreviewAudit = auditExplorerPreview(explorerAfterReply);
  let explorerReplayOk = true;
  let explorerReplayFen = explorerRoot.rootFen;
  try {
    const replay = new Chess(explorerRoot.rootFen);
    for (const move of explorerAfterReply.path) {
      const playedMove = replay.move(move.san);
      if (!playedMove || replay.fen() !== move.after) explorerReplayOk = false;
    }
    explorerReplayFen = replay.fen();
  } catch {
    explorerReplayOk = false;
  }
  const replyLegalCount = new Chess(explorerAfterReply.renderedFen).moves().length;
  const explorerChoiceSans = new Set(explorerAfterReply.choices.map((choice) => choice.san));
  record(
    explorerFirstClicked
      && explorerReplyClicked
      && explorerAfterReply.path.length === 2
      && explorerAfterReply.pathButtons.length === 3
      && explorerAfterReply.pathButtons.at(-1)?.current === true
      && explorerReplayOk
      && explorerReplayFen === explorerAfterReply.renderedFen
      && explorerPreviewOk(explorerPreviewAudit)
      && explorerAfterReply.choices.length === replyLegalCount
      && explorerAfterReply.labels.length > 0
      && explorerAfterReply.labels.every((label) => explorerChoiceSans.has(label.san))
      && explorerMapAfterReply.routePoints === explorerAfterReply.path.length + 1
      && explorerAfterReply.gameFen === explorerRoot.gameFen
      && JSON.stringify(explorerAfterReply.gameHistory) === JSON.stringify(explorerRoot.gameHistory)
      && explorerAfterReply.thinking === explorerRoot.thinking
      && JSON.stringify(explorerAfterReply.aiPending) === JSON.stringify(explorerRoot.aiPending),
    '② 变体棋盘可连续点两步：线图、面包屑与逐格棋盘结果同源，实战完全不动',
    `路径 ${explorerAfterReply.path.map((move) => move.san).join(' → ')}`
      + `｜preview ${explorerPreviewAudit.actualCount}/${explorerPreviewAudit.expectedCount}`
      + `｜回应 ${explorerAfterReply.choices.length}/${replyLegalCount}`
      + `｜route position.count=${explorerMapAfterReply.routePoints}`
      + `｜实战未变=${explorerAfterReply.gameFen === explorerRoot.gameFen}`);

  const explorerRootClicked = await clickSelector('#explorePath button[data-explore-depth="0"]');
  const explorerRewound = await evalJs('window.__test.explorer()');
  const explorerMapRewound = await evalJs('window.__test.cloudMap()');
  const explorerRootPreviewAudit = auditExplorerPreview(explorerRewound);
  record(
    explorerRootClicked
      && explorerRewound.path.length === 0
      && explorerRewound.pathButtons.length === 1
      && explorerRewound.pathButtons[0]?.current === true
      && explorerRewound.renderedFen === explorerRewound.gameFen
      && explorerPreviewOk(explorerRootPreviewAudit)
      && explorerRewound.choices.length === new Chess(explorerRewound.renderedFen).moves().length
      && explorerMapRewound.routePoints === 0
      && explorerRewound.gameFen === explorerRoot.gameFen
      && JSON.stringify(explorerRewound.gameHistory) === JSON.stringify(explorerRoot.gameHistory),
    '② 点「现在」可回退到实战局面，棋盘、候选和路线一起复原',
    `path=${explorerRewound.path.length}｜preview ${explorerRootPreviewAudit.actualCount}/${explorerRootPreviewAudit.expectedCount}`
      + `｜候选 ${explorerRewound.choices.length}｜route position.count=${explorerMapRewound.routePoints}`);

  // 全屏截图验证完就收起并释放 L4；棋子像素验收必须截到真实主棋盘。
  await closeCloudAndWaitPreview();
  await evalJs('document.getElementById("board").scrollIntoView({ block: "center" })');
  await settleLayout();
  const boardPixelsSnapshot = await evalJs('window.__test.board()');
  const boardNormalFile = SHOT.replace(/\.png$/i, '-board-normal.png');
  const boardNormalShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(boardNormalFile, Buffer.from(boardNormalShot.data, 'base64'));
  const boardBlankFile = SHOT.replace(/\.png$/i, '-board-blank.png');
  await evalJs('document.getElementById("boardPieces").style.visibility = "hidden"');
  await settleLayout();
  const boardBlankShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(boardBlankFile, Buffer.from(boardBlankShot.data, 'base64'));
  await evalJs('document.getElementById("boardPieces").style.visibility = ""');
  await settleLayout();
  const desktopLayout = await evalJs('window.__test.layout()');
  const boardPixels1 = boardPiecePixelStats(boardNormalFile, boardBlankFile, boardPixelsSnapshot, desktopLayout.viewport);
  record(
    boardPixels1.white >= 150
      && boardPixels1.black <= 120
      && boardPixels1.gap >= 70
      && boardPixels1.minWhiteMedian >= 150
      && boardPixels1.maxBlackMedian <= 120
      && boardPixels1.minTypeGap >= 60
      && boardPixels1.whiteShape.typeCount === 6
      && boardPixels1.blackShape.typeCount === 6
      && boardPixels1.whiteShape.minDistance >= .02
      && boardPixels1.blackShape.minDistance >= .02
      && boardPixels1.minVisibleHeightRatio >= .62
      && boardPixels1.minUpperCoverage >= .035
      && boardPixels1.minCoverage >= .045
      && boardPixels1.minToneRange >= 24,
    '⑤ 真实截图里白棋明显亮于黑棋，每颗都有高光和暗部',
    `白中位 ${boardPixels1.white.toFixed(1)}｜黑中位 ${boardPixels1.black.toFixed(1)}`
      + `｜差 ${boardPixels1.gap.toFixed(1)}`
      + `｜逐枚白最低/黑最高 ${boardPixels1.minWhiteMedian.toFixed(1)}/${boardPixels1.maxBlackMedian.toFixed(1)}`
      + `｜逐类型最小差 ${boardPixels1.minTypeGap.toFixed(1)}`
      + `｜白最近轮廓 ${boardPixels1.whiteShape.closestTypes} Δ${boardPixels1.whiteShape.minDistance.toFixed(3)}`
      + `｜黑最近轮廓 ${boardPixels1.blackShape.closestTypes} Δ${boardPixels1.blackShape.minDistance.toFixed(3)}`
      + `｜逐枚最小可见高度 ${(boardPixels1.minVisibleHeightRatio * 100).toFixed(1)}%`
      + `｜逐枚最小上半区覆盖 ${(boardPixels1.minUpperCoverage * 100).toFixed(1)}%`
      + `｜最小覆盖 ${(boardPixels1.minCoverage * 100).toFixed(1)}%`
      + `｜最小明暗跨度 ${boardPixels1.minToneRange.toFixed(1)}`);

  await runCoachChecks();

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

  // 棋子不是只在开局摆对：吃子、升变、王车易位都必须由真实 FEN 重新生成正确模型。
  const capture = await evalJs(`(() => {
    const loaded = window.__test.loadFen('8/8/8/3p4/4P3/8/8/K6k w - - 0 1');
    const played = window.__test.tryMove('e4', 'd5');
    return { loaded, played, state: window.__test.state(), board: window.__test.board() };
  })()`);
  const captureAudit = auditBoardDom(capture.board);
  await evalJs('window.__test.reset()');

  const promotion = await evalJs(`(() => {
    const loaded = window.__test.loadFen('7k/P7/8/8/8/8/8/K7 w - - 0 1');
    const played = window.__test.tryMove('a7', 'a8', 'n');
    return { loaded, played, state: window.__test.state(), board: window.__test.board() };
  })()`);
  const promotionAudit = auditBoardDom(promotion.board);
  await evalJs('window.__test.reset()');

  const castling = await evalJs(`(() => {
    const loaded = window.__test.loadFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const played = window.__test.tryMove('e1', 'g1');
    return { loaded, played, state: window.__test.state(), board: window.__test.board() };
  })()`);
  const castlingAudit = auditBoardDom(castling.board);
  await evalJs('window.__test.reset()');

  const pieceAt = (snapshot, sq, color, type) =>
    snapshot.pieces.some((piece) => piece.sq === sq && piece.color === color && piece.type === type);
  const noPieceAt = (snapshot, sq) => !snapshot.pieces.some((piece) => piece.sq === sq);
  record(
    capture.loaded && capture.played
      && captureAudit.exactFen
      && capture.board.total === 3
      && pieceAt(capture.board, 'd5', 'w', 'p')
      && noPieceAt(capture.board, 'e4')
      && promotion.loaded && promotion.played
      && promotionAudit.exactFen
      && promotion.board.total === 3
      && pieceAt(promotion.board, 'a8', 'w', 'n')
      && noPieceAt(promotion.board, 'a7')
      && castling.loaded && castling.played
      && castlingAudit.exactFen
      && castling.board.total === 6
      && pieceAt(castling.board, 'g1', 'w', 'k')
      && pieceAt(castling.board, 'f1', 'w', 'r')
      && noPieceAt(castling.board, 'e1')
      && noPieceAt(castling.board, 'h1'),
    '⑤ 吃子、升变、王车易位后，3D 棋子仍与 FEN 逐格一致',
    `吃子 ${capture.played}/${capture.board.total}枚/${captureAudit.exactFen}`
      + `｜升变 ${promotion.played}/${promotion.board.total}枚/${promotionAudit.exactFen}`
      + `｜易位 ${castling.played}/${castling.board.total}枚/${castlingAudit.exactFen}`);

  // 4× CPU 的 390px 手机上以“棋盘已绘制 + painted 标记”为终点，
  // 防止页面先记账、再同步算云，造成自报 2 秒而用户 4 秒才看到的假绿。
  await setViewport(390, 844, 'portraitPrimary');
  await send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await evalJs('window.__test.reset()');
  const slowCloud = await evalJs('window.__cloudStats()');
  const slowStartedAt = Date.now();
  const slowStart = await evalJs(`(() => {
    const generation = window.__test.workerGeneration();
    const t0 = performance.now();
    const played = window.__test.tryMove('e2', 'e4');
    return { played, callMs: performance.now() - t0, generation };
  })()`);
  let slowResult = null;
  while (Date.now() - slowStartedAt < 6000) {
    slowResult = await evalJs(`({
      ai: window.__test.ai(),
      state: window.__test.state(),
      board: window.__test.board(),
      status: document.getElementById('status').textContent,
    })`);
    if (
      slowResult.ai?.painted
      && !slowResult.state.thinking
      && slowResult.state.history.length === 2
    ) break;
    await sleep(35);
  }
  const slowWall = Date.now() - slowStartedAt;
  const slowBoardAudit = slowResult?.board ? auditBoardDom(slowResult.board) : { exactFen: false };
  let slowReplayOk = false;
  try {
    const replay = new Chess();
    for (const san of slowResult?.state?.history || []) replay.move(san);
    slowReplayOk = replay.fen() === slowResult?.state?.fen;
  } catch {}
  record(
    slowCloud.growing === true
      && slowStart.played
      && slowStart.callMs < 500
      && slowResult?.ai?.painted === true
      && slowResult?.ai?.totalMs <= 3000
      && slowWall <= 3000
      && slowReplayOk
      && slowBoardAudit.exactFen
      && slowResult?.status?.includes('轮到你'),
    '④ 4× 慢速手机以真实可见状态计时，AI 应手仍 ≤3 秒',
    `落子调用 ${slowStart.callMs.toFixed(1)}ms｜外部可见 ${slowWall}ms`
      + `｜页面可见 ${slowResult?.ai?.totalMs ?? '无'}ms｜painted=${slowResult?.ai?.painted}`
      + `｜云 depth=${slowCloud.depth}/growing=${slowCloud.growing}`
      + `｜棋谱 ${JSON.stringify(slowResult?.state?.history || [])}`);
  await evalJs('window.__test.reset()');
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await settleLayout();

  // 旧 AI 回包不能穿过 reset 污染新棋局：先触发一次搜索，马上重开，
  // 等过完整桌面预算后再看真实棋谱/思考态/回包和页面错误。
  const errorsBeforeResetRace = pageErrors.length;
  const resetRaceStarted = await evalJs(`(() => {
    const before = window.__forkStats().map((column) => column.chosenSan);
    const played = window.__test.tryMove('e2','e4');
    const picked = window.__test.pickBranch(0, 2);
    const toggled = window.__test.toggleCol(0);
    document.querySelector('#fork g.card[data-col="0"][data-idx="2"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const staleUi = {
      forkPending: window.__test.forkPending(),
      inert: document.getElementById('forkWrap').inert,
      busy: document.getElementById('fork').getAttribute('aria-busy'),
      buttonDisabled: document.getElementById('btnPlayLine').disabled,
      opacity: getComputedStyle(document.getElementById('fork')).opacity,
      after: window.__forkStats().map((column) => column.chosenSan),
      history: window.__test.state().history,
    };
    window.__test.reset();
    return {
      played,
      picked,
      toggled,
      before,
      staleUi,
      resetPv: window.__test.pv(),
    };
  })()`);
  record(
    resetRaceStarted.played
      && resetRaceStarted.picked === false
      && resetRaceStarted.toggled === false
      && resetRaceStarted.staleUi.forkPending === true
      && resetRaceStarted.staleUi.inert === true
      && resetRaceStarted.staleUi.busy === 'true'
      && resetRaceStarted.staleUi.buttonDisabled === true
      && Number(resetRaceStarted.staleUi.opacity) < .6
      && JSON.stringify(resetRaceStarted.staleUi.after) === JSON.stringify(resetRaceStarted.before)
      && resetRaceStarted.staleUi.history.length === 1,
    'AI 思考与新分叉就绪前，旧分叉彻底不可点也不会偷跑排序',
    `pick/toggle=${resetRaceStarted.picked}/${resetRaceStarted.toggled}`
      + `｜pending/inert/busy=${resetRaceStarted.staleUi.forkPending}/${resetRaceStarted.staleUi.inert}/${resetRaceStarted.staleUi.busy}`
      + `｜按钮 disabled=${resetRaceStarted.staleUi.buttonDisabled}`
      + `｜路径未变=${JSON.stringify(resetRaceStarted.staleUi.after) === JSON.stringify(resetRaceStarted.before)}`);
  await sleep(2200);
  const resetRace = await evalJs(`({
    state: window.__test.state(),
    ai: window.__test.ai(),
    pv: window.__test.pv(),
  })`);
  const resetRaceOk =
    resetRaceStarted.played === true
    && resetRace.state.history.length === 0
    && resetRace.state.thinking === false
    && resetRace.ai === null
    && resetRaceStarted.resetPv.active === false
    && resetRaceStarted.resetPv.steps.length === 0
    && resetRaceStarted.resetPv.goldCards.length === 0
    && resetRaceStarted.resetPv.goldEdges.length === 0
    && resetRace.pv.active === false
    && resetRace.pv.steps.length === 0
    && pageErrors.length === errorsBeforeResetRace;
  record(
    resetRaceOk,
    '重开会作废途中 AI 回包，不会把旧应手塞进新棋局',
    `触发 e4=${resetRaceStarted.played}｜等 2200ms 后 history=${JSON.stringify(resetRace.state.history)}`
      + `｜thinking=${resetRace.state.thinking}｜AI=${resetRace.ai ? resetRace.ai.san : 'null'}`
      + `｜PV 立即/迟到=${resetRaceStarted.resetPv.steps.length}/${resetRace.pv.steps.length}`
      + `｜新增错误=${pageErrors.length - errorsBeforeResetRace}`);
  await evalJs('window.__test.reset()');

  // 旧 Worker 不能只丢回包却继续占队列：e4→立刻重开→d4，新请求仍须独立守住 3 秒。
  const rapidResetAt = Date.now();
  const rapidStarted = await evalJs(`(() => {
    const generationBefore = window.__test.workerGeneration();
    const first = window.__test.tryMove('e2','e4');
    window.__test.reset();
    const generationAfterReset = window.__test.workerGeneration();
    const t0 = performance.now();
    const second = window.__test.tryMove('d2','d4');
    return {
      first,
      second,
      secondCallMs: performance.now() - t0,
      generationBefore,
      generationAfterReset,
    };
  })()`);
  let rapidAi = null, rapidState = null;
  while (Date.now() - rapidResetAt < 6000) {
    const current = await evalJs('({ ai: window.__test.ai(), state: window.__test.state() })');
    rapidAi = current.ai;
    rapidState = current.state;
    if (rapidAi?.painted && !rapidState.thinking && rapidState.history.length >= 2) break;
    await sleep(40);
  }
  const rapidWall = Date.now() - rapidResetAt;
  let rapidReplayOk = false;
  try {
    const replay = new Chess();
    for (const san of rapidState?.history || []) replay.move(san);
    rapidReplayOk = replay.fen() === rapidState?.fen;
  } catch {}
  record(
    rapidStarted.first && rapidStarted.second
      && rapidWall <= 3000
      && rapidAi?.totalMs <= 3000
      && rapidAi?.painted === true
      && rapidStarted.secondCallMs < 500
      && rapidStarted.generationAfterReset > rapidStarted.generationBefore
      && rapidState?.history?.[0] === 'd4'
      && rapidState.history.length === 2
      && rapidReplayOk,
    '重开会终止旧搜索，紧接的新 AI 请求不排队且 ≤3 秒',
    `e4/reset/d4=${rapidStarted.first}/${rapidStarted.second}`
      + `｜Worker 代际 ${rapidStarted.generationBefore}→${rapidStarted.generationAfterReset}`
      + `｜第二次落子调用 ${rapidStarted.secondCallMs.toFixed(1)}ms`
      + `｜外部 ${rapidWall}ms｜页面 ${rapidAi?.totalMs ?? '无'}ms`
      + `｜棋谱 ${JSON.stringify(rapidState?.history || [])}`);
  await evalJs('window.__test.reset()');

  // 即使搜索 Worker 被杀，主线程 watchdog 也必须在硬时限内走预存的合法保底步。
  const fallbackAt = Date.now();
  const fallbackStarted = await evalJs(`(() => {
    const played = window.__test.tryMove('e2','e4');
    const terminated = window.__test.terminateAiWorker();
    return { played, terminated };
  })()`);
  let fallbackAi = null, fallbackState = null, fallbackPv = null;
  while (Date.now() - fallbackAt < 6000) {
    const current = await evalJs(`({
      ai: window.__test.ai(),
      state: window.__test.state(),
      pv: window.__test.pv(),
    })`);
    fallbackAi = current.ai;
    fallbackState = current.state;
    fallbackPv = current.pv;
    if (fallbackAi?.painted && !fallbackState.thinking && fallbackState.history.length >= 2) break;
    await sleep(40);
  }
  const fallbackWall = Date.now() - fallbackAt;
  let fallbackReplayOk = false;
  try {
    const replay = new Chess();
    for (const san of fallbackState?.history || []) replay.move(san);
    fallbackReplayOk = replay.fen() === fallbackState?.fen;
  } catch {}
  record(
    fallbackStarted.played && fallbackStarted.terminated
      && fallbackWall <= 3000
      && fallbackAi?.fallback === true
      && fallbackAi?.painted === true
      && fallbackAi?.totalMs <= 3000
      && fallbackState?.history?.length === 2
      && fallbackPv?.active === false
      && fallbackPv?.steps?.length === 0
      && fallbackReplayOk,
    '搜索 Worker 失败时仍在 3 秒内走合法保底步',
    `外部 ${fallbackWall}ms｜页面 ${fallbackAi?.totalMs ?? '无'}ms`
      + `｜原因 ${fallbackAi?.reason || '无'}｜PV ${fallbackPv?.steps?.length ?? '无'} 手`
      + `｜棋谱 ${JSON.stringify(fallbackState?.history || [])}`);
  await evalJs('window.__test.reset()');

  // 4) e4 → AI ≤3 秒应一步合法棋
  const t0 = Date.now();
  const played = await evalJs(`window.__test.tryMove('e2','e4')`);
  record(played === true, '玩家 e4 被接受', String(played));
  let ai = null;
  while (Date.now() - t0 < 20000) {
    ai = await evalJs('window.__test.ai()');
    if (ai?.painted) break;
    await sleep(50);
  }
  const wall = Date.now() - t0;
  record(
    ai?.painted === true
      && ai?.fallback === false
      && ai?.depth >= 1
      && ai?.nodes > 0
      && ai?.totalMs <= 3000
      && wall <= 3000,
    'e4 后搜索 Worker 正常深搜并在 ≤3 秒应手',
    ai ? `外部秒表 ${wall}ms｜页面自计 ${ai.totalMs}ms｜走 ${ai.san}｜搜到 ${ai.depth} 层 ${ai.nodes} 节点` : '超时没应手');

  const actualCoach = await evalJs('window.__test.coach()');
  record(
    actualCoach.state === 'outcome'
      && actualCoach.title.includes(ai?.san || '')
      && actualCoach.preview?.replySource === 'actual'
      && actualCoach.preview?.reply?.san === ai?.san
      && actualCoach.preview?.drawnReply === true
      && actualCoach.outcome?.actualRank >= 0
      && actualCoach.paths.some((path) => path.step === 'you')
      && actualCoach.paths.some((path) => path.step === 'reply'),
    '⑥ AI 实际应手后，助手用蓝线呈现真实结果而不是丢掉先前分析',
    `state=${actualCoach.state}｜title=${actualCoach.title}`
      + `｜reply=${actualCoach.preview?.reply?.san || '无'}/${actualCoach.preview?.replySource || '无'}`
      + `｜rank=${actualCoach.outcome?.actualRank ?? '无'}`
      + `｜paths=${actualCoach.paths.map((path) => path.step).join('/') || '无'}`);

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
  for (let index = 0; index < 24; index++) {
    const pendingMotion = await evalJs('window.__test.phaseThreeVisual().pendingMotion');
    if (!pendingMotion) break;
    await sleep(50);
  }
  const board2 = await evalJs('window.__test.board()');
  const boardAudit2 = auditBoardDom(board2);
  record(
    boardAudit2.exactFen
      && board2.unicodeGlyphs === 0
      && board2.renderModes.length === 1
      && board2.renderModes[0] === 'vector-3d'
      && boardAudit2.boundsOk,
    '⑤ 落子与 AI 应手后棋子模型仍逐格吻合 FEN，没有幽灵棋子',
    `棋谱 ${JSON.stringify(st.history)}｜实际 ${board2.total} 枚`
      + `｜逐格 ${boardAudit2.exactFen ? '一致' : '不一致'}`
      + `｜renderer=${board2.renderModes.join('/')}｜边界=${boardAudit2.boundsOk}`);

  // 5) AI 走完后的新局面，再对一次数（这次的 fen 不是起始局面，能证明不是对着写死的数字）
  const s2 = await openCloudAndWait();
  console.log('AI 应手后路径网: ' + JSON.stringify({ depth: s2.depth, nodes: s2.nodes, total: s2.totalNodes, ms: s2.ms }));
  record(s2.fen !== s1.fen, '第二朵云的根局面确实换了', s2.fen);
  await checkNodesMatchCount(s2, '(局中)');
  await closeCloudAndWaitPreview();

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
  const previousAiSan = (await evalJs('window.__test.ai()'))?.san || '';
  const secondRequest = await evalJs(`(() => {
    const played = window.__test.tryMove('d2','d4');
    return { played, ai: window.__test.ai(), pending: window.__test.aiPending(), state: window.__test.state() };
  })()`);
  record(
    secondRequest.played
      && secondRequest.ai === null
      && !!secondRequest.pending
      && secondRequest.state.thinking,
    '新一轮 AI 思考会清掉上一手结果，不会把旧应手冒充完成',
    `上一手 ${previousAiSan || '无'}｜新请求 pending=${!!secondRequest.pending}`
      + `｜thinking=${secondRequest.state.thinking}｜ai=${secondRequest.ai ? secondRequest.ai.san : 'null'}`);
  for (let i = 0; i < 200 && !(await evalJs('window.__test.state().history.length >= 4')); i++) await sleep(50);
  // L4 的产品契约是「用户明确放大才续建」；第三次也通过真实按钮进入。
  await openCloudAndWait();
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

  await closeCloudAndWaitPreview();
  await runTree2dChecks();
  await runMobileChecks();
  await runPvGuideChecks();
  await runPhaseTwoNarrativeChecks();
  await runPhaseThreeDetailChecks();
  await runPhaseOneVisualChecks();

  record(pageErrors.length === 0, '页面无 JS 报错', pageErrors.slice(0, 3).join(' | ') || '零报错');

  await finishRun(EXPECTED_RESULTS);
}

async function finishRun(expectedResults) {
  if (results.length !== expectedResults) {
    record(
      false,
      '验收项总数没有静默缩水或意外膨胀',
      `运行到 ${results.length} 项，应为固定 ${expectedResults} 项`);
  }

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0
    ? `全绿：${results.length}/${results.length} 项通过。`
    : `有红：${failed.length}/${results.length} 项失败 → ${failed.map((r) => r.label).join('; ')}`);

  try { ws.close(); } catch {}
  try { chromeProcess && chromeProcess.kill('SIGKILL'); } catch {}
  if (server) server.close();
  try { chromeDir && fs.rmSync(chromeDir, { recursive: true, force: true }); } catch {}
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验收脚本自己崩了:', e);
  console.error('页面报错记录:', pageErrors);
  try { ws && ws.close(); } catch {}
  try { chromeProcess && chromeProcess.kill('SIGKILL'); } catch {}
  try { server && server.close(); } catch {}
  try { chromeDir && fs.rmSync(chromeDir, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
