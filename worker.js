// worker.js —— 真 Worker。两件活：AI 应手（search）和整张路径网（cloud）。
// 页面开两个实例，一个专管 AI，一个专管路径网，互不排队。
//
// 这里没有任何「主线程算完假装分批送」的把戏：第 1～4 层全在这个 Worker
// 里展开。主线程只把真实结果做成 Three.js geometry，不再被棋局枚举堵住。

import { Chess, expand, search } from './engine.js';

self.onmessage = (ev) => {
  const msg = ev.data;

  if (msg.type === 'ping') {
    // 预热：让 chess.js 的 CDN 模块和 JIT 在玩家落子之前就位
    new Chess().moves();
    self.postMessage({ type: 'pong' });
    return;
  }

  if (msg.type === 'search') {
    try {
      const r = search(msg.fen, { timeBudgetMs: msg.timeBudgetMs, maxDepth: msg.maxDepth });
      self.postMessage({ type: 'searchDone', id: msg.id, result: r });
    } catch (e) {
      self.postMessage({ type: 'searchError', id: msg.id, message: String(e && e.message || e) });
    }
    return;
  }

  if (msg.type === 'cloud') {
    // 常规从根局面长第 1 层；路径网从屏外回到可见时，也可拿第 3 层局面续长第 4 层。
    let parentFens = msg.parentFens || [msg.fen];
    const startDepth = msg.startDepth || 1;
    const targetDepth = msg.targetDepth || msg.depth || 4;
    const batch = msg.batchParents || 400;
    const t0 = performance.now();
    try {
      for (let depth = startDepth; depth <= targetDepth; depth++) {
        if (depth < 4) {
          const { parents, scores, fens } = expand(parentFens, { keepFens: true });
          self.postMessage(
            {
              type: 'cloudLayer',
              id: msg.id,
              depth,
              parents,
              scores,
              fens,
              ms: performance.now() - t0,
            },
            [parents.buffer, scores.buffer],
          );
          parentFens = fens;
          continue;
        }

        // 最深层按父节点边界切批：同一个父亲的孩子绝不跨批，
        // 主线程才好算兄弟排布，也能在批与批之间继续响应输入。
        for (let start = 0; start < parentFens.length; start += batch) {
          const end = Math.min(start + batch, parentFens.length);
          const { parents, scores } = expand(parentFens, { keepFens: false, from: start, to: end });
          self.postMessage(
            {
              type: 'cloudBatch',
              id: msg.id,
              depth,
              parents,
              scores,
              done: end >= parentFens.length,
              ms: performance.now() - t0,
            },
            [parents.buffer, scores.buffer],
          );
        }
      }
      self.postMessage({
        type: 'cloudDone',
        id: msg.id,
        depth: targetDepth,
        ms: performance.now() - t0,
      });
    } catch (e) {
      self.postMessage({
        type: 'cloudError',
        id: msg.id,
        message: String(e && e.message || e),
        ms: performance.now() - t0,
      });
    }
    return;
  }
};
