// xiangqi-engine.js —— 中国象棋的规则、唯一评估函数与搜索。
//
// 坐标采用常见引擎坐标：a0 是红方左下角，i9 是黑方右上角。
// FEN 从黑方底线写到红方底线；w = 红，b = 黑。

export const START_FEN =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
export const MATE = 100000;

const FILES = 'abcdefghi';
const PIECE_VALUE = Object.freeze({ p: 100, a: 200, b: 200, n: 400, c: 450, r: 900, k: 0 });
const RED_NAMES = Object.freeze({ k: '帅', a: '仕', b: '相', n: '马', r: '车', c: '炮', p: '兵' });
const BLACK_NAMES = Object.freeze({ k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒' });
const RED_NUMBERS = '零一二三四五六七八九';
const TIMEOUT = Symbol('xiangqi-search-timeout');

const inside = (row, col) => row >= 0 && row < 10 && col >= 0 && col < 9;
const indexOf = (row, col) => row * 9 + col;
const rowOf = (index) => Math.floor(index / 9);
const colOf = (index) => index % 9;
const pieceSide = (piece) => piece && piece === piece.toUpperCase() ? 'w' : piece ? 'b' : '';
const pieceType = (piece) => piece ? piece.toLowerCase() : '';
const opposite = (side) => side === 'w' ? 'b' : 'w';
const inPalace = (side, row, col) =>
  col >= 3 && col <= 5 && (side === 'w' ? row >= 7 && row <= 9 : row >= 0 && row <= 2);

export function indexToSquare(index) {
  return `${FILES[colOf(index)]}${9 - rowOf(index)}`;
}

export function squareToIndex(square) {
  if (typeof square === 'number') return square;
  if (typeof square !== 'string' || square.length !== 2) return -1;
  const col = FILES.indexOf(square[0].toLowerCase());
  const rank = Number(square[1]);
  return col < 0 || !Number.isInteger(rank) || rank < 0 || rank > 9
    ? -1
    : indexOf(9 - rank, col);
}

function clonePosition(position) {
  return {
    board: position.board.slice(),
    turn: position.turn,
    halfmove: position.halfmove,
    fullmove: position.fullmove,
  };
}

function asPosition(value) {
  return typeof value === 'string' ? parseFen(value) : value;
}

export function parseFen(fen = START_FEN) {
  const parts = String(fen).trim().split(/\s+/);
  const rows = parts[0]?.split('/');
  if (!rows || rows.length !== 10) throw new Error('中国象棋 FEN 必须有 10 行');

  const board = new Array(90).fill('');
  for (let row = 0; row < 10; row++) {
    let col = 0;
    for (const char of rows[row]) {
      if (char >= '1' && char <= '9') {
        col += Number(char);
      } else {
        const type = char.toLowerCase();
        if (!(type in PIECE_VALUE) || col >= 9) throw new Error(`无效的中国象棋 FEN 棋子：${char}`);
        board[indexOf(row, col++)] = char;
      }
    }
    if (col !== 9) throw new Error(`中国象棋 FEN 第 ${row + 1} 行不是 9 路`);
  }

  const turn = parts[1] === 'b' ? 'b' : 'w';
  return {
    board,
    turn,
    halfmove: Number.isFinite(Number(parts[4])) ? Math.max(0, Number(parts[4])) : 0,
    fullmove: Number.isFinite(Number(parts[5])) ? Math.max(1, Number(parts[5])) : 1,
  };
}

export function toFen(value) {
  const position = asPosition(value);
  const rows = [];
  for (let row = 0; row < 10; row++) {
    let text = '';
    let empty = 0;
    for (let col = 0; col < 9; col++) {
      const piece = position.board[indexOf(row, col)];
      if (!piece) {
        empty++;
      } else {
        if (empty) text += empty;
        empty = 0;
        text += piece;
      }
    }
    if (empty) text += empty;
    rows.push(text);
  }
  return `${rows.join('/')} ${position.turn} - - ${position.halfmove || 0} ${position.fullmove || 1}`;
}

function makeMove(position, from, to) {
  const piece = position.board[from];
  const captured = position.board[to];
  return {
    from: indexToSquare(from),
    to: indexToSquare(to),
    fromIndex: from,
    toIndex: to,
    piece: pieceType(piece),
    color: pieceSide(piece),
    captured: pieceType(captured),
  };
}

function pushStep(position, moves, side, from, row, col) {
  if (!inside(row, col)) return;
  const to = indexOf(row, col);
  if (pieceSide(position.board[to]) !== side) moves.push(makeMove(position, from, to));
}

/**
 * 生成几何可走着，不检查走后己方将帅是否被将。
 * side 可显式指定，便于攻击线计算；默认取当前行棋方。
 */
export function generatePseudoMoves(value, side = null) {
  const position = asPosition(value);
  const movingSide = side || position.turn;
  const moves = [];

  for (let from = 0; from < 90; from++) {
    const piece = position.board[from];
    if (pieceSide(piece) !== movingSide) continue;
    const type = pieceType(piece);
    const row = rowOf(from);
    const col = colOf(from);

    if (type === 'r' || type === 'c') {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        let r = row + dr;
        let c = col + dc;
        let screen = false;
        while (inside(r, c)) {
          const to = indexOf(r, c);
          const target = position.board[to];
          if (type === 'r') {
            if (!target) {
              moves.push(makeMove(position, from, to));
            } else {
              if (pieceSide(target) !== movingSide) moves.push(makeMove(position, from, to));
              break;
            }
          } else if (!screen) {
            if (!target) moves.push(makeMove(position, from, to));
            else screen = true;
          } else if (target) {
            if (pieceSide(target) !== movingSide) moves.push(makeMove(position, from, to));
            break;
          }
          r += dr;
          c += dc;
        }
      }
      continue;
    }

    if (type === 'n') {
      for (const [dr, dc, lr, lc] of [
        [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
        [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
      ]) {
        if (!position.board[indexOf(row + lr, col + lc)]) {
          pushStep(position, moves, movingSide, from, row + dr, col + dc);
        }
      }
      continue;
    }

    if (type === 'b') {
      for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
        const r = row + dr;
        const c = col + dc;
        if (!inside(r, c)) continue;
        if (movingSide === 'w' ? r < 5 : r > 4) continue;
        if (position.board[indexOf(row + dr / 2, col + dc / 2)]) continue;
        pushStep(position, moves, movingSide, from, r, c);
      }
      continue;
    }

    if (type === 'a') {
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const r = row + dr;
        const c = col + dc;
        if (inPalace(movingSide, r, c)) pushStep(position, moves, movingSide, from, r, c);
      }
      continue;
    }

    if (type === 'k') {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const r = row + dr;
        const c = col + dc;
        if (inPalace(movingSide, r, c)) pushStep(position, moves, movingSide, from, r, c);
      }
      // 将帅照面时可沿同一路直接吃掉对方将帅。
      for (const dr of [-1, 1]) {
        let r = row + dr;
        while (inside(r, col)) {
          const target = position.board[indexOf(r, col)];
          if (target) {
            if (pieceSide(target) !== movingSide && pieceType(target) === 'k') {
              moves.push(makeMove(position, from, indexOf(r, col)));
            }
            break;
          }
          r += dr;
        }
      }
      continue;
    }

    if (type === 'p') {
      const forward = movingSide === 'w' ? -1 : 1;
      pushStep(position, moves, movingSide, from, row + forward, col);
      const crossedRiver = movingSide === 'w' ? row <= 4 : row >= 5;
      if (crossedRiver) {
        pushStep(position, moves, movingSide, from, row, col - 1);
        pushStep(position, moves, movingSide, from, row, col + 1);
      }
    }
  }
  return moves;
}

