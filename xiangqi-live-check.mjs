#!/usr/bin/env node
// xiangqi-live-check.mjs —— 中国象棋真 Chrome + CDP 验收。
//
// 用法：
//   node xiangqi-live-check.mjs
//   node xiangqi-live-check.mjs --url https://example.com/chess-cloud/
//   node xiangqi-live-check.mjs --port 9334
//
// 默认自建静态服务器，从根首页实际点击进入两个棋种。所有页面数量都从 DOM
// 当前渲染对象读取，再由 Node 端 xiangqi-engine.js 独立重放，不信任页面自报数字。

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  START_FEN,
  applyMove,
  generateLegalMoves,
  getThreats,
  indexToSquare,
  moveToNotation,
  parseFen,
  toFen,
} from './xiangqi-engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

let cdpPort = Number(arg('--port', '0'));
let requestedUrl = arg('--url');
let server = null;
let chrome = null;
let chromeProfile = null;
let socket = null;
let nextId = 1;
const pending = new Map();
const pageErrors = [];
const results = [];
const EXPECTED_RESULTS = 47;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const moveKey = (move) => `${move.from}-${move.to}`;

function record(ok, name, detail = '') {
  const passed = Boolean(ok);
  results.push({ ok: passed, name, detail });
  console.log(`${passed ? '绿 ✓' : '红 ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function sameFen(left, right) {
  try {
    return toFen(parseFen(left)) === toFen(parseFen(right));
  } catch {
    return false;
  }
}

function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('找不到 Google Chrome/Chromium；可用 CHROME_BIN 指定');
  return found;
}

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
});

async function serveLocal() {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local.test').pathname);
    const relative = pathname === '/' ? '/index.html' : pathname;
    const file = path.resolve(ROOT, `.${relative}`);
    const inside = file.startsWith(`${ROOT}${path.sep}`);
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}/`;
}

function siteRoot(input) {
  const url = new URL(input);
  url.search = '';
  url.hash = '';
  if (/\/(?:index|chess|xiangqi)\.html$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/[^/]+$/, '');
  } else if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url.href;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    const done = (used) => {
      probe.destroy();
      resolve(used);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(500, () => done(false));
  });
}

function rejectPending(error) {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(error);
  }
  pending.clear();
}

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} 超过 30 秒无响应`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

async function evaluate(expression, awaitPromise = false) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || '未知页面异常';
    throw new Error(description);
  }
  return response.result.value;
}

async function launchChrome() {
  if (cdpPort && await portInUse(cdpPort)) {
    throw new Error(`CDP 端口 ${cdpPort} 已被占用`);
  }
  chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangqi-live-chrome-'));
  chrome = spawn(chromeBinary(), [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    'about:blank',
  ], { stdio: 'ignore' });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (!cdpPort) {
      try {
        const active = fs.readFileSync(path.join(chromeProfile, 'DevToolsActivePort'), 'utf8')
          .trim().split(/\r?\n/);
        const discovered = Number(active[0]);
        if (Number.isInteger(discovered) && discovered > 0) cdpPort = discovered;
      } catch {
        // Chrome 尚未写端口。
      }
    }
    try {
      if (!cdpPort) throw new Error('尚无端口');
      const version = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (version.ok) return;
    } catch {
      // 继续等 Chrome。
    }
    await sleep(200);
  }
  throw new Error('Chrome 在 20 秒内没有启动');
}

async function attach() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('CDP 没有 page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails;
      pageErrors.push(`page: ${detail.exception?.description || detail.text || '未知异常'}`);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const values = message.params.args.map((item) => item.value ?? item.description);
      pageErrors.push(`console.error: ${JSON.stringify(values)}`);
    }
  };
  socket.onerror = () => rejectPending(new Error('CDP WebSocket 通信失败'));
  socket.onclose = () => rejectPending(new Error('CDP WebSocket 已关闭'));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');

  // 必须在页面代码前注入。最终检查“稳定后计数不再增长”，不相信页面自报
  // continuousAnimation=false。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const nativeRaf = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      let requested = 0;
      let callbacks = 0;
      let cancelled = 0;
      window.requestAnimationFrame = (callback) => {
        requested += 1;
        return nativeRaf((time) => {
          callbacks += 1;
          callback(time);
        });
      };
      window.cancelAnimationFrame = (id) => {
        cancelled += 1;
        return nativeCancel(id);
      };
      Object.defineProperty(window, '__xiangqiRafAudit', {
        value: Object.freeze({
          snapshot: () => Object.freeze({ requested, callbacks, cancelled }),
        }),
        configurable: false,
        writable: false,
      });
    })();`,
  });
}

async function waitFor(expression, timeoutMs = 10000, label = expression) {
  const started = performance.now();
  let lastError = null;
  while (performance.now() - started < timeoutMs) {
    try {
      if (await evaluate(`Boolean(${expression})`)) return performance.now() - started;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`${label} 超时${lastError ? `：${lastError.message}` : ''}`);
}

async function navigate(url, readyExpression = 'document.readyState === "complete"') {
  await send('Page.navigate', { url });
  await waitFor(
    `location.href === ${JSON.stringify(url)} || location.href.startsWith(${JSON.stringify(url)})`,
    15000,
    `导航 ${url}`,
  );
  await waitFor(readyExpression, 15000, `页面就绪 ${url}`);
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 760,
    screenWidth: width,
    screenHeight: height,
  });
}

function legalTransition(beforeFen, afterFen) {
  const before = parseFen(beforeFen);
  const matches = [];
  for (const move of generateLegalMoves(before)) {
    const next = applyMove(before, move, { validate: false });
    if (sameFen(toFen(next), afterFen)) matches.push({ move, next });
  }
  return matches;
}

function auditPathNodes(rootFen, nodes) {
  const problems = [];
  let replayFen = rootFen;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (Number(node.ply) !== index + 1) problems.push(`第 ${index + 1} 节点 ply=${node.ply}`);
    const matches = legalTransition(replayFen, node.fen);
    if (matches.length !== 1) {
      problems.push(`第 ${index + 1} 手无法唯一合法重放（${matches.length} 条匹配）`);
      break;
    }
    const replies = generateLegalMoves(matches[0].next).length;
    if (Number(node.branches) !== replies) {
      problems.push(`第 ${index + 1} 手分叉 ${node.branches}≠${replies}`);
    }
    replayFen = toFen(matches[0].next);
  }
  return { ok: problems.length === 0, problems, replayFen };
}

function auditPvNodes(sourceFen, nodes) {
  const problems = [];
  let replayFen = sourceFen;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const matches = legalTransition(replayFen, node.fen);
    if (matches.length !== 1) {
      problems.push(`PV 第 ${index + 1} 手无法唯一合法重放（${matches.length} 条匹配）`);
      break;
    }
    const move = matches[0].move;
    const expectedLabel = moveToNotation(parseFen(replayFen), move);
    if (node.label !== expectedLabel) {
      problems.push(`PV 第 ${index + 1} 手文案 ${node.label}≠${expectedLabel}`);
    }
    const branches = generateLegalMoves(matches[0].next).length;
    if (Number(node.branches) !== branches) {
      problems.push(`PV 第 ${index + 1} 手分叉 ${node.branches}≠${branches}`);
    }
    replayFen = toFen(matches[0].next);
  }
  return { ok: nodes.length > 0 && problems.length === 0, problems };
}

function auditBranches(fen, branches) {
  const position = parseFen(fen);
  const legal = generateLegalMoves(position);
  const legalByKey = new Map(legal.map((move) => [
    `${move.fromIndex}-${move.toIndex}`,
    move,
  ]));
  const problems = [];
  const seen = new Set();
  for (const branch of branches) {
    const key = `${branch.from}-${branch.to}`;
    const move = legalByKey.get(key);
    if (!move) {
      problems.push(`DOM 含非法分叉 ${key}`);
      continue;
    }
    if (seen.has(key)) problems.push(`DOM 分叉重复 ${key}`);
    seen.add(key);
    const child = applyMove(position, move, { validate: false });
    const after = toFen(child);
    const replyCount = generateLegalMoves(child).length;
    if (!sameFen(branch.fen, after)) problems.push(`${key} after FEN 不同源`);
    if (Number(branch.branches) !== replyCount) {
      problems.push(`${key} 应手 ${branch.branches}≠${replyCount}`);
    }
  }
  if (branches.length !== legal.length) problems.push(`DOM ${branches.length} 条≠棋核 ${legal.length} 条`);
  return { ok: problems.length === 0, problems };
}

