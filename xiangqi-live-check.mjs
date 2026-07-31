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
const EXPECTED_RESULTS = 31;

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
    layout.board.width >= Math.min(300, width - 20)
      && layout.board.visibleWidth >= Math.min(280, width - 30)
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
  const beforeMove = await selectPawnWithoutMoving();
  const roundOneFen = await playOneRound(beforeMove);
  await playSecondRound(roundOneFen);
  await threatAndZoomAudit();
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
