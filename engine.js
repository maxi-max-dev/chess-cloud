// engine.js —— 唯一的评估函数 + 搜索 + 树展开。
//
// 关键约定：整个项目只有这一份 evaluate()。
// 星云的星色（主线程调）和 AI 的 minimax 叶子打分（Worker 调）读的是同一个函数、同一份表格。
// 谁想再写第二份评估，就是把「星色」和「AI 眼里的好坏」割开，那就不是同一个世界了。

import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';
export { Chess };

export const MATE = 100000;

// 子力价值（百分兵）。王不计价：双方永远各一个王，计了只是噪音。
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// 位置表：按 FEN 的书写顺序排，下标 0 = a8，下标 63 = h1，一律站在白方视角。
// 黑子取镜像下标（sq ^ 56：把行号翻过来）。
const PAWN = [
    0,  0,  0,  0,  0,  0,  0,  0,
   50, 50, 50, 50, 50, 50, 50, 50,
   10, 10, 20, 30, 30, 20, 10, 10,
    5,  5, 10, 25, 25, 10,  5,  5,
    0,  0,  0, 20, 20,  0,  0,  0,
    5, -5,-10,  0,  0,-10, -5,  5,
    5, 10, 10,-20,-20, 10, 10,  5,
    0,  0,  0,  0,  0,  0,  0,  0,
];
const KNIGHT = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];
const BISHOP = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];
const ROOK = [
    0,  0,  0,  0,  0,  0,  0,  0,
    5, 10, 10, 10, 10, 10, 10,  5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
    0,  0,  0,  5,  5,  0,  0,  0,
];
const QUEEN = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];
const KING = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];
const PST = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

// 字符码 → {价值表, 位置表}，省掉每次 String.fromCharCode
const LOOKUP = new Array(128).fill(null);
for (const t of ['p', 'n', 'b', 'r', 'q', 'k']) {
  const entry = { base: VALUE[t], pst: PST[t] };
  LOOKUP[t.charCodeAt(0)] = entry;                        // 小写 = 黑
  LOOKUP[t.toUpperCase().charCodeAt(0)] = entry;          // 大写 = 白
}

/**
 * 唯一的评估函数。输入 FEN，输出百分兵分数：正数 = 白优，负数 = 黑优。
 * 只读 FEN 的棋子摆放段（第一个空格之前），子力 + 位置表，纯静态。
 */
export function evaluate(fen) {
  let score = 0;
  let sq = 0;
  for (let i = 0; i < fen.length; i++) {
    const c = fen.charCodeAt(i);
    if (c === 32) break;              // 空格：摆放段结束
    if (c === 47) continue;           // '/' 换行
    if (c >= 49 && c <= 56) { sq += c - 48; continue; }   // '1'..'8' = 连续空格
    const e = LOOKUP[c];
    if (e === null || e === undefined) continue;
    const isWhite = c < 97;           // 大写字母码 < 'a'
    const v = e.base + e.pst[isWhite ? sq : (sq ^ 56)];
    score += isWhite ? v : -v;
    sq++;
  }
  return score;
}

/**
 * 给云里的一颗星打分。走法对象的 san 以 '#' 结尾就是将死，直接给绝对分；
 * 其余一律走上面那个 evaluate()。返回值同样是「正 = 白优」。
 */
export function scoreChild(move) {
  if (move.san.charCodeAt(move.san.length - 1) === 35) {   // '#'
    return move.color === 'w' ? MATE : -MATE;
  }
  return evaluate(move.after);
}

/**
 * 从一层局面展开出下一层。
 * chess.js 的 verbose 走法对象自带 after（子局面 FEN）和 san，所以一次走法生成
 * 就能同时拿到子局面和分数，不用 make/undo（实测 159ms vs 349ms，三层）。
 * 顺序 = chess.js 的走法顺序，主线程和 Worker 都调这个函数，索引严格对齐。
 *
 * @param parentFens 上一层的局面数组
 * @param opts.keepFens 是否保留子局面 FEN（最后一层不需要就关掉，省内存）
 * @param opts.from/opts.to 只展开 parentFens 的这一段（分批用），parents 里存的是绝对下标
 */