function applyUnchecked(position, move) {
  const from = move.fromIndex ?? squareToIndex(move.from);
  const to = move.toIndex ?? squareToIndex(move.to);
  const next = clonePosition(position);
  const piece = next.board[from];
  const captured = next.board[to];
  next.board[to] = piece;
  next.board[from] = '';
  next.turn = opposite(position.turn);
  next.halfmove = captured || pieceType(piece) === 'p' ? 0 : (position.halfmove || 0) + 1;
  next.fullmove = (position.fullmove || 1) + (position.turn === 'b' ? 1 : 0);
  return next;
}

export function isInCheck(value, side = null) {
  const position = asPosition(value);
  const checkedSide = side || position.turn;
  const kingIndex = position.board.findIndex(
    (piece) => pieceType(piece) === 'k' && pieceSide(piece) === checkedSide,
  );
  if (kingIndex < 0) return true;
  return generatePseudoMoves(position, opposite(checkedSide))
    .some((move) => move.toIndex === kingIndex);
}

export function generateLegalMoves(value, side = null) {
  const position = asPosition(value);
  const movingSide = side || position.turn;
  // applyUnchecked 依据 position.turn 翻方；分析非当前方时用一个轻量视图。
  const view = movingSide === position.turn ? position : { ...position, turn: movingSide };
  return generatePseudoMoves(view, movingSide).filter((move) => {
    const next = applyUnchecked(view, move);
    return !isInCheck(next, movingSide);
  });
}

