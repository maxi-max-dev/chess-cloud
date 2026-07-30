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

let server = null;
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

function shotStats(file) {
  const { w, h, ch, px } = decodePng(fs.readFileSync(file));
  // 暖冷是成片分布的，只取一小块会被那块的颜色带偏。所以量整朵云，
  // 只把挡在前面的三块面板挖掉：左上抬头、左下棋盘、右边整条树面板（连同收树按钮）。
  const inPanel = (x, y) =>
    (x < w * 0.21 && y < h * 0.30) ||     // 抬头
    (x < w * 0.33 && y > h * 0.38) ||     // 棋盘面板
    (x > w * 0.55);                       // 树面板 + 收树按钮
  let total = 0, lit = 0, warm = 0, cold = 0, bright = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inPanel(x, y)) continue;
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
    w, h, total, lit, warm, cold, bright,
    litRatio: +(lit / total).toFixed(4),
    brightRatio: +(bright / total).toFixed(4),
    warmOfLit: +(warm / Math.max(1, lit)).toFixed(4),
    coldOfLit: +(cold / Math.max(1, lit)).toFixed(4),
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

async function main() {
  if (!URL_) URL_ = await serveLocal();
  console.log(`验收目标: ${URL_}\n`);
  const chrome = await launchChrome();
  await attach();

  await send('Page.navigate', { url: URL_ });
  await sleep(1500);
  await send('Page.bringToFront');

  // 1) 初始局面：等第 4 层长满，对数
  const s1 = await waitCloud();
  console.log('初始星云: ' + JSON.stringify({ depth: s1.depth, nodes: s1.nodes, total: s1.totalNodes, ms: s1.ms, layers: s1.layers }));
  await checkNodesMatchCount(s1, '');

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
  const ss = shotStats(SHOT);
  // 阈值用「占比」不用「绝对个数」，换布局/换分辨率都不会被量法误伤
  record(ss.litRatio > 0.05 && ss.brightRatio > 0.002,
    '② 截图里星云确实成形', `${SHOT} ${bytes}B｜取样区亮像素 ${ss.lit}/${ss.total} (${ss.litRatio})，很亮的占比 ${ss.brightRatio}`);
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

  // 6) 树：每层的岔路数是从 SVG 里真数出来的 <circle>，拿 count(该层局面, 1) 对撞
  const tree = await evalJs('window.__treeStats()');
  console.log('树的层: ' + JSON.stringify(tree.map((t) => `${t.kind}#${t.ply}:${t.siblings}→${t.chosenSan}`)));
  let treeOk = tree.length >= 6;
  const detail = [];
  for (const lv of tree) {
    const e = count(lv.fen, 1);
    if (lv.siblings !== e) { treeOk = false; detail.push(`第${lv.level}层 ${lv.siblings}≠${e}`); }
  }
  record(treeOk, '③ 树上每层岔路数 == count(该层局面, 1)',
    detail.length ? detail.join('; ') : `${tree.length} 层全对，含走过的 ${tree.filter((t) => t.kind === 'past').length} 层 + 未来 ${tree.filter((t) => t.kind === 'future').length} 层`);

  // 走过的那几层，高亮的那条必须就是实际走的棋
  const st2 = await evalJs('window.__test.state()');
  const pastSans = tree.filter((t) => t.kind === 'past').map((t) => t.chosenSan);
  record(JSON.stringify(pastSans) === JSON.stringify(st2.history.slice(-pastSans.length)),
    '③ 树上走过的那条线 == 真实棋谱', `树 ${JSON.stringify(pastSans)} vs 棋谱 ${JSON.stringify(st2.history)}`);

  // 点树上另一条岔路，主干必须真的改道
  const before = tree.find((t) => t.kind === 'future');
  const switched = await evalJs(`(() => {
    const t = window.__treeStats();
    const i = t.findIndex((x) => x.kind === 'future');
    const before = t[i].chosenSan;
    // 挑一个和当前不同的岔路
    window.__test.pickTreeNode(i, t[i].siblings - 1);
    const after = window.__treeStats()[i].chosenSan;
    return { i, before, after, n: t[i].siblings };
  })()`);
  record(switched.before !== switched.after,
    '③ 点另一条岔路，树真的改道', `第 ${switched.i} 层（共 ${switched.n} 条）：${switched.before} → ${switched.after}`);

  // 7) 再走一个回合，让树上攒出更多「走过的路」，把那几层也验一遍
  await evalJs(`window.__test.tryMove('d2','d4')`);
  for (let i = 0; i < 200 && !(await evalJs('window.__test.state().history.length >= 4')); i++) await sleep(50);
  await waitCloud();
  const tree2 = await evalJs('window.__treeStats()');
  const st3 = await evalJs('window.__test.state()');
  let tree2Ok = tree2.filter((t) => t.kind === 'past').length === 4;
  const d2 = [];
  for (const lv of tree2) {
    const e = count(lv.fen, 1);
    if (lv.siblings !== e) { tree2Ok = false; d2.push(`第${lv.level}层 ${lv.siblings}≠${e}`); }
  }
  const past2 = tree2.filter((t) => t.kind === 'past').map((t) => t.chosenSan);
  if (JSON.stringify(past2) !== JSON.stringify(st3.history)) { tree2Ok = false; d2.push('走过的线和棋谱对不上'); }
  record(tree2Ok, '③ 走满两回合后，树的每层仍然对得上',
    d2.length ? d2.join('; ') : `棋谱 ${JSON.stringify(st3.history)}｜各层岔路 ${tree2.map((t) => t.siblings).join('/')}`);

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  const SHOT2 = SHOT.replace(/\.png$/, '-line.png');
  fs.writeFileSync(SHOT2, Buffer.from(shot2.data, 'base64'));
  console.log(`走过两回合的截图: ${SHOT2}`);

  record(pageErrors.length === 0, '页面无 JS 报错', pageErrors.slice(0, 3).join(' | ') || '零报错');

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0
    ? `全绿：${results.length}/${results.length} 项通过。`
    : `有红：${failed.length}/${results.length} 项失败 → ${failed.map((r) => r.label).join('; ')}`);

  try { ws.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  if (server) server.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验收脚本自己崩了:', e);
  console.error('页面报错记录:', pageErrors);
  try { ws && ws.close(); } catch {}
  process.exit(2);
});