async function portalAudit(rootUrl) {
  await setViewport(1440, 900);
  await navigate(rootUrl);
  const links = await evaluate(`(() => [...document.querySelectorAll('a[data-game]')].map((link) => ({
    game: link.dataset.game,
    href: link.href,
    tag: link.tagName,
    text: link.textContent.trim(),
    width: link.getBoundingClientRect().width,
    height: link.getBoundingClientRect().height,
  })))()`);
  const byGame = new Map(links.map((link) => [link.game, link]));
  const chessLink = byGame.get('chess');
  const xiangqiLink = byGame.get('xiangqi');
  record(
    links.length === 2
      && chessLink?.tag === 'A'
      && xiangqiLink?.tag === 'A'
      && new URL(chessLink.href).pathname.endsWith('/chess.html')
      && new URL(xiangqiLink.href).pathname.endsWith('/xiangqi.html'),
    '根首页现读到两个真实棋种链接',
    links.map((link) => `${link.game}:${new URL(link.href).pathname}`).join('｜'),
  );

  await evaluate(`document.querySelector('a[data-game="chess"]').click()`);
  await waitFor(`location.pathname.endsWith('/chess.html')`, 15000, '点击国际象棋入口');
  record(
    await evaluate(`location.pathname.endsWith('/chess.html') && document.title.length > 0`),
    '国际象棋入口可实际点击进入',
    await evaluate('location.pathname'),
  );

  await navigate(rootUrl);
  await evaluate(`document.querySelector('a[data-game="xiangqi"]').click()`);
  await waitFor(
    `location.pathname.endsWith('/xiangqi.html') && window.__xiangqiTest && document.querySelectorAll('#board .square').length === 90`,
    15000,
    '点击中国象棋入口',
  );
  record(
    await evaluate(`location.pathname.endsWith('/xiangqi.html')`),
    '中国象棋入口可实际点击进入',
    await evaluate('location.pathname'),
  );
}

async function initialAudit() {
  await waitFor(
    `document.querySelectorAll('#branchGrid .branch-node').length === 44
      && [...document.querySelectorAll('#branchGrid .branch-node')]
        .every((node) => node.dataset.fen && /^\\d+$/.test(node.dataset.branches))`,
    12000,
    '初始 44 条完整分叉',
  );
  const initial = await evaluate(`(() => {
    const pieces = [...document.querySelectorAll('#board .piece')];
    const squares = [...document.querySelectorAll('#board .square')];
    const branches = [...document.querySelectorAll('#branchGrid .branch-node')];
    return {
      fen: window.__xiangqiTest.fen,
      pieces: pieces.length,
      red: pieces.filter((piece) => piece.dataset.side === 'red').length,
      black: pieces.filter((piece) => piece.dataset.side === 'black').length,
      squares: squares.length,
      uniqueSquares: new Set(squares.map((square) => square.dataset.square)).size,
      branchCount: branches.length,
      displayedLegal: Number(document.getElementById('legalCount').textContent),
      rootBranches: Number(document.querySelector('.root-node').dataset.branches),
      branches: branches.map((node) => ({
        from: Number(node.dataset.from),
        to: Number(node.dataset.to),
        fen: node.dataset.fen,
        branches: Number(node.dataset.branches),
      })),
    };
  })()`);
  record(
    initial.pieces === 32 && initial.red === 16 && initial.black === 16,
    '初始棋子由 DOM 现读为红黑各 16',
    `总数=${initial.pieces}｜红=${initial.red}｜黑=${initial.black}`,
  );
  record(
    initial.squares === 90 && initial.uniqueSquares === 90,
    '棋盘由 DOM 现读为 9×10',
    `格点=${initial.squares}｜唯一格点=${initial.uniqueSquares}`,
  );
  record(
    sameFen(initial.fen, START_FEN)
      && initial.branchCount === 44
      && initial.displayedLegal === initial.branchCount
      && initial.rootBranches === initial.branchCount,
    '初始 44 分叉与 DOM、页面数字、根节点对账',
    `DOM=${initial.branchCount}｜数字=${initial.displayedLegal}｜根=${initial.rootBranches}`,
  );
  const branchAudit = auditBranches(initial.fen, initial.branches);
  record(
    branchAudit.ok,
    '每条初始 branch 的 FEN 与 replyCount 均由 Node 棋核重放对账',
    branchAudit.ok ? `${initial.branches.length} 条全部同源` : branchAudit.problems.slice(0, 4).join('；'),
  );
  return initial.fen;
}

async function futureContractAudit() {
  await waitFor(
    `window.__futureTest?.snapshot().suggestedPath.length === 1
      && !!document.querySelector('#branchGrid .branch-node[data-reply-from]:not([data-reply-from=""])')`,
    5000,
    '统一未来地图建议路线',
  );
  const state = await evaluate(`(() => {
    const initial = window.__futureTest.snapshot();
    const liveBefore = window.__xiangqiTest.fen;
    const card = document.querySelector(
      '#branchGrid .branch-node[data-reply-from]:not([data-reply-from=""])'
    );
    const key = card ? card.dataset.from + '-' + card.dataset.to : '';
    const selected = window.__futureTest.selectNode(0, key);
    const afterSelect = window.__futureTest.snapshot();
    const liveAfterSelect = window.__xiangqiTest.fen;
    window.__futureTest.setMode('overview-3d');
    const overview = window.__futureTest.snapshot();
    window.__futureTest.setMode('tree-2d');
    const tree = window.__futureTest.snapshot();
    window.__futureTest.rewind();
    return { initial, liveBefore, selected, afterSelect, liveAfterSelect, overview, tree };
  })()`);
  const rootCount = generateLegalMoves(parseFen(state.initial.root.fen)).length;
  const selectedFens = state.afterSelect.selectedPath.map((step) => step.afterFen);
  const selectedStep = state.afterSelect.selectedPath[0];
  const firstTransition = selectedStep
    ? legalTransition(state.initial.root.fen, selectedStep.afterFen)
    : [];
  const replyTransition = selectedStep
    ? legalTransition(selectedStep.afterFen, state.afterSelect.preview.fen)
    : [];
  record(
    state.initial.schema === 1
      && state.initial.game === 'xiangqi'
      && state.initial.selectedPath.length === 0
      && state.initial.suggestedPath.length === 1
      && state.initial.root.branchCount === rootCount
      && state.selected === true
      && selectedFens.length === 1
      && firstTransition.length === 1
      && selectedStep.branchCount
        === generateLegalMoves(parseFen(selectedStep.afterFen)).length
      && state.afterSelect.preview.depth === 2
      && state.afterSelect.preview.path[0].role === 'selected'
      && state.afterSelect.preview.path[1].role === 'engine'
      && replyTransition.length === 1
      && sameFen(state.liveAfterSelect, state.liveBefore)
      && state.overview.mode === 'overview-3d'
      && state.tree.mode === 'tree-2d'
      && sameFen(state.overview.preview.fen, state.afterSelect.preview.fen)
      && sameFen(state.tree.preview.fen, state.afterSelect.preview.fen)
      && JSON.stringify(state.overview.selectedPath.map((step) => step.afterFen))
        === JSON.stringify(selectedFens)
      && JSON.stringify(state.tree.selectedPath.map((step) => step.afterFen))
        === JSON.stringify(selectedFens),
    '统一未来地图契约：推荐不冒充选路，2D/3D 共用预演且不改实战',
    `根=${rootCount}｜初始选路=${state.initial.selectedPath.length}`
      + `｜选择后=${selectedFens.length}｜合法强应=${replyTransition.length === 1}`
      + `｜模式=${state.overview.mode}→${state.tree.mode}`
      + `｜实战未变=${sameFen(state.liveAfterSelect, state.liveBefore)}`,
  );
}