/**
 * 执行一手合法着。默认校验；传 { validate:false } 仅供搜索内部使用。
 */
export function applyMove(value, move, opts = {}) {
  const position = asPosition(value);
  const from = squareToIndex(move?.from ?? move?.fromIndex);
  const to = squareToIndex(move?.to ?? move?.toIndex);
  if (from < 0 || to < 0) throw new Error('无效的中国象棋走法坐标');
  let selected = { ...move, fromIndex: from, toIndex: to };
  if (opts.validate !== false) {
    selected = generateLegalMoves(position).find((candidate) =>
      candidate.fromIndex === from && candidate.toIndex === to);
    if (!selected) throw new Error(`非法走法：${indexToSquare(from)}-${indexToSquare(to)}`);
  }
  return applyUnchecked(position, selected);
}

export function getGameStatus(value) {
  const position = asPosition(value);
  const redKing = position.board.some((piece) => piece === 'K');
  const blackKing = position.board.some((piece) => piece === 'k');
  if (!redKing || !blackKing) {
    return {
      over: true,
      winner: redKing ? 'w' : blackKing ? 'b' : null,
      reason: 'general-captured',
      inCheck: true,
      legalMoveCount: 0,
    };
  }
  const inCheck = isInCheck(position, position.turn);
  const legalMoveCount = generateLegalMoves(position).length;
  if (legalMoveCount === 0) {
    // 中国象棋无“逼和”：无合法着的一方判负。
    return {
      over: true,
      winner: opposite(position.turn),
      reason: inCheck ? 'checkmate' : 'stalemate-loss',
      inCheck,
      legalMoveCount,
    };
  }
  // 长将、长捉与循环裁决需要完整历史，Position 目前没有这本账。
  // 在历史适配层落地前宁可不自动判和，也不能只凭 FEN 里的 halfmove 伪造裁决。
  return { over: false, winner: null, reason: '', inCheck, legalMoveCount };
}

/**
 * 全项目中国象棋唯一评估函数。正数 = 红优，负数 = 黑优；单位约为百分兵。
 */
export function evaluate(value) {
  const position = asPosition(value);
  let score = 0;
  for (let index = 0; index < 90; index++) {
    const piece = position.board[index];
    if (!piece) continue;
    const side = pieceSide(piece);
    const type = pieceType(piece);
    const row = rowOf(index);
    const col = colOf(index);
    let valueScore = PIECE_VALUE[type];
    if (type === 'p') {
      const progress = side === 'w' ? 6 - row : row - 3;
      const centrality = Math.max(0, 4 - Math.abs(4 - col));
      valueScore += Math.max(0, progress) * 12;
      if (side === 'w' ? row <= 4 : row >= 5) valueScore += 28;
      valueScore += centrality;
      valueScore += Math.max(0, progress) * centrality * 2;
    } else if (type === 'n' || type === 'c') {
      valueScore += Math.max(0, 4 - Math.abs(4 - col)) * 3;
      valueScore += Math.max(0, 4 - Math.abs(4.5 - row)) * 2;
    } else if (type === 'r') {
      valueScore += Math.max(0, 4 - Math.abs(4 - col)) * 2;
    }
    score += side === 'w' ? valueScore : -valueScore;
  }
  return score;
}

