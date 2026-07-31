// engine.js —— 唯一的评估函数 + 搜索 + 树展开。
//
// 关键约定：整个项目只有这一份 evaluate()。
// 路径网的线色（主线程调）和 AI 的 minimax 叶子打分（Worker 调）读的是同一个函数、同一份表格。
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
 * 给路径网的一条子路径打分。走法对象的 san 以 '#' 结尾就是将死，直接给绝对分；
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

/**
 * 把一个局面的所有走法，按「对当前行棋方的好坏」从好到坏排出来。
 *
 * depth=1 就是走完之后的静态评估；
 * depth=2 会再往前看一步：「我走这步，对手挑他最好的回应之后，局面值多少」。
 * 这一步很关键——只看一步的话，送后和吃兵长得一样好，排出来的「最可能」是假的。
 *
 * 打分从头到尾只用 evaluate() 那一份，没有第二套标准。
 */
export function rankMoves(fen, opts = {}) {
  const { depth = 2 } = opts;
  const white = fen.split(' ')[1] === 'w';
  const moves = new Chess(fen).moves({ verbose: true });
  const out = moves.map((m) => {
    let score = scoreChild(m);
    if (depth >= 2 && Math.abs(score) < MATE) {
      const replies = new Chess(m.after).moves({ verbose: true });
      if (replies.length === 0) {
        // 对手无路可走：将军着就是将死，否则困毙
        score = new Chess(m.after).isCheck() ? (white ? MATE : -MATE) : 0;
      } else {
        // 对手当然挑对他最好的：我是白，他就往小了挑；我是黑，他就往大了挑
        let best = scoreChild(replies[0]);
        for (let i = 1; i < replies.length; i++) {
          const s = scoreChild(replies[i]);
          if (white ? s < best : s > best) best = s;
        }
        score = best;
      }
    }
    return {
      san: m.san,
      from: m.from,
      to: m.to,
      promotion: m.promotion,
      after: m.after,
      score,
      piece: m.piece,
      captured: m.captured || '',
      flags: m.flags,
    };
  });
  out.sort((a, b) => (white ? b.score - a.score : a.score - b.score));
  return out;
}

/**
 * verbose move 的真实被吃格。普通吃子在落点；吃过路兵落点是空格，
 * 真正消失的兵仍在 reply.to 的同文件、reply.from 的同行。
 */
export function captureSquare(move) {
  if (!move?.captured || !move.to || !move.from) return '';
  return String(move.flags || '').includes('e')
    ? `${move.to[0]}${move.from[1]}`
    : move.to;
}

/**
 * 当前行棋方有哪些棋处在对方的几何攻击线上。
 *
 * 这是攻击事实，不是“对手现在有一手合法吃子”：对手此刻并不行棋，而且
 * chess.js attackers() 会保留被钉住棋子的攻击关系。因此 certainty 固定为
 * geometric，交给界面明确写成“攻击线”，不能冒充必丢判断。
 */
export function currentAttacks(fen) {
  const position = new Chess(fen);
  const side = position.turn();
  const enemy = side === 'w' ? 'b' : 'w';
  const out = [];
  for (const row of position.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== side) continue;
      const attackers = position.attackers(piece.square, enemy);
      if (attackers.length === 0) continue;
      out.push({
        square: piece.square,
        piece: piece.type,
        side,
        attackers: [...attackers].sort(),
        defenders: [...position.attackers(piece.square, side)].sort(),
        certainty: 'geometric',
      });
    }
  }
  return out.sort((a, b) =>
    Number(a.defenders.length > 0) - Number(b.defenders.length > 0)
    || VALUE[b.piece] - VALUE[a.piece]
    || a.square.localeCompare(b.square));
}

/**
 * 候选落子后的“一步直接吃子”事实层。
 *
 * afterFen 中恰好轮到对手，因此 captures 全都来自真正的合法着；每次吃子后
 * 再生成一次我方合法着，只判断是否能立刻回吃。它不是完整 SEE，更不证明一枚
 * 棋“必丢”，但能可靠地区分悬子、可交换和虽能回吃仍亏子的交换。
 */
export function analyzeCandidateThreat(afterFen, movedSquare, rankedReplies = null) {
  const position = new Chess(afterFen);
  const replies = rankedReplies || rankMoves(afterFen, { depth: 2 });
  const moved = position.get(movedSquare);
  const captures = [];

  for (let replyRank = 0; replyRank < replies.length; replyRank++) {
    const reply = replies[replyRank];
    if (!reply.captured) continue;
    const targetSquare = captureSquare(reply);
    const victimPiece = position.get(targetSquare);
    const replyPosition = new Chess(reply.after);
    const attackerPiece = replyPosition.get(reply.to);
    const recaptures = replyPosition.moves({ verbose: true })
      .filter((move) => move.captured && captureSquare(move) === reply.to)
      .map((move) => ({
        san: move.san,
        from: move.from,
        to: move.to,
        promotion: move.promotion || '',
      }));
    const victimType = victimPiece?.type || reply.captured;
    const attackerType = attackerPiece?.type || reply.promotion || reply.piece;
    const victimValue = VALUE[victimType] ?? 0;
    const attackerValue = VALUE[attackerType] ?? 0;
    const recapturable = recaptures.length > 0;
    const kind = !recapturable
      ? 'hanging'
      : attackerValue < victimValue
        ? 'bad-trade'
        : 'protected-trade';
    captures.push({
      replyRank,
      san: reply.san,
      from: reply.from,
      to: reply.to,
      flags: reply.flags || '',
      targetSquare,
      capturesMovedPiece: targetSquare === movedSquare,
      victim: { square: targetSquare, type: victimType, value: victimValue },
      attacker: { square: reply.to, type: attackerType, value: attackerValue },
      recaptures,
      recapturable,
      immediateLoss: recapturable ? Math.max(0, victimValue - attackerValue) : victimValue,
      kind,
    });
  }

  const topCapture = captures.find((capture) => capture.replyRank === 0) || null;
  const movedCaptures = captures.filter((capture) => capture.capturesMovedPiece);
  const movedPieceKind = movedCaptures.some((capture) => capture.kind === 'hanging')
    ? 'hanging'
    : movedCaptures.some((capture) => capture.kind === 'bad-trade')
      ? 'bad-trade'
      : movedCaptures.some((capture) => capture.kind === 'protected-trade')
        ? 'protected-trade'
        : 'safe';

  return {
    afterFen,
    movedSquare,
    movedPiece: moved
      ? { type: moved.type, value: VALUE[moved.type] ?? 0 }
      : null,
    topReply: {
      san: replies[0]?.san || '',
      isCapture: !!topCapture,
      targetSquare: topCapture?.targetSquare || '',
      capturesMovedPiece: !!topCapture?.capturesMovedPiece,
    },
    captures,
    movedPieceEnPrise: movedCaptures.length > 0,
    movedPieceKind,
    legalCaptureCount: captures.length,
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
  // 不能隔 1024 节点才看钟：冷启动或与 WebGL/Worker 并发时，前 1024 节点本身就可能跑数秒。
  if ((ctx.nodes & 31) === 0 && performance.now() > ctx.deadline) throw TIMEOUT;

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
    if ((i & 15) === 0 && performance.now() > ctx.deadline) throw TIMEOUT;
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
        // 根节点每个候选前都查时间，保证浅层/低节点数时也不会越过预算。
        if (performance.now() > ctx.deadline) throw TIMEOUT;
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
