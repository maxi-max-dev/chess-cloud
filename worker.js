// worker.js —— 真 Worker。两件活：AI 应手（search）和第 4 层星云（cloud）。
// 页面开两个实例，一个专管 AI，一个专管星云，互不排队。
//
// 这里没有任何「主线程算完假装分批送」的把戏：算就在这个 Worker 里算，
// 主线程收到 cloudBatch 之前根本没有第 4 层的数据。

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
    // 主线程把上一层（第 3 层）的局面整批发过来，这里按父节点分批往下长第 4 层。
    const parentFens = msg.parentFens;
    const batch = msg.batchParents || 400;
    const t0 = performance.now();
    try {
      for (let start = 0; start < parentFens.length; start += batch) {
        const end = Math.min(start + batch, parentFens.length);
        // 按父节点边界切批：同一个父亲的孩子绝不跨批，主线程才好算兄弟排布
        const { parents, scores } = expand(parentFens, { keepFens: false, from: start, to: end });
        self.postMessage(
          {
            type: 'cloudBatch',
            id: msg.id,
            depth: msg.depth,
            parents,
            scores,
            done: end >= parentFens.length,
            ms: performance.now() - t0,
          },
          [parents.buffer, scores.buffer],
        );
      }
      self.postMessage({ type: 'cloudDone', id: msg.id, depth: msg.depth, ms: performance.now() - t0 });
    } catch (e) {
      self.postMessage({ type: 'cloudError', id: msg.id, message: String(e && e.message || e) });
    }
    return;
  }
};