function sideFile(side, col) {
  const number = side === 'w' ? 9 - col : col + 1;
  return side === 'w' ? RED_NUMBERS[number] : String(number);
}

function sideNumber(side, number) {
  return side === 'w' ? RED_NUMBERS[number] : String(number);
}

export function moveToNotation(value, move) {
  const position = asPosition(value);
  const from = squareToIndex(move.from ?? move.fromIndex);
  const to = squareToIndex(move.to ?? move.toIndex);
  if (from < 0 || to < 0) return '';
  const piece = position.board[from];
  if (!piece) return `${indexToSquare(from)}-${indexToSquare(to)}`;
  const side = pieceSide(piece);
  const type = pieceType(piece);
  const fromRow = rowOf(from);
  const fromCol = colOf(from);
  const toRow = rowOf(to);
  const toCol = colOf(to);
  const names = side === 'w' ? RED_NAMES : BLACK_NAMES;
  const forward = side === 'w' ? toRow < fromRow : toRow > fromRow;
  const action = toRow === fromRow ? '平' : forward ? '进' : '退';
  const usesTargetFile = toRow === fromRow || type === 'n' || type === 'b' || type === 'a';
  const target = usesTargetFile
    ? sideFile(side, toCol)
    : sideNumber(side, Math.abs(toRow - fromRow));
  const sameFile = [];
  for (let index = fromCol; index < 90; index += 9) {
    const candidate = position.board[index];
    if (pieceSide(candidate) === side && pieceType(candidate) === type) sameFile.push(index);
  }
  let source = `${names[type]}${sideFile(side, fromCol)}`;
  if (sameFile.length > 1) {
    sameFile.sort((a, b) => side === 'w' ? a - b : b - a);
    const order = sameFile.indexOf(from);
    const qualifier = sameFile.length === 2
      ? (order === 0 ? '前' : '后')
      : (order === 0 ? '前' : order === sameFile.length - 1 ? '后' : '中');
    source = `${qualifier}${names[type]}`;
  }
  return `${source}${action}${target}`;
}

/**
 * 当前行棋方受几何攻击的棋子。它描述攻击线，不冒充“下一手必丢”。
 */
export function getThreats(value) {
  const position = asPosition(value);
  const side = position.turn;
  const enemyMoves = generatePseudoMoves(position, opposite(side));
  const attackersByTarget = new Map();
  for (const move of enemyMoves) {
    if (!position.board[move.toIndex]) continue;
    const list = attackersByTarget.get(move.toIndex) || [];
    list.push(move.from);
    attackersByTarget.set(move.toIndex, list);
  }
  const threats = [];
  for (const [target, attackers] of attackersByTarget) {
    const piece = position.board[target];
    if (pieceSide(piece) !== side) continue;
    // 走法生成器正确地不会“吃己子”；为了回答“谁守着这枚己子”，临时把
    // 目标格换成敌方占位子，再读取真正能落到该格的几何着（炮架也因此正确）。
    const defenseView = clonePosition(position);
    defenseView.board[target] = side === 'w' ? 'p' : 'P';
    const defenders = generatePseudoMoves(defenseView, side)
      .filter((move) => move.toIndex === target)
      .map((move) => move.from)
      .sort();
    threats.push({
      square: indexToSquare(target),
      piece: pieceType(piece),
      side,
      value: PIECE_VALUE[pieceType(piece)],
      attackers: attackers.sort(),
      defenders,
      certainty: 'geometric',
    });
  }
  return threats.sort((a, b) =>
    Number(a.defenders.length > 0) - Number(b.defenders.length > 0)
    || b.value - a.value
    || a.square.localeCompare(b.square));
}

function publicMove(position, move) {
  const next = applyUnchecked(position, move);
  return {
    from: move.from,
    to: move.to,
    piece: move.piece,
    captured: move.captured || '',
    notation: moveToNotation(position, move),
    after: toFen(next),
    givesCheck: isInCheck(next, next.turn),
  };
}

function moveOrderScore(move) {
  let score = 0;
  if (move.captured) score += 1000 + PIECE_VALUE[move.captured] - PIECE_VALUE[move.piece] / 10;
  if (move.givesCheck) score += 80;
  return score;
}