async function futureRaceAndOverviewAudit() {
  await setViewport(1440, 900);
  const early = await evaluate(`(() => {
    window.__xiangqiTest.reset();
    const beforeFen = window.__xiangqiTest.fen;
    const card = document.querySelector('#branchGrid .branch-node');
    const key = card ? card.dataset.from + '-' + card.dataset.to : '';
    card?.click();
    const snapshot = window.__futureTest.snapshot();
    return {
      beforeFen,
      key,
      liveFen: window.__xiangqiTest.fen,
      previewDepth: snapshot.preview.depth,
      selectedPathLength: snapshot.selectedPath.length,
      selectedAfterFen: snapshot.selectedPath[0]?.afterFen || '',
      title: document.getElementById('xqFutureTitle').textContent,
      replyReady: !!card?.dataset.replyFrom,
    };
  })()`);
  await waitFor(
    `!!document.querySelector(
      '#branchGrid .branch-node[data-selected="true"][data-reply-from]:not([data-reply-from=""])'
    )`,
    12000,
    '提前选路后的 Worker 强回应',
  );
  const resolved = await evaluate(`(() => {
    const snapshot = window.__futureTest.snapshot();
    return {
      liveFen: window.__xiangqiTest.fen,
      previewDepth: snapshot.preview.depth,
      previewFen: snapshot.preview.fen,
      path: snapshot.preview.path,
      title: document.getElementById('xqFutureTitle').textContent,
    };
  })()`);
  const selectedStep = resolved.path[0];
  const replyTransition = selectedStep
    ? legalTransition(selectedStep.afterFen, resolved.previewFen)
    : [];
  record(
    early.key
      && early.selectedPathLength === 1
      && !early.replyReady
      && early.previewDepth === 1
      && sameFen(early.liveFen, early.beforeFen)
      && resolved.previewDepth === 2
      && resolved.path[1]?.role === 'engine'
      && replyTransition.length === 1
      && !resolved.title.includes('无合法应手')
      && sameFen(resolved.liveFen, early.beforeFen),
    '分叉 Worker 回包前先选路线，回应就绪后会升级同一预演且不改实战',
    `提前=${early.previewDepth}层/${early.replyReady ? '已有回应' : '未有回应'}`
      + `｜回包后=${resolved.previewDepth}层`
      + `｜合法强应=${replyTransition.length === 1}`
      + `｜实战未变=${sameFen(resolved.liveFen, early.beforeFen)}`,
  );

  await evaluate(`(() => {
    window.__futureTest.rewind();
    window.__futureTest.setMode('overview-3d');
    document.getElementById('xqOverview').scrollIntoView({ block: 'center' });
  })()`);
  await sleep(120);
  const overviewBefore = await evaluate(`(() => {
    const host = document.getElementById('xqOverview');
    const svg = document.getElementById('xqOverviewSvg');
    const hostRect = host.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const nodes = [...svg.querySelectorAll('[data-overview-key]')];
    const visible = nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.right > svgRect.left && rect.left < svgRect.right
        && rect.bottom > svgRect.top && rect.top < svgRect.bottom;
    }).length;
    return {
      total: nodes.length,
      visible,
      startX: hostRect.left + 38,
      startY: hostRect.bottom - 26,
      dragX: Math.min(530, Math.max(160, hostRect.width - 76)),
    };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: overviewBefore.startX,
    y: overviewBefore.startY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: overviewBefore.startX + overviewBefore.dragX,
    y: overviewBefore.startY,
    button: 'left',
    buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: overviewBefore.startX + overviewBefore.dragX,
    y: overviewBefore.startY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(100);
  const overviewAfter = await evaluate(`(() => {
    const svg = document.getElementById('xqOverviewSvg');
    const svgRect = svg.getBoundingClientRect();
    const nodes = [...svg.querySelectorAll('[data-overview-key]')];
    const rects = nodes.map((node) => node.getBoundingClientRect());
    return {
      total: nodes.length,
      visible: rects.filter((rect) =>
        rect.right > svgRect.left && rect.left < svgRect.right
          && rect.bottom > svgRect.top && rect.top < svgRect.bottom
      ).length,
      minLeft: Math.min(...rects.map((rect) => rect.left)),
      maxRight: Math.max(...rects.map((rect) => rect.right)),
      svgLeft: svgRect.left,
      svgRight: svgRect.right,
    };
  })()`);
  record(
    overviewBefore.total === 44
      && overviewBefore.visible === overviewBefore.total
      && overviewAfter.total === overviewBefore.total
      && overviewAfter.visible === overviewAfter.total,
    '全景大幅拖动后全部真实下一步仍留在可见地图内',
    `拖前=${overviewBefore.visible}/${overviewBefore.total}`
      + `｜拖后=${overviewAfter.visible}/${overviewAfter.total}`
      + `｜范围=${overviewAfter.minLeft.toFixed(0)}..${overviewAfter.maxRight.toFixed(0)}`
      + ` / ${overviewAfter.svgLeft.toFixed(0)}..${overviewAfter.svgRight.toFixed(0)}`,
  );
  await evaluate(`(() => {
    window.__futureTest.setMode('tree-2d');
    window.__futureTest.rewind();
    window.scrollTo(0, 0);
  })()`);
}

async function futureColorRoleAudit() {
  await waitFor(
    `!!document.querySelector('#branchGrid .branch-node.suggested')`,
    5000,
    '金色建议节点',
  );
  const suggested = await evaluate(`(() => {
    const node = document.querySelector('#branchGrid .branch-node.suggested');
    const probe = document.createElement('span');
    probe.style.color = 'var(--gold)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const border = getComputedStyle(node).borderColor;
    const channels = (color) => (color.match(/[\\d.]+/g) || []).slice(0, 3).join(',');
    return { border, expected, hueMatches: channels(border) === channels(expected) };
  })()`);
  const fixture = '3kr4/9/9/9/9/R3R4/9/9/9/5K3 w - - 0 1';
  await evaluate(`window.__xiangqiTest.loadFen(${JSON.stringify(fixture)})`);
  await waitFor(
    `!!document.querySelector('#branchGrid .branch-node.capture')`,
    5000,
    '可吃路线节点',
  );
  const selected = await evaluate(`(() => {
    document.querySelector('#branchGrid .branch-node.capture').click();
    const node = document.querySelector('#branchGrid .branch-node[data-selected="true"]');
    const probe = document.createElement('span');
    probe.style.color = 'var(--future-blue)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return {
      border: getComputedStyle(node).borderColor,
      expected,
      effect: node.dataset.effect,
    };
  })()`);
  record(
    suggested.hueMatches
      && selected.effect.includes('capture')
      && selected.border === selected.expected,
    '统一颜色角色：未选建议保持金色，选中的吃子路线仍以蓝色选路为最高优先级',
    `建议=${suggested.border}/${suggested.expected}`
      + `｜选中吃子=${selected.border}/${selected.expected}`,
  );
  await evaluate('window.__xiangqiTest.reset()');
  await waitFor(
    `!!document.querySelector('#branchGrid .branch-node[data-reply-from]:not([data-reply-from=""])')`,
    12000,
    '颜色角色审计后恢复初始分叉',
  );
}

async function selectPawnWithoutMoving() {
  const beforeFen = await evaluate('window.__xiangqiTest.fen');
  const result = await evaluate(`(() => {
    const piece = document.querySelector('#board .piece[data-square="e3"][data-side="red"]');
    piece?.closest('.square')?.click();
    const targets = [...document.querySelectorAll('#board .square[data-target]')]
      .map((square) => square.dataset.target);
    return {
      fen: window.__xiangqiTest.fen,
      selected: window.__xiangqiTest.state.selectedSquare,
      targets,
      coach: document.getElementById('coach').innerText,
    };
  })()`);
  record(
    sameFen(result.fen, beforeFen)
      && result.selected === 'e3'
      && result.targets.length === 1
      && result.targets[0] === 'e4',
    '点红兵只显示真实合法目标，未落子前 FEN 不变',
    `selected=${result.selected}｜targets=${result.targets.join(',')}｜fen未变=${sameFen(result.fen, beforeFen)}`,
  );
  return beforeFen;
}

async function playOneRound(beforeFen) {
  const started = performance.now();
  await evaluate(`document.querySelector('#board .square[data-target="e4"]').click()`);
  await waitFor(
    `window.__xiangqiTest.pathLength >= 2 && !window.__xiangqiTest.thinking
      && window.__xiangqiTest.side === 'red'`,
    3500,
    '首个 Worker AI 应手',
  );
  const wallMs = performance.now() - started;
  const state = await evaluate(`(() => {
    const path = [...document.querySelectorAll('#pathRow .path-node')].map((node) => ({
      ply: Number(node.dataset.ply),
      fen: node.dataset.fen,
      branches: Number(node.dataset.branches),
      label: node.querySelector('b')?.textContent || '',
    }));
    return {
      fen: window.__xiangqiTest.fen,
      path,
      pathNumber: Number(document.getElementById('pathCount').textContent),
      searchFact: document.getElementById('searchFact').textContent,
      lastMove: (() => {
        const trace = document.querySelector('#lastMoveOverlay [data-last-move-trace]');
        return trace ? {
          from: trace.dataset.from,
          to: trace.dataset.to,
          role: trace.dataset.visualRole,
        } : null;
      })(),
    };
  })()`);
  const replay = auditPathNodes(beforeFen, state.path);
  const first = legalTransition(beforeFen, state.path[0]?.fen || '')[0]?.move;
  record(
    wallMs <= 3000
      && state.path.length === 2
      && state.pathNumber === state.path.length
      && first?.from === 'e3'
      && first?.to === 'e4'
      && replay.ok
      && sameFen(replay.replayFen, state.fen),
    'e3-e4 后 Worker AI ≤3 秒且 Node 端逐手合法重放',
    `wall=${wallMs.toFixed(0)}ms｜path=${state.path.length}｜${replay.ok ? '重放合法' : replay.problems.join('；')}`,
  );

  const aiMove = legalTransition(state.path[0]?.fen || '', state.path[1]?.fen || '')[0]?.move;
  record(
    !!aiMove
      && state.lastMove?.from === aiMove.from
      && state.lastMove?.to === aiMove.to
      && state.lastMove?.role === 'last-move',
    '真实 Worker 应手落盘后，上一步轨迹与 Node 独立重放同源',
    `Node=${aiMove ? `${aiMove.from}→${aiMove.to}` : '无'}`
      + `｜DOM=${state.lastMove ? `${state.lastMove.from}→${state.lastMove.to}` : '无轨迹'}`,
  );

  const pvNodes = await evaluate(`([...document.querySelectorAll('#pvRow .pv-node')].map((node) => ({
    fen: node.dataset.fen,
    branches: Number(node.dataset.branches),
    label: (node.querySelector('b')?.textContent || '').replace(/^\\d+\\.\\s*/, ''),
  })))`);
  const pvAudit = auditPvNodes(state.fen, pvNodes);
  record(
    pvAudit.ok,
    'Worker 主变逐手与 Node 棋核同源',
    pvAudit.ok ? `${pvNodes.length} 手合法 PV` : (pvAudit.problems.join('；') || '页面没有渲染 PV'),
  );
  return state.fen;
}

async function playSecondRound(roundOneFen) {
  await waitFor(
    `[...document.querySelectorAll('#branchGrid .branch-node')]
      .some((node) => node.dataset.fen && /^\\d+$/.test(node.dataset.branches))`,
    10000,
    '第二回合分叉就绪',
  );
  const chosen = await evaluate(`(() => {
    const branch = document.querySelector('#branchGrid .branch-node');
    const data = { from: Number(branch.dataset.from), to: Number(branch.dataset.to) };
    branch.click();
    document.querySelector('#board .square[data-square="' + data.to + '"]')?.click();
    return data;
  })()`);
  await waitFor(
    `window.__xiangqiTest.pathLength >= 4 && !window.__xiangqiTest.thinking
      && window.__xiangqiTest.side === 'red'`,
    3500,
    '第二个 Worker AI 应手',
  );
  const state = await evaluate(`(() => ({
    fen: window.__xiangqiTest.fen,
    pathCount: Number(document.getElementById('pathCount').textContent),
    path: [...document.querySelectorAll('#pathRow .path-node')].map((node) => ({
      ply: Number(node.dataset.ply),
      fen: node.dataset.fen,
      branches: Number(node.dataset.branches),
    })),
    rootPly: Number(document.querySelector('#pathRow .root-node').dataset.ply),
  }))()`);
  const audit = auditPathNodes(START_FEN, state.path);
  const secondUser = legalTransition(roundOneFen, state.path[2]?.fen || '')[0]?.move;
  record(
    state.rootPly === 0
      && state.path.length === 4
      && state.pathCount === 4
      && audit.ok
      && sameFen(audit.replayFen, state.fen)
      && secondUser?.fromIndex === chosen.from
      && secondUser?.toIndex === chosen.to,
    '走两回合后 path 的 ply/FEN/branches 随真实步数推进',
    audit.ok ? `ply=0→4｜当前=${state.fen}` : audit.problems.join('；'),
  );

  await waitFor(
    `[...document.querySelectorAll('#branchGrid .branch-node')]
      .every((node) => node.dataset.fen && /^\\d+$/.test(node.dataset.branches))`,
    10000,
    '第二回合全部分叉元数据',
  );
  const current = await evaluate(`(() => ({
    fen: window.__xiangqiTest.fen,
    branches: [...document.querySelectorAll('#branchGrid .branch-node')].map((node) => ({
      from: Number(node.dataset.from),
      to: Number(node.dataset.to),
      fen: node.dataset.fen,
      branches: Number(node.dataset.branches),
    })),
  }))()`);
  const branchAudit = auditBranches(current.fen, current.branches);
  record(
    branchAudit.ok,
    '推进后每个 branch data 与 Node 重放 replyCount 对账',
    branchAudit.ok ? `${current.branches.length} 条全部同源` : branchAudit.problems.slice(0, 4).join('；'),
  );
}

async function threatAndZoomAudit() {
  const fixture = '3kr4/9/9/9/9/R3R4/9/9/9/5K3 w - - 0 1';
  await evaluate(`window.__xiangqiTest.loadFen(${JSON.stringify(fixture)})`);
  await waitFor(
    `document.querySelectorAll('#board .threatened .piece').length > 0`,
    5000,
    '威胁夹具渲染',
  );
  const expected = getThreats(fixture);
  const threat = await evaluate(`(() => ({
    count: document.querySelectorAll('#board .threatened .piece').length,
    squares: [...document.querySelectorAll('#board .threatened .piece')].map((piece) => piece.dataset.square),
    coach: document.getElementById('coach').innerText,
  }))()`);
  record(
    threat.count === expected.length
      && threat.squares.includes('e4')
      && /攻击线/.test(threat.coach)
      && !/(必丢|必吃|高危|一定会被吃|下一手会吃)/.test(threat.coach),
    '威胁夹具数量同源，文案只称当前攻击线',
    `DOM=${threat.count}｜棋核=${expected.length}｜${threat.coach.replace(/\n/g, ' ')}`,
  );

  await evaluate(`document.querySelector('#board .piece[data-square="e4"]').closest('.square').click()`);
  await waitFor(
    `document.querySelectorAll('#threatOverlay [data-threat-arrow]').length > 0`,
    3000,
    '威胁攻击线渲染',
  );
  await sleep(120);
  const expectedLines = expected.flatMap((entry) =>
    entry.attackers.map((from) => `${from}-${entry.square}`)).sort();
  const visual = await evaluate(`(() => {
    const target = document.querySelector('#board .piece[data-square="e4"]').closest('.square');
    return {
      attackers: (target.dataset.attackers || '').split(',').filter(Boolean).sort(),
      defenders: (target.dataset.defenders || '').split(',').filter(Boolean).sort(),
      badge: target.querySelector('.threat-badge')?.textContent || '',
      lines: [...document.querySelectorAll('#threatOverlay [data-threat-arrow]')]
        .map((line) => {
          const style = getComputedStyle(line);
          return {
            from: line.dataset.from,
            to: line.dataset.to,
            x1: Number(line.getAttribute('x1')),
            y1: Number(line.getAttribute('y1')),
            x2: Number(line.getAttribute('x2')),
            y2: Number(line.getAttribute('y2')),
            marker: line.getAttribute('marker-end') || '',
            display: style.display,
            visibility: style.visibility,
            opacity: Number(style.opacity),
            stroke: style.stroke,
          };
        }).sort((left, right) => (left.from + left.to).localeCompare(right.from + right.to)),
      strip: document.getElementById('threatStrip')?.innerText || '',
    };
  })()`);
  const expectedTarget = expected.find((entry) => entry.square === 'e4');
  const visualLineKeys = visual.lines.map((line) => `${line.from}-${line.to}`);
  const point = (square) => ({
    x: 'abcdefghi'.indexOf(square[0]) * 10,
    y: (9 - Number(square[1])) * 10,
  });
  const lineGeometryOk = visual.lines.every((line) => {
    const source = point(line.from);
    const target = point(line.to);
    const startDistance = Math.hypot(line.x1 - source.x, line.y1 - source.y);
    const endDistance = Math.hypot(line.x2 - target.x, line.y2 - target.y);
    const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    const expectedDx = target.x - source.x;
    const expectedDy = target.y - source.y;
    const actualDx = line.x2 - line.x1;
    const actualDy = line.y2 - line.y1;
    const direction = (expectedDx * actualDx + expectedDy * actualDy)
      / ((Math.hypot(expectedDx, expectedDy) || 1) * (Math.hypot(actualDx, actualDy) || 1));
    return startDistance <= 8
      && endDistance <= 8
      && length >= 10
      && direction >= .98
      && line.marker.includes('threatArrowHead')
      && line.display !== 'none'
      && line.visibility !== 'hidden'
      && line.opacity > 0
      && line.stroke !== 'none';
  });
  record(
    JSON.stringify(visualLineKeys) === JSON.stringify(expectedLines)
      && lineGeometryOk
      && JSON.stringify(visual.attackers) === JSON.stringify(expectedTarget?.attackers.slice().sort() || [])
      && JSON.stringify(visual.defenders) === JSON.stringify(expectedTarget?.defenders.slice().sort() || [])
      && visual.badge === '危'
      && /攻击线/.test(visual.strip)
      && /e9/.test(visual.strip)
      && /e4/.test(visual.strip)
      && !/(必丢|必吃|概率|一定会被吃|下一手会吃)/.test(visual.strip),
    '点受攻棋后，真实攻击者、保护者、箭头和文字逐项同源',
    `线=${visualLineKeys.join(',')}｜几何可见=${lineGeometryOk}｜攻=${visual.attackers.join(',')}｜守=${visual.defenders.join(',')}｜徽标=${visual.badge}`,
  );

  const finiteMotion = await evaluate(`(() => {
    const arrows = [...document.querySelectorAll('#threatOverlay [data-threat-arrow]')];
    const rings = [...document.querySelectorAll('.threat-new .threat-ring')];
    const animated = [...arrows, ...rings];
    return {
      count: animated.length,
      arrowCount: arrows.length,
      ringCount: rings.length,
      names: animated.map((element) => getComputedStyle(element).animationName),
      iterations: animated.map((element) => getComputedStyle(element).animationIterationCount),
      animationObjects: animated.reduce((total, element) => total + element.getAnimations().length, 0),
    };
  })()`);
  await sleep(2600);
  const runningMotion = await evaluate(
    `[...document.querySelectorAll('.board-frame *')]
      .flatMap((element) => element.getAnimations())
      .filter((animation) => animation.playState === 'running').length`,
  );
  record(
    finiteMotion.arrowCount === expectedLines.length
      && finiteMotion.ringCount === 1
      && finiteMotion.names.includes('threat-path-enter')
      && finiteMotion.names.includes('threat-ring-pulse')
      && finiteMotion.animationObjects >= 2
      && finiteMotion.iterations.every((value) => value !== 'infinite')
      && runningMotion === 0,
    '威胁动效有限次播放并自动停为静态',
    `箭头/环=${finiteMotion.arrowCount}/${finiteMotion.ringCount}｜animation=${finiteMotion.names.join(',')}`
      + `｜对象=${finiteMotion.animationObjects}｜迭代=${finiteMotion.iterations.join(',')}｜运行中=${runningMotion}`,
  );

  await send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const reducedMotion = await evaluate(`(() => {
    const elements = [...document.querySelectorAll('#threatOverlay [data-threat-arrow], .threat-ring')];
    return {
      count: elements.length,
      names: elements.map((element) => getComputedStyle(element).animationName),
      ringVisible: elements.some((element) =>
        element.classList.contains('threat-ring') && getComputedStyle(element).display !== 'none'),
      strip: document.getElementById('threatStrip')?.innerText || '',
    };
  })()`);
  record(
    reducedMotion.count > 0
      && reducedMotion.names.every((name) => name === 'none')
      && reducedMotion.ringVisible
      && /攻击线/.test(reducedMotion.strip),
    '减少动态时关闭威胁动画但保留静态环、攻击线与文字',
    `元素=${reducedMotion.count}｜animation=${reducedMotion.names.join(',')}｜静态环=${reducedMotion.ringVisible}`,
  );
  await send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });

  const adjacentFixture = '4k4/9/9/9/4p4/4R4/9/9/9/3K5 w - - 0 1';
  const adjacentExpected = getThreats(adjacentFixture);
  await evaluate(`window.__xiangqiTest.loadFen(${JSON.stringify(adjacentFixture)})`);
  await evaluate(`document.querySelector('#board .piece[data-square="e4"]').closest('.square').click()`);
  await waitFor(
    `document.querySelectorAll('#threatOverlay [data-from="e5"][data-to="e4"]').length === 1`,
    3000,
    '相邻攻击箭头',
  );
  await sleep(120);
  const adjacentLine = await evaluate(`(() => {
    const line = document.querySelector('#threatOverlay [data-from="e5"][data-to="e4"]');
    const style = getComputedStyle(line);
    return {
      x1: Number(line.getAttribute('x1')),
      y1: Number(line.getAttribute('y1')),
      x2: Number(line.getAttribute('x2')),
      y2: Number(line.getAttribute('y2')),
      marker: line.getAttribute('marker-end') || '',
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
    };
  })()`);
  const adjacentSource = point('e5');
  const adjacentTarget = point('e4');
  const adjacentExpectedDx = adjacentTarget.x - adjacentSource.x;
  const adjacentExpectedDy = adjacentTarget.y - adjacentSource.y;
  const adjacentActualDx = adjacentLine.x2 - adjacentLine.x1;
  const adjacentActualDy = adjacentLine.y2 - adjacentLine.y1;
  const adjacentCenterDistance = Math.hypot(adjacentExpectedDx, adjacentExpectedDy);
  const adjacentLength = Math.hypot(adjacentActualDx, adjacentActualDy);
  const adjacentDirection = (adjacentExpectedDx * adjacentActualDx + adjacentExpectedDy * adjacentActualDy)
    / (adjacentCenterDistance * (adjacentLength || 1));
  record(
    adjacentExpected.length === 1
      && adjacentExpected[0].square === 'e4'
      && adjacentExpected[0].attackers.join(',') === 'e5'
      && adjacentDirection >= .98
      && adjacentLength >= adjacentCenterDistance * .15
      && adjacentLength < adjacentCenterDistance
      && adjacentLine.marker.includes('threatArrowHeadCompact')
      && adjacentLine.display !== 'none'
      && adjacentLine.visibility !== 'hidden'
      && adjacentLine.opacity > 0,
    '相邻一格的真实攻击箭头仍朝向目标且非零可见',
    `e5→e4｜长度=${adjacentLength.toFixed(2)}/${adjacentCenterDistance.toFixed(2)}`
      + `｜方向=${adjacentDirection.toFixed(2)}｜marker=${adjacentLine.marker}`,
  );

  await evaluate(`window.__xiangqiTest.reset()`);
  const initialThreats = getThreats(START_FEN);
  await waitFor(
    `document.querySelectorAll('#threatChips [data-threat-square]').length === ${initialThreats.length}`,
    3000,
    '多目标威胁条',
  );
  const switchedLines = [];
  for (const detail of initialThreats) {
    const targetIndex = (() => {
      const match = /^([a-i])([0-9])$/.exec(detail.square);
      return match ? (9 - Number(match[2])) * 9 + 'abcdefghi'.indexOf(match[1]) : -1;
    })();
    await evaluate(`document.querySelector('#threatChips [data-threat-square="${targetIndex}"]').click()`);
    await waitFor(
      `document.querySelectorAll('#threatOverlay [data-to="${detail.square}"]').length === ${detail.attackers.length}`,
      3000,
      `切换威胁 ${detail.square}`,
    );
    switchedLines.push(await evaluate(
      `[...document.querySelectorAll('#threatOverlay [data-threat-arrow]')]
        .map((line) => line.dataset.from + '-' + line.dataset.to).sort()`,
    ));
  }
  const expectedSwitchedLines = initialThreats.map((detail) =>
    detail.attackers.map((from) => `${from}-${detail.square}`).sort());
  record(
    JSON.stringify(switchedLines) === JSON.stringify(expectedSwitchedLines),
    '多枚受攻棋可逐项切换，各自只画自己的真实攻击线',
    switchedLines.map((lines) => lines.join(',')).join('｜'),
  );

  const before = await evaluate(`(() => {
    const rect = document.getElementById('treeCanvas').getBoundingClientRect();
    return { zoom: window.__xiangqiTest.zoom, width: rect.width, style: document.getElementById('treeCanvas').style.zoom };
  })()`);
  await evaluate(`document.getElementById('zoomIn').click()`);
  const after = await evaluate(`(() => {
    const rect = document.getElementById('treeCanvas').getBoundingClientRect();
    return {
      zoom: window.__xiangqiTest.zoom,
      width: rect.width,
      style: document.getElementById('treeCanvas').style.zoom,
      label: document.getElementById('zoomReset').textContent,
    };
  })()`);
  record(
    after.zoom > before.zoom
      && Number(after.style) === after.zoom
      && after.width > before.width
      && after.label !== '100%',
    '缩放按钮真实改变路径图几何',
    `${before.zoom}→${after.zoom}｜宽 ${before.width.toFixed(1)}→${after.width.toFixed(1)}`,
  );
  await evaluate(`document.getElementById('zoomReset').click()`);
}

async function lastMoveAndThreatMotionAudit() {
  const fixture = '3k5/9/9/4r4/9/4R4/9/9/9/5K3 b - - 0 1';
  const before = parseFen(fixture);
  const move = generateLegalMoves(before).find((candidate) =>
    candidate.from === 'e6' && candidate.to === 'e5');
  const expectedFen = move ? toFen(applyMove(before, move)) : '';
  const expectedThreats = move ? getThreats(parseFen(expectedFen)) : [];
  const expectedThreat = expectedThreats.find((detail) => detail.square === 'e4');

  await evaluate(`window.__xiangqiTest.loadFen(${JSON.stringify(fixture)})`);
  const hadNoPreviousMove = await evaluate(
    `!document.querySelector('#lastMoveOverlay [data-last-move-trace]')
      && !document.querySelector('#board .last-from, #board .last-to')`,
  );
  await evaluate(`window.__xiangqiTest.tryMove('e6', 'e5')`);
  await sleep(90);

  const semantics = await evaluate(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) > 0 && (rect.width > 0 || rect.height > 0);
    };
    const trace = document.querySelector('#lastMoveOverlay [data-last-move-trace]');
    const origin = document.querySelector('#lastMoveOverlay [data-last-move-origin]');
    const target = document.querySelector('#lastMoveOverlay [data-last-move-target]');
    const label = document.querySelector('#lastMoveOverlay [data-last-move-label]');
    const fromSquare = document.querySelector('#board .square.last-from');
    const toSquare = document.querySelector('#board .square.last-to');
    return {
      fen: window.__xiangqiTest.fen,
      trace: trace ? {
        from: trace.dataset.from,
        to: trace.dataset.to,
        role: trace.dataset.visualRole,
        visible: visible(trace),
      } : null,
      origin: origin ? {
        from: origin.dataset.from,
        to: origin.dataset.to,
        visible: visible(origin),
      } : null,
      target: target ? {
        from: target.dataset.from,
        to: target.dataset.to,
        visible: visible(target),
      } : null,
      label: label ? {
        from: label.dataset.from,
        to: label.dataset.to,
        text: label.textContent,
        visible: visible(label),
      } : null,
      fromClass: fromSquare?.dataset.square ?? null,
      toClass: toSquare?.dataset.square ?? null,
      sourceEmpty: !fromSquare?.querySelector('.piece'),
      targetPiece: toSquare?.querySelector('.piece')?.dataset.piece ?? null,
      fact: document.getElementById('lastMoveFact')?.textContent || '',
    };
  })()`);
  record(
    hadNoPreviousMove
      && sameFen(semantics.fen, expectedFen)
      && semantics.trace?.from === 'e6'
      && semantics.trace?.to === 'e5'
      && semantics.trace?.role === 'last-move'
      && semantics.trace?.visible
      && semantics.origin?.from === 'e6'
      && semantics.origin?.to === 'e5'
      && semantics.origin?.visible
      && semantics.target?.from === 'e6'
      && semantics.target?.to === 'e5'
      && semantics.target?.visible
      && semantics.label?.from === 'e6'
      && semantics.label?.to === 'e5'
      && semantics.label?.visible
      && /上一步/.test(semantics.label?.text || '')
      && semantics.fromClass === '31'
      && semantics.toClass === '40'
      && semantics.sourceEmpty
      && semantics.targetPiece === 'r'
      && /黑方/.test(semantics.fact)
      && /e6/.test(semantics.fact)
      && /e5/.test(semantics.fact),
    '上一步的真实起点、终点、空起点标记、落点和持久文字逐项同源',
    `FEN=${semantics.fen}｜轨迹=${semantics.trace ? `${semantics.trace.from}→${semantics.trace.to}` : '无'}`
      + `｜起/终=${semantics.origin?.visible}/${semantics.target?.visible}`
      + `｜label=${JSON.stringify(semantics.label)}｜class=${semantics.fromClass}/${semantics.toClass}`
      + `｜空/子=${semantics.sourceEmpty}/${semantics.targetPiece}｜清空=${hadNoPreviousMove}`
      + `｜文字=${semantics.fact || '无'}`,
  );

  const visualRoles = await evaluate(`(() => {
    const last = document.querySelector('#lastMoveOverlay [data-last-move-trace]');
    const threats = [...document.querySelectorAll('#threatOverlay [data-threat-arrow]')];
    const active = threats.find((line) => line.dataset.activeThreat === 'true');
    const source = document.querySelector('#threatOverlay [data-threat-source]');
    const target = document.querySelector('#threatOverlay [data-threat-target]');
    const flow = document.querySelector('#threatOverlay [data-threat-flow]');
    const lastStyle = last ? getComputedStyle(last) : null;
    const activeStyle = active ? getComputedStyle(active) : null;
    return {
      threatLines: threats.map((line) => line.dataset.from + '-' + line.dataset.to).sort(),
      active: active ? {
        from: active.dataset.from,
        to: active.dataset.to,
        role: active.dataset.visualRole,
        opacity: Number(activeStyle.opacity),
      } : null,
      source: source ? {
        square: source.dataset.threatSource,
        text: source.textContent,
      } : null,
      target: target ? {
        square: target.dataset.threatTarget,
        text: target.textContent,
      } : null,
      flow: flow ? {
        from: flow.dataset.flowFrom,
        to: flow.dataset.flowTo,
      } : null,
      lastStroke: lastStyle?.stroke || '',
      lastDash: lastStyle?.strokeDasharray || '',
      threatStroke: activeStyle?.stroke || '',
      attackerSwitches: document.querySelectorAll('#attackerChips [data-attacker-square]').length,
    };
  })()`);
  const multiFixture = '3kr4/9/9/9/9/r3R4/9/9/9/5K3 w - - 0 1';
  const multiExpected = getThreats(parseFen(multiFixture)).find((detail) => detail.square === 'e4');
  await evaluate(`window.__xiangqiTest.loadFen(${JSON.stringify(multiFixture)})`);
  await evaluate(`document.querySelector('#board .piece[data-square="e4"]').closest('.square').click()`);
  await sleep(760);
  const beforeSwitch = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('#threatOverlay [data-threat-arrow]')];
    const active = lines.find((line) => line.dataset.activeThreat === 'true');
    const context = lines.filter((line) => line.dataset.activeThreat !== 'true');
    return {
      buttons: document.querySelectorAll('#attackerChips [data-attacker-square]').length,
      activeFrom: active?.dataset.from || '',
      activeCount: lines.filter((line) => line.dataset.activeThreat === 'true').length,
      contextCount: context.length,
      activeOpacity: active ? Number(getComputedStyle(active).opacity) : 0,
      contextOpacity: context.length ? Math.max(...context.map((line) => Number(getComputedStyle(line).opacity))) : 0,
    };
  })()`);
  await evaluate(`document.querySelectorAll('#attackerChips [data-attacker-square]')[1]?.click()`);
  await sleep(760);
  const afterSwitch = await evaluate(`(() => ({
    activeFrom: document.querySelector('#threatOverlay [data-active-threat="true"]')?.dataset.from || '',
    activeCount: document.querySelectorAll('#threatOverlay [data-active-threat="true"]').length,
    allLines: [...document.querySelectorAll('#threatOverlay [data-threat-arrow]')]
      .map((line) => line.dataset.from + '-' + line.dataset.to).sort(),
    source: document.querySelector('#threatOverlay [data-threat-source]')?.dataset.threatSource || '',
    headline: document.getElementById('threatHeadline')?.textContent || '',
  }))()`);
  record(
    expectedThreats.length === 1
      && expectedThreat?.attackers.join(',') === 'e5'
      && visualRoles.threatLines.join(',') === 'e5-e4'
      && visualRoles.active?.from === 'e5'
      && visualRoles.active?.to === 'e4'
      && visualRoles.active?.role === 'threat'
      && visualRoles.active?.opacity > 0
      && visualRoles.source?.square === 'e5'
      && /攻/.test(visualRoles.source?.text || '')
      && visualRoles.target?.square === 'e4'
      && /危/.test(visualRoles.target?.text || '')
      && visualRoles.flow?.from === 'e5'
      && visualRoles.flow?.to === 'e4'
      && visualRoles.lastStroke
      && visualRoles.threatStroke
      && visualRoles.lastStroke !== visualRoles.threatStroke
      && visualRoles.attackerSwitches === expectedThreat.attackers.length
      && multiExpected?.attackers.join(',') === 'a4,e9'
      && beforeSwitch.buttons === multiExpected.attackers.length
      && beforeSwitch.activeFrom === 'a4'
      && beforeSwitch.activeCount === 1
      && beforeSwitch.contextCount === 1
      && beforeSwitch.activeOpacity >= beforeSwitch.contextOpacity * 3
      && afterSwitch.activeFrom === 'e9'
      && afterSwitch.activeCount === 1
      && afterSwitch.allLines.join(',') === 'a4-e4,e9-e4'
      && afterSwitch.source === 'e9'
      && afterSwitch.headline.includes('2/2'),
    '金色上一步与朱红攻击流同屏仍可辨，方向由“攻→危”和流光明确表达',
    `上一步=${visualRoles.lastStroke}/${visualRoles.lastDash}｜攻击=${visualRoles.threatStroke}`
      + `｜攻=${visualRoles.source?.square || '无'}｜危=${visualRoles.target?.square || '无'}`
      + `｜单攻切换=${visualRoles.attackerSwitches}`
      + `｜双攻=${beforeSwitch.activeFrom}(${beforeSwitch.activeOpacity})`
      + `/${beforeSwitch.contextOpacity}→${afterSwitch.activeFrom}`,
  );

  await evaluate(`window.__xiangqiTest.loadFen(${JSON.stringify(fixture)})`);
  await evaluate(`window.__xiangqiTest.tryMove('e6', 'e5')`);
  await sleep(90);
  const moving = await evaluate(`(() => {
    const elements = [...document.querySelectorAll('[data-motion-role]')];
    return {
      roles: elements.map((element) => element.dataset.motionRole),
      names: elements.map((element) => getComputedStyle(element).animationName),
      iterations: elements.map((element) => getComputedStyle(element).animationIterationCount),
      objects: elements.reduce((total, element) => total + element.getAnimations().length, 0),
    };
  })()`);
  await sleep(2500);
  const settled = await evaluate(`(() => ({
    running: [...document.querySelectorAll('.board-frame *')]
      .flatMap((element) => element.getAnimations())
      .filter((animation) => animation.playState === 'running').length,
    trace: !!document.querySelector('#lastMoveOverlay [data-last-move-trace]'),
    origin: !!document.querySelector('#lastMoveOverlay [data-last-move-origin]'),
    target: !!document.querySelector('#lastMoveOverlay [data-last-move-target]'),
    threat: !!document.querySelector('#threatOverlay [data-threat-arrow]'),
    flow: !!document.querySelector('#threatOverlay [data-threat-flow]'),
  }))()`);

  await send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await evaluate(`window.__xiangqiTest.loadFen(${JSON.stringify(fixture)})`);
  await evaluate(`window.__xiangqiTest.tryMove('e6', 'e5')`);
  await sleep(60);
  const reduced = await evaluate(`(() => {
    const elements = [...document.querySelectorAll('[data-motion-role]')];
    return {
      count: elements.length,
      names: elements.map((element) => getComputedStyle(element).animationName),
      trace: !!document.querySelector('#lastMoveOverlay [data-last-move-trace]'),
      origin: !!document.querySelector('#lastMoveOverlay [data-last-move-origin]'),
      target: !!document.querySelector('#lastMoveOverlay [data-last-move-target]'),
      source: document.querySelector('#threatOverlay [data-threat-source]')?.textContent || '',
      threatTarget: document.querySelector('#threatOverlay [data-threat-target]')?.textContent || '',
      fact: document.getElementById('lastMoveFact')?.textContent || '',
    };
  })()`);
  await send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await sleep(120);
  const lateMotion = await evaluate(`(() => {
    const elements = [...document.querySelectorAll('[data-motion-role]')];
    return {
      names: elements.map((element) => getComputedStyle(element).animationName),
      running: [...document.querySelectorAll('.board-frame *')]
        .flatMap((element) => element.getAnimations())
        .filter((animation) => animation.playState === 'running').length,
    };
  })()`);
  record(
    ['last-trace', 'piece-arrive', 'last-impact', 'threat-flow', 'threat-impact']
      .every((role) => moving.roles.includes(role))
      && moving.names.every((name) => name && name !== 'none')
      && moving.iterations.every((count) => count !== 'infinite')
      && moving.objects >= 5
      && settled.running === 0
      && settled.trace
      && settled.origin
      && settled.target
      && settled.threat
      && settled.flow
      && reduced.count >= 5
      && reduced.names.every((name) => name === 'none')
      && reduced.trace
      && reduced.origin
      && reduced.target
      && /攻/.test(reduced.source)
      && /危/.test(reduced.threatTarget)
      && /e6/.test(reduced.fact)
      && /e5/.test(reduced.fact)
      && lateMotion.names.every((name) => name === 'none')
      && lateMotion.running === 0,
    '落子与攻击动效均有限次停止；减少动态及随后恢复时不补播旧动画',
    `角色=${moving.roles.join(',')}｜动画=${moving.names.join(',')}｜对象=${moving.objects}`
      + `｜2.5s运行=${settled.running}｜reduce=${reduced.count}/${reduced.names.join(',')}`
      + `｜恢复后=${lateMotion.running}/${lateMotion.names.join(',')}`,
  );

  const reverse = await evaluate(`(() => {
    const read = () => {
      const last = document.querySelector('#lastMoveOverlay [data-last-move-trace]');
      const threat = document.querySelector('#threatOverlay [data-active-threat="true"]');
      return {
        lastFrom: last?.dataset.from || '',
        lastTo: last?.dataset.to || '',
        threatFrom: threat?.dataset.from || '',
        threatTo: threat?.dataset.to || '',
      };
    };
    const last = document.querySelector('#lastMoveOverlay [data-last-move-trace]');
    const threat = document.querySelector('#threatOverlay [data-active-threat="true"]');
    const baseline = read();
    if (last) last.dataset.from = 'a0';
    const badLast = read();
    if (last) last.dataset.from = baseline.lastFrom;
    if (threat) threat.dataset.to = 'e5';
    const badThreat = read();
    if (threat) threat.dataset.to = baseline.threatTo;
    return { baseline, badLast, badThreat };
  })()`);
  const matchesTruth = (snapshot) =>
    snapshot.lastFrom === 'e6'
    && snapshot.lastTo === 'e5'
    && snapshot.threatFrom === 'e5'
    && snapshot.threatTo === 'e4';
  record(
    matchesTruth(reverse.baseline)
      && !matchesTruth(reverse.badLast)
      && !matchesTruth(reverse.badThreat),
    '反向污染任一轨迹坐标都会被同一条 Node 真值断言抓住',
    `基线=${matchesTruth(reverse.baseline)}｜坏上一步=${matchesTruth(reverse.badLast)}`
      + `｜坏攻击线=${matchesTruth(reverse.badThreat)}`,
  );
}

async function boardReadabilityAudit() {
  await setViewport(390, 844);
  await evaluate(`window.__xiangqiTest.reset()`);
  await sleep(120);
  const portrait = await evaluate(`(() => {
    const frame = document.querySelector('.board-frame').getBoundingClientRect();
    const pieces = [...document.querySelectorAll('#board .piece')].map((piece) => {
      const rect = piece.getBoundingClientRect();
      return {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, fontSize: parseFloat(getComputedStyle(piece).fontSize),
      };
    });
    const decorations = [...document.querySelectorAll('#board .threat-ring, #board .threat-badge')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          visible: getComputedStyle(element).display !== 'none'
            && getComputedStyle(element).visibility !== 'hidden',
        };
      });
    return {
      frame: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom, width: frame.width },
      pieces,
      decorations,
    };
  })()`);
  const portraitInside = portrait.pieces.every((piece) =>
    piece.left >= portrait.frame.left - 1
      && piece.top >= portrait.frame.top - 1
      && piece.right <= portrait.frame.right + 1
      && piece.bottom <= portrait.frame.bottom + 1);
  const portraitReadable = portrait.pieces.every((piece) =>
    piece.width >= portrait.frame.width / 11
      && piece.fontSize >= piece.width * .5
      && piece.fontSize <= piece.width * .8);
  const decorationsInside = portrait.decorations.length >= 4
    && portrait.decorations.every((item) =>
      item.visible
        && item.left >= portrait.frame.left - 1
        && item.top >= portrait.frame.top - 1
        && item.right <= portrait.frame.right + 1
        && item.bottom <= portrait.frame.bottom + 1);
  record(
    portrait.pieces.length === 32 && portraitInside && portraitReadable && decorationsInside,
    '390px 手机棋子、危险环与徽标不裁切，字盘比例可读',
    `棋盘=${portrait.frame.width.toFixed(0)}｜最小棋子=${Math.min(...portrait.pieces.map((piece) => piece.width)).toFixed(1)}`
      + `｜字盘比=${Math.min(...portrait.pieces.map((piece) => piece.fontSize / piece.width)).toFixed(2)}`
      + `..${Math.max(...portrait.pieces.map((piece) => piece.fontSize / piece.width)).toFixed(2)}`
      + `｜威胁装饰=${portrait.decorations.length}/${decorationsInside}`,
  );

  await setViewport(667, 375);
  await sleep(120);
  const landscape = await evaluate(`(() => {
    const frame = document.querySelector('.board-frame').getBoundingClientRect();
    return {
      width: frame.width,
      height: frame.height,
      visibleHeight: Math.max(0, Math.min(innerHeight, frame.bottom) - Math.max(0, frame.top)),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  })()`);
  record(
    landscape.width >= 270
      && landscape.width <= 300
      && landscape.visibleHeight >= landscape.height - 1
      && landscape.scrollWidth <= landscape.clientWidth + 1,
    '667×375 横屏棋盘完整进入首屏且可操作',
    `${landscape.width.toFixed(0)}×${landscape.height.toFixed(0)}｜首屏高=${landscape.visibleHeight.toFixed(0)}`,
  );
}

async function workerIsolationAudit() {
  await evaluate(`window.__xiangqiTest.reset()`);
  await waitFor(`window.__xiangqiTest.pathLength === 0 && window.__xiangqiTest.legalMoveCount === 44`, 5000);
  const initialFen = await evaluate('window.__xiangqiTest.fen');
  await evaluate(`(() => {
    document.querySelector('#board .piece[data-square="e3"]').closest('.square').click();
    document.querySelector('#board .square[data-target="e4"]').click();
    document.getElementById('reset').click();
  })()`);
  await sleep(3200);
  const resetState = await evaluate(`(() => ({
    fen: window.__xiangqiTest.fen,
    path: document.querySelectorAll('#pathRow .path-node').length,
    pieces: document.querySelectorAll('#board .piece').length,
    thinking: window.__xiangqiTest.thinking,
  }))()`);
  record(
    sameFen(resetState.fen, initialFen)
      && resetState.path === 0
      && resetState.pieces === 32
      && !resetState.thinking,
    'reset 隔离旧 Worker 回包，局面不会被过期结果改写',
    `path=${resetState.path}｜pieces=${resetState.pieces}｜thinking=${resetState.thinking}`,
  );

  const fallbackStart = performance.now();
  const beforeFallback = await evaluate(`(() => {
    const fen = window.__xiangqiTest.fen;
    document.querySelector('#board .piece[data-square="e3"]').closest('.square').click();
    document.querySelector('#board .square[data-target="e4"]').click();
    window.__xiangqiTest.killWorker();
    return fen;
  })()`);
  await waitFor(
    `window.__xiangqiTest.pathLength === 2 && !window.__xiangqiTest.thinking`,
    3000,
    'killWorker fallback',
  );
  const fallback = await evaluate(`(() => ({
    fen: window.__xiangqiTest.fen,
    path: [...document.querySelectorAll('#pathRow .path-node')].map((node) => ({
      ply: Number(node.dataset.ply),
      fen: node.dataset.fen,
      branches: Number(node.dataset.branches),
    })),
    fact: document.getElementById('searchFact').textContent,
  }))()`);
  const audit = auditPathNodes(beforeFallback, fallback.path);
  record(
    performance.now() - fallbackStart <= 3000
      && fallback.path.length === 2
      && audit.ok
      && sameFen(audit.replayFen, fallback.fen)
      && /Worker|终止|失败|超时/.test(fallback.fact),
    'killWorker 会走合法保底应手且不冒充搜索结果',
    `${(performance.now() - fallbackStart).toFixed(0)}ms｜${fallback.fact}｜${audit.ok ? '重放合法' : audit.problems.join('；')}`,
  );
}

async function viewportAudit(width, height) {
  await setViewport(width, height);
  await sleep(120);
  const layout = await evaluate(`(() => {
    const root = document.documentElement;
    const board = document.querySelector('.board-frame').getBoundingClientRect();
    const tree = document.getElementById('treeViewport');
    const treeStyle = getComputedStyle(tree);
    const controls = [...document.querySelectorAll('a, button:not(.square)')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.id || element.getAttribute('aria-label') || element.textContent.trim().slice(0, 18),
          width: rect.width,
          height: rect.height,
        };
      });
    const boardVisibleWidth = Math.max(0, Math.min(innerWidth, board.right) - Math.max(0, board.left));
    const boardVisibleHeight = Math.max(0, Math.min(innerHeight, board.bottom) - Math.max(0, board.top));
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      board: { width: board.width, height: board.height, visibleWidth: boardVisibleWidth, visibleHeight: boardVisibleHeight },
      controls,
      tooSmall: controls.filter((item) => item.width < 44 || item.height < 44),
      tree: {
        overflowX: treeStyle.overflowX,
        overflowY: treeStyle.overflowY,
        clientWidth: tree.clientWidth,
        clientHeight: tree.clientHeight,
        scrollWidth: tree.scrollWidth,
        scrollHeight: tree.scrollHeight,
      },
    };
  })()`);
  record(
    layout.scrollWidth <= layout.clientWidth + 1,
    `${width}×${height} 根页面无横向溢出`,
    `scrollWidth=${layout.scrollWidth}｜clientWidth=${layout.clientWidth}`,
  );
  record(
    layout.controls.length > 0 && layout.tooSmall.length === 0,
    `${width}×${height} 非棋格控件触控尺寸均 ≥44px`,
    layout.tooSmall.length
      ? layout.tooSmall.slice(0, 5).map((item) => `${item.name}=${item.width.toFixed(0)}×${item.height.toFixed(0)}`).join('｜')
      : `${layout.controls.length} 个控件`,
  );
  record(
    layout.board.width >= (width > height && width <= 760 ? 270 : Math.min(300, width - 20))
      && layout.board.visibleWidth >= (width > height && width <= 760 ? 265 : Math.min(280, width - 30))
      && layout.board.visibleHeight >= Math.min(220, height - 90),
    `${width}×${height} 棋盘首屏可见`,
    `${layout.board.width.toFixed(0)}×${layout.board.height.toFixed(0)}，首屏可见 ${layout.board.visibleWidth.toFixed(0)}×${layout.board.visibleHeight.toFixed(0)}`,
  );
  record(
    layout.tree.overflowX === 'auto'
      && layout.tree.overflowY === 'auto'
      && (layout.tree.scrollWidth > layout.tree.clientWidth || layout.tree.scrollHeight > layout.tree.clientHeight),
    `${width}×${height} 路径树保留真实滚动区域`,
    `${layout.tree.clientWidth}×${layout.tree.clientHeight} → ${layout.tree.scrollWidth}×${layout.tree.scrollHeight}`,
  );
}

async function rafAndErrorAudit() {
  await setViewport(1440, 900);
  await sleep(250);
  const first = await evaluate('window.__xiangqiRafAudit.snapshot()');
  await sleep(700);
  const second = await evaluate('window.__xiangqiRafAudit.snapshot()');
  record(
    second.requested === first.requested && second.callbacks === first.callbacks,
    '注入式 rAF 审计确认页面没有持续动画循环',
    `requested ${first.requested}→${second.requested}｜callbacks ${first.callbacks}→${second.callbacks}`,
  );
  record(
    pageErrors.length === 0,
    '全程 console.error 与 page error 为 0',
    pageErrors.length ? pageErrors.slice(0, 4).join('｜') : '0',
  );
}

async function cleanup() {
  try {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
  } catch {}
  try {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  } catch {}
  try {
    if (chrome && !chrome.killed) chrome.kill('SIGTERM');
  } catch {}
  await sleep(100);
  try {
    if (chromeProfile && chromeProfile.startsWith(os.tmpdir() + path.sep)) {
      fs.rmSync(chromeProfile, { recursive: true, force: true });
    }
  } catch {}
}

async function main() {
  const localRoot = requestedUrl ? null : await serveLocal();
  const rootUrl = siteRoot(requestedUrl || localRoot);
  console.log(`中国象棋真机验收：${rootUrl}`);
  await launchChrome();
  await attach();

  await portalAudit(rootUrl);
  const initialFen = await initialAudit();
  await futureRaceAndOverviewAudit();
  await futureContractAudit();
  await futureColorRoleAudit();
  const beforeMove = await selectPawnWithoutMoving();
  const roundOneFen = await playOneRound(beforeMove);
  await playSecondRound(roundOneFen);
  await threatAndZoomAudit();
  await lastMoveAndThreatMotionAudit();
  await boardReadabilityAudit();
  await workerIsolationAudit();
  for (const [width, height] of [[1440, 900], [390, 844], [667, 375]]) {
    await viewportAudit(width, height);
  }
  await rafAndErrorAudit();

  // initialFen 是从页面实际读取的值；这里再明确防止初始节点换局面但仍有 44 个 DOM。
  record(sameFen(initialFen, START_FEN), '页面初始 FEN 与 Node 棋核起始局面一致');
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
  record(false, '验收脚本完整运行', error?.stack || String(error));
} finally {
  await cleanup();
}

if (results.length !== EXPECTED_RESULTS) {
  record(false, '验收项总数没有静默缩水或意外膨胀', `运行到 ${results.length} 项，应为固定 ${EXPECTED_RESULTS} 项`);
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '未通过' : '全绿'}：${results.length - failed.length}/${results.length} 项通过，零跳过。`);
if (fatal || failed.length) process.exitCode = 1;
