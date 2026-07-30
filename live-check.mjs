// live-check.mjs —— 无头 Chrome + CDP 真机验收（本地或线上都能跑）
// 用法：node live-check.mjs [--url https://...] [--shot out.png] [--port 9333]
// 默认自动选空闲 CDP/静态服务端口；只有需要并行复现某次运行时才显式传 --port。
// 不给 --url 就自己起一个静态服务器伺候 ~/code/chess-cloud

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
let URL_ = arg('--url', null);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

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
  return `http://127.0.0.1:${address.port}/index.html`;
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
  const p = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${chromeDir}`,
    '--window-size=1440,900',
    // 无头下 WebGL：走 angle+swiftshader，别用 --disable-gpu（会出合成伪影/黑画布）
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
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
const EXPECTED_RESULTS = 70;
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
      const move = rankMoves(after, { depth: 1 })[0] || null;
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
    coach.cards.length > 0 && replyProblems.length === 0,
    '⑥ 对方回应可独立重放，且确为 rankMoves(after, depth=1) 的首选',
    replyProblems.length
      ? replyProblems.join('; ')
      : coach.cards.map((card) => `${card.san}→${card.reply.piece} ${card.reply.san}`).join('　'));

  const animationState = await evalJs('window.__test.state()');
  const animationCoach = await evalJs('window.__test.coach()');
  const activeCard = animationCoach.cards.find((card) => card.active) || null;
  const youPath = animationCoach.paths.find((path) => path.step === 'you') || null;
  const replyPath = animationCoach.paths.find((path) => path.step === 'reply') || null;
  const animationLineIds = new Set(animationCoach.paths.map((path) => path.lineId).filter(Boolean));
  const animatedPath = (path) =>
    !!path
    && path.pathLength === 1
    && path.d.includes('Q')
    && path.animationName !== 'none'
    && parseFloat(path.animationDuration) > 0
    && path.animationIterationCount === 'infinite';
  record(
    animationCoach.paths.length === 2
      && animationLineIds.size === 1
      && animatedPath(youPath)
      && animatedPath(replyPath)
      && !!activeCard
      && youPath.san === activeCard.san
      && youPath.from === activeCard.from
      && youPath.to === activeCard.to
      && replyPath.san === activeCard.reply.san
      && replyPath.from === activeCard.reply.from
      && replyPath.to === activeCard.reply.to
      && animationState.fen === coach.fen
      && animationCoach.fen === coach.fen
      && animationState.history.length === 0,
    '⑥ DOM 上有同一 lineId 的「你 → 回应」两段真实动画，预演不落子',
    `lineId=${[...animationLineIds][0] || '无'}`
      + `｜steps=${animationCoach.paths.map((path) => `${path.step}:${path.animationName}/${path.animationDuration}`).join('　')}`
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
      && switchedCoach.paths.length === 2
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
    && keyboardAudit.paths === 2
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
  await clickSelector('#btnReset');
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
      && resetUi.after.scrollLeft <= 1
      && resetUi.after.state.history.length === 0
      && resetUi.after.state.thinking === false
      && resetUi.after.ai === null
      && resetUi.after.pending === null
      && resetUi.after.status.includes('你执白')
      && resetUi.after.foot.includes('亮蓝主干')
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
    '④ 手机路径网离屏会释放已长满的第四层，屏外重建也只铺真实三层',
    `已满云离屏 layers=${JSON.stringify(releasedFullCloud.layers.map((layer) => layer.depth))}`
      + `｜闲置 250ms 的 active ms ${releasedFullCloud.ms}→${releasedIdleCloud.ms}`
      + `｜重开后 sky y=${Math.round(offscreenCloud.sky.top)}..${Math.round(offscreenCloud.sky.bottom)}`
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
  const bottomEdge = edgeStats(bottomFile, portrait.viewport.w, portrait.viewport.h);
  record(
    topEdge.darkRatio > 0.98
      && bottomEdge.darkRatio > 0.98
      && bottomPosition.y >= bottomPosition.max - 1,
    '④ 手机背景从页面顶部铺到底部，无白边或透明断层',
    `顶部深色 ${topEdge.darkRatio}｜底部深色 ${bottomEdge.darkRatio}｜滚动 ${Math.round(bottomPosition.y)}/${Math.round(bottomPosition.max)}`);
  const mobileEnteredCloud = await waitCloud(30000);

  // 全屏要真占满 viewport，四角的命中层也必须属于路径网，而不是后面的面板。
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
    '④ 真实触摸路径网标签会同步第一列选路，但棋谱不动',
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
    && hiddenAfterDrag > 0
    && visibilityChanged;
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
  record(fullOk, '④ 手机路径网是真全屏，并可用明确按钮真实触摸收起',
    `真实触摸开/按钮关｜盒子 ${Math.round(fsb.x)},${Math.round(fsb.y)} ${Math.round(fsb.w)}×${Math.round(fsb.h)}`
      + `｜画布 ${fsc.pixelW}×${fsc.pixelH}｜四角命中 ${full.cornersHit}`
      + `｜收起按钮 ${Math.round(closeTap.w)}×${Math.round(closeTap.h)}｜关闭后 full=${closed.layout.cloudFull}`);

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
  const mobileReenteredCloud = await waitCloud(30000);
  record(
    offscreenCloud.stats.depth === 3
      && hasExactCloudDepths(offscreenCloud.stats, 3)
      && mobileEnteredCloud.depth === 4
      && hasExactCloudDepths(mobileEnteredCloud, 4)
      && mobileEnteredCloud.layers.some((layer) => layer.depth === 4)
      && mobileLeftCloud.depth === 3
      && hasExactCloudDepths(mobileLeftCloud, 3)
      && mobileLeftCloud.deepPending === true
      && !mobileLeftCloud.layers.some((layer) => layer.depth === 4)
      && !mobileLeftMap.layers.some((layer) => layer.depth === 4)
      && mobileLeftMap.orphanRenderObjects === 0
      && mobileReenteredCloud.depth === 4
      && hasExactCloudDepths(mobileReenteredCloud, 4)
      && mobileReenteredCloud.layers.some((layer) => layer.depth === 4)
      && mobileReenteredCloud.nodes === count(mobileReenteredCloud.fen, 4),
    '④ 手机路径网进视口长满 L4、离屏释放、再进入会完整长回',
    `屏外 ${JSON.stringify(offscreenCloud.stats.layers.map((layer) => layer.depth))}`
      + ` → 进入 ${JSON.stringify(mobileEnteredCloud.layers.map((layer) => layer.depth))}/${mobileEnteredCloud.nodes}`
      + ` → 离屏 ${JSON.stringify(mobileLeftCloud.layers.map((layer) => layer.depth))}/pending=${mobileLeftCloud.deepPending}`
      + `/scene=${JSON.stringify(mobileLeftMap.layers.map((layer) => layer.depth))}`
      + ` → 再入 ${JSON.stringify(mobileReenteredCloud.layers.map((layer) => layer.depth))}/${mobileReenteredCloud.nodes}`);

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
    '④ 常见手机横屏与平板均完整，按钮和走法卡不小于 44px',
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
  if (PORT > 0) {
    if (await portInUse(PORT)) throw new Error(`CDP 端口 ${PORT} 已被占用，请换一个 --port`);
  }
  if (!URL_) URL_ = await serveLocal();
  chromeProcess = await launchChrome();
  console.log(`验收目标: ${URL_}（CDP ${PORT}）\n`);
  await attach();

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

  // 用户不会等第四层云长满才落子：首屏一能操作就立刻走，AI 仍必须守住 3 秒。
  const coldCloud = await evalJs('window.__cloudStats()');
  const coldStartedAt = Date.now();
  const coldPlayed = await evalJs(`window.__test.tryMove('e2','e4')`);
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
    coldCloud.growing === true
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

  // 1) 初始局面：等第 4 层长满，对数
  const s1 = await waitCloud();
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
      && cloudMap1.layers.every((layer) => layer.finite),
    '② 所有路径都是真实非索引 LineSegments，顶点/颜色对齐且没有隐藏或 drawRange 假账',
    cloudMap1.layers.map((layer) => `L${layer.depth}:${layer.count}/${layer.finite ? 'finite' : 'NaN'}`).join('　')
      + `｜objects=${cloudMap1.lineObjects}`
      + `｜hidden/odd/color/draw=${cloudMap1.hiddenLineObjects}/${cloudMap1.oddVertexObjects}`
      + `/${cloudMap1.colorMismatchObjects}/${cloudMap1.partialDrawObjects}`
      + `｜wrongType/index/orphan=${cloudMap1.nonLineSegmentObjects}`
      + `/${cloudMap1.indexedLinkObjects}/${cloudMap1.orphanRenderObjects}`);

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
    cloudAutoRestored = await evalJs('window.__test.setCloudAuto(true)');
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

  const boardBlankFile = SHOT.replace(/\.png$/i, '-board-blank.png');
  await evalJs('document.getElementById("boardPieces").style.visibility = "hidden"');
  await settleLayout();
  const boardBlankShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(boardBlankFile, Buffer.from(boardBlankShot.data, 'base64'));
  await evalJs('document.getElementById("boardPieces").style.visibility = ""');
  await settleLayout();
  const desktopLayout = await evalJs('window.__test.layout()');
  const boardPixels1 = boardPiecePixelStats(SHOT, boardBlankFile, board1, desktopLayout.viewport);
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
    return { played, picked, toggled, before, staleUi };
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
  })`);
  const resetRaceOk =
    resetRaceStarted.played === true
    && resetRace.state.history.length === 0
    && resetRace.state.thinking === false
    && resetRace.ai === null
    && pageErrors.length === errorsBeforeResetRace;
  record(
    resetRaceOk,
    '重开会作废途中 AI 回包，不会把旧应手塞进新棋局',
    `触发 e4=${resetRaceStarted.played}｜等 2200ms 后 history=${JSON.stringify(resetRace.state.history)}`
      + `｜thinking=${resetRace.state.thinking}｜AI=${resetRace.ai ? resetRace.ai.san : 'null'}`
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
  let fallbackAi = null, fallbackState = null;
  while (Date.now() - fallbackAt < 6000) {
    const current = await evalJs('({ ai: window.__test.ai(), state: window.__test.state() })');
    fallbackAi = current.ai;
    fallbackState = current.state;
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
      && fallbackReplayOk,
    '搜索 Worker 失败时仍在 3 秒内走合法保底步',
    `外部 ${fallbackWall}ms｜页面 ${fallbackAi?.totalMs ?? '无'}ms`
      + `｜原因 ${fallbackAi?.reason || '无'}｜棋谱 ${JSON.stringify(fallbackState?.history || [])}`);
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
  const s2 = await waitCloud();
  console.log('AI 应手后路径网: ' + JSON.stringify({ depth: s2.depth, nodes: s2.nodes, total: s2.totalNodes, ms: s2.ms }));
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
  // L4 的产品契约是「路径窗可见才续建」。前面的分叉交互可能让浏览器把路径窗滚出视口；
  // 明确滚回来再要求长满，避免把正确的 deepPending 节流误判成 Worker 卡死。
  await evalJs('document.getElementById("skyBox").scrollIntoView({ block: "center", inline: "nearest" })');
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

  if (results.length !== EXPECTED_RESULTS) {
    record(
      false,
      '验收项总数没有静默缩水或意外膨胀',
      `运行到 ${results.length} 项，应为固定 ${EXPECTED_RESULTS} 项`);
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