function orderedMoves(position, moves, preferredKey = '') {
  const enriched = moves.map((move) => {
    const next = applyUnchecked(position, move);
    return { ...move, givesCheck: isInCheck(next, next.turn) };
  });
  enriched.sort((a, b) => {
    const ak = `${a.from}${a.to}` === preferredKey ? 100000 : 0;
    const bk = `${b.from}${b.to}` === preferredKey ? 100000 : 0;
    return bk + moveOrderScore(b) - ak - moveOrderScore(a);
  });
  return enriched;
}

function checkTime(ctx) {
  if (performance.now() >= ctx.deadline) throw TIMEOUT;
}

// 返回站在当前行棋方视角的分数。
function negamax(position, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 15) === 0) checkTime(ctx);
  ctx.pvLength[ply] = ply;

  const moves = generateLegalMoves(position);
  if (moves.length === 0) return -(MATE - ply); // 将死与困毙在中国象棋都判负
  if (depth <= 0) {
    const staticScore = evaluate(position);
    return position.turn === 'w' ? staticScore : -staticScore;
  }

  let best = -Infinity;
  const ordered = orderedMoves(position, moves, ctx.pvKeys[ply] || '');
  for (let i = 0; i < ordered.length; i++) {
    if ((i & 7) === 0) checkTime(ctx);
    const move = ordered[i];
    const child = applyUnchecked(position, move);
    const score = -negamax(child, depth - 1, -beta, -alpha, ply + 1, ctx);
    if (score > best) {
      best = score;
      const row = ctx.pvTable[ply];
      row[ply] = move;
      const end = Math.max(ply + 1, ctx.pvLength[ply + 1]);
      for (let index = ply + 1; index < end; index++) row[index] = ctx.pvTable[ply + 1][index];
      ctx.pvLength[ply] = end;
    }
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * 迭代加深 alpha-beta。预算被钳到 2400ms，给消息传输留出余量，保证 UI 的 3 秒红线。
 * branches 是根节点的真实全部合法着；score/depth 只取最后一层完整搜索结果。
 */
export function search(fen = START_FEN, opts = {}) {
  const requestedBudget = Number(opts.timeBudgetMs ?? 1400);
  const timeBudgetMs = Math.max(0, Math.min(2400, Number.isFinite(requestedBudget) ? requestedBudget : 1400));
  const maxDepth = Math.max(1, Math.min(12, Math.floor(opts.maxDepth ?? 7)));
  const started = performance.now();
  const position = parseFen(fen);
  const rootMoves = generateLegalMoves(position);
  if (rootMoves.length === 0) return null;

  const pvSize = maxDepth + 3;
  const ctx = {
    nodes: 0,
    deadline: started + timeBudgetMs,
    pvTable: Array.from({ length: pvSize }, () => new Array(pvSize)),
    pvLength: new Uint16Array(pvSize),
    pvKeys: new Array(pvSize).fill(''),
  };
  const rootInfo = rootMoves.map((move) => {
    const child = applyUnchecked(position, move);
    return {
      move,
      public: publicMove(position, move),
      replyCount: generateLegalMoves(child).length,
      staticScore: evaluate(child),
    };
  });
  let bestMove = rootMoves[0];
  let bestScore = position.turn === 'w' ? rootInfo[0].staticScore : -rootInfo[0].staticScore;
  let bestPv = [publicMove(position, bestMove)];
  let completedDepth = 0;
  let completedScores = new Map();

  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -Infinity;
    let localBest = null;
    let localPv = null;
    const localScores = new Map();
    const preferred = `${bestMove.from}${bestMove.to}`;
    const ordered = orderedMoves(position, rootMoves, preferred);
    try {
      for (const move of ordered) {
        checkTime(ctx);
        const child = applyUnchecked(position, move);
        const score = depth === 1
          ? -(child.turn === 'w' ? evaluate(child) : -evaluate(child))
          : -negamax(child, depth - 1, -Infinity, -alpha, 1, ctx);
        localScores.set(`${move.from}${move.to}`, score);
        if (localBest === null || score > alpha) {
          alpha = score;
          localBest = move;
          localPv = [publicMove(position, move)];
          let cursor = child;
          for (let index = 1; index < ctx.pvLength[1]; index++) {
            const pvMove = ctx.pvTable[1][index];
            if (!pvMove) break;
            localPv.push(publicMove(cursor, pvMove));
            cursor = applyUnchecked(cursor, pvMove);
          }
        }
      }
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      break;
    }
    bestMove = localBest;
    bestScore = alpha;
    bestPv = localPv;
    completedDepth = depth;
    completedScores = localScores;
    ctx.pvKeys = bestPv.map((move) => `${move.from}${move.to}`);
    if (Math.abs(bestScore) >= MATE - 100 || performance.now() >= ctx.deadline) break;
  }

  const branches = rootInfo.map((entry) => {
    const key = `${entry.move.from}${entry.move.to}`;
    const sideScore = completedScores.has(key)
      ? completedScores.get(key)
      : position.turn === 'w' ? entry.staticScore : -entry.staticScore;
    return {
      ...entry.public,
      score: position.turn === 'w' ? sideScore : -sideScore,
      replyCount: entry.replyCount,
      searchedDepth: completedScores.has(key) ? completedDepth : 0,
    };
  }).sort((a, b) => position.turn === 'w' ? b.score - a.score : a.score - b.score);

  return {
    move: { from: bestMove.from, to: bestMove.to },
    notation: moveToNotation(position, bestMove),
    score: position.turn === 'w' ? bestScore : -bestScore,
    depth: completedDepth,
    nodes: ctx.nodes,
    ms: performance.now() - started,
    // depth=0 只表示合法保底着，不能把它包装成已经搜索完成的主变。
    pv: completedDepth > 0 ? bestPv : [],
    branchCount: rootMoves.length,
    branches,
  };
}