export function expand(parentFens, opts = {}) {
  const { keepFens = true, from = 0, to = parentFens.length } = opts;
  const parents = [];
  const scores = [];
  const fens = keepFens ? [] : null;
  for (let i = from; i < to; i++) {
    const moves = new Chess(parentFens[i]).moves({ verbose: true });
    for (let j = 0; j < moves.length; j++) {
      const m = moves[j];
      parents.push(i);
      scores.push(scoreChild(m));
      if (fens) fens.push(m.after);
    }
  }
  return {
    parents: Uint32Array.from(parents),
    scores: Float32Array.from(scores),
    fens,
  };
}

// ---------------------------------------------------------------- 搜索（AI）

const ORDER_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const TIMEOUT = Symbol('timeout');

function orderMoves(moves) {
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let s = 0;
    if (m.captured) s += 100 + ORDER_VALUE[m.captured] * 10 - ORDER_VALUE[m.piece];
    if (m.promotion) s += 90;
    const last = m.san.charCodeAt(m.san.length - 1);
    if (last === 35) s += 5000;        // '#' 将死
    else if (last === 43) s += 10;     // '+' 将军
    m.__ord = s;
  }
  moves.sort((a, b) => b.__ord - a.__ord);
}

// 负极大值搜索 + alpha-beta。返回值站在 game.turn() 这一方的视角（正 = 我好）。
function negamax(game, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 1023) === 0 && performance.now() > ctx.deadline) throw TIMEOUT;

  const moves = game.moves({ verbose: true });
  const white = game.turn() === 'w';
  if (moves.length === 0) {
    // 无路可走：被将着就是被将死，否则困毙（和棋）
    return game.isCheck() ? -(MATE - ply) : 0;
  }
  if (depth <= 0) {
    const s = evaluate(game.fen());
    return white ? s : -s;
  }

  orderMoves(moves);
  let best = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let v;
    if (depth === 1) {
      // 叶子层：走法自带 after，直接评估，省掉一次 make/undo + fen()
      if (m.san.charCodeAt(m.san.length - 1) === 35) {
        v = MATE - (ply + 1);
      } else {
        const s = evaluate(m.after);
        v = white ? s : -s;
      }
    } else {
      game.move({ from: m.from, to: m.to, promotion: m.promotion });
      v = -negamax(game, depth - 1, -beta, -alpha, ply + 1, ctx);
      game.undo();
    }
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;          // 剪枝
  }
  return best;
}

/**
 * 迭代加深搜索。时间到就返回上一层已经搜完的最好走法，所以应手时间有硬上限。
 * @returns {{move, score, depth, ms, nodes}} 或 null（无合法走法）
 */
export function search(fen, opts = {}) {
  const { maxDepth = 6, timeBudgetMs = 1600 } = opts;
  const t0 = performance.now();
  const game = new Chess(fen);
  const rootMoves = game.moves({ verbose: true });
  if (rootMoves.length === 0) return null;

  orderMoves(rootMoves);
  const ctx = { nodes: 0, deadline: t0 + timeBudgetMs };
  let best = rootMoves[0];
  let bestScore = 0;
  let reached = 0;

  for (let d = 1; d <= maxDepth; d++) {
    // 上一轮的最佳走法先搜，alpha-beta 剪得更狠
    const ordered = [best, ...rootMoves.filter((m) => m !== best)];
    let alpha = -Infinity;
    let localBest = null;
    try {
      for (const m of ordered) {
        game.move({ from: m.from, to: m.to, promotion: m.promotion });
        const v = -negamax(game, d - 1, -Infinity, -alpha, 1, ctx);
        game.undo();
        if (localBest === null || v > alpha) { alpha = v; localBest = m; }
      }
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;                            // 时间到，用上一层的结果
    }
    best = localBest;
    bestScore = alpha;
    reached = d;
    if (Math.abs(bestScore) > MATE - 100) break;   // 算到将死了，不用再深
    if (performance.now() > ctx.deadline) break;
  }

  return {
    move: { from: best.from, to: best.to, promotion: best.promotion },
    san: best.san,
    score: bestScore,
    depth: reached,
    nodes: ctx.nodes,
    ms: performance.now() - t0,
  };
}