/**
 * 非限时的“候选 → 对方回应 → 一步合法回吃”排序，供小面板快速展示。
 * 每个候选都会看完对方全部合法回应；若回应子能被立刻回吃，只允许评估这类同格回吃，
 * 再按对方最强回应后的唯一 evaluate() 排序。
 * 这样不会把“先吃子、下一手立刻被回吃”冒充首选。更深搜索仍只能调用 search()。
 */
export function rankMoves(fen = START_FEN) {
  const position = parseFen(fen);
  const side = position.turn;
  return generateLegalMoves(position).map((move) => {
    const child = applyUnchecked(position, move);
    const replies = generateLegalMoves(child);
    let bestReply = null;
    let bestContinuation = null;
    let score = side === 'w' ? Infinity : -Infinity;
    if (!replies.length) {
      score = side === 'w' ? MATE : -MATE;
    } else {
      for (const reply of replies) {
        const replyPosition = applyUnchecked(child, reply);
        const continuations = generateLegalMoves(replyPosition)
          .filter((response) => response.captured && response.toIndex === reply.toIndex);
        let replyScore = evaluate(replyPosition);
        let continuation = null;
        if (continuations.length) {
          replyScore = side === 'w' ? -Infinity : Infinity;
          for (const response of continuations) {
            const responseScore = evaluate(applyUnchecked(replyPosition, response));
            if (continuation === null || (side === 'w'
              ? responseScore > replyScore
              : responseScore < replyScore)) {
              replyScore = responseScore;
              continuation = response;
            }
          }
        }
        if (bestReply === null || (side === 'w' ? replyScore < score : replyScore > score)) {
          score = replyScore;
          bestReply = reply;
          bestContinuation = continuation;
        }
      }
    }
    return {
      ...publicMove(position, move),
      score,
      staticScore: evaluate(child),
      replyCount: replies.length,
      reply: bestReply ? publicMove(child, bestReply) : null,
      continuation: bestReply && bestContinuation
        ? publicMove(applyUnchecked(child, bestReply), bestContinuation)
        : null,
      searchedDepth: 2,
      recaptureChecked: true,
    };
  }).sort((a, b) => {
    const searchedOrder = side === 'w' ? b.score - a.score : a.score - b.score;
    if (searchedOrder) return searchedOrder;
    return side === 'w' ? b.staticScore - a.staticScore : a.staticScore - b.staticScore;
  });
}
