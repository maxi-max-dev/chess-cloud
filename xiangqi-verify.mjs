// xiangqi-verify.mjs —— 中国象棋规则、搜索与真实分叉的独立 Node 裁判。
// 基线由 Fairy-Stockfish 的 xiangqi startpos perft 交叉核对：
// 44 / 1,920 / 79,666 / 3,290,240。

import {
  START_FEN,
  applyMove,
  evaluate,
  generateLegalMoves,
  getGameStatus,
  getThreats,
  isInCheck,
  moveToNotation,
  parseFen,
  rankMoves,
  search,
  squareToIndex,
  toFen,
} from './xiangqi-engine.js';

const results = [];
function record(ok, name, detail = '') {
  results.push({ ok: Boolean(ok), name, detail });
  console.log(`${ok ? '绿 ✓' : '红 ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function position(pieces, turn = 'w', halfmove = 0, fullmove = 1) {
  const board = new Array(90).fill('');
  for (const [square, piece] of Object.entries(pieces)) {
    const index = squareToIndex(square);
    if (index < 0) throw new Error(`测试夹具坐标无效：${square}`);
    board[index] = piece;
  }
  return { board, turn, halfmove, fullmove };
}

function moveSet(value, from = null) {
  return new Set(
    generateLegalMoves(value)
      .filter((move) => !from || move.from === from)
      .map((move) => `${move.from}-${move.to}`),
  );
}

export function count(value, depth) {
  if (depth === 0) return 1;
  let total = 0;
  for (const move of generateLegalMoves(value)) {
    total += count(applyMove(value, move, { validate: false }), depth - 1);
  }
  return total;
}

const roundTrip = toFen(parseFen(START_FEN));
record(roundTrip === START_FEN, '起始 FEN 可无损往返', roundTrip);

for (const [depth, expected] of [[1, 44], [2, 1920], [3, 79666], [4, 3290240]]) {
  const started = performance.now();
  const actual = count(parseFen(START_FEN), depth);
  record(actual === expected, `起始局面 perft(${depth})`, `${actual}（期望 ${expected}，${Math.round(performance.now() - started)}ms）`);
}

const horseMoves = moveSet(position({
  d9: 'k', e5: 'P', e4: 'N', e0: 'K',
}), 'e4');
record(
  !horseMoves.has('e4-d6') && !horseMoves.has('e4-f6')
    && horseMoves.has('e4-c5') && horseMoves.has('e4-g5'),
  '马腿会真实阻断对应两条腿',
  [...horseMoves].join(' '),
);

const elephantMoves = moveSet(position({
  d9: 'k', d3: 'P', e2: 'B', e0: 'K',
}), 'e2');
record(
  !elephantMoves.has('e2-c4')
    && elephantMoves.has('e2-g4')
    && elephantMoves.has('e2-c0')
    && elephantMoves.has('e2-g0')
    && [...elephantMoves].every((move) => Number(move.at(-1)) <= 4),
  '象眼受阻且相不越河',
  [...elephantMoves].join(' '),
);

const cannonPosition = position({
  d9: 'k', a4: 'r', a2: 'P', a0: 'C', e0: 'K',
});
const cannonMoves = generateLegalMoves(cannonPosition).filter((move) => move.from === 'a0');
record(
  cannonMoves.some((move) => move.to === 'a4' && move.captured === 'r')
    && cannonMoves.some((move) => move.to === 'a1')
    && !cannonMoves.some((move) => move.to === 'a3'),
  '炮隔一子吃子且不能越过炮架空走',
  cannonMoves.map((move) => `${move.from}-${move.to}${move.captured ? `x${move.captured}` : ''}`).join(' '),
);

const beforeRiver = moveSet(position({
  d9: 'k', e4: 'P', e0: 'K',
}), 'e4');
const afterRiver = moveSet(position({
  d9: 'k', e5: 'P', e0: 'K',
}), 'e5');
record(
  beforeRiver.size === 1 && beforeRiver.has('e4-e5')
    && afterRiver.has('e5-e6') && afterRiver.has('e5-d5') && afterRiver.has('e5-f5'),
  '兵过河前只进、过河后可横走',
  `河前=${[...beforeRiver]}｜河后=${[...afterRiver]}`,
);

const facingPosition = position({
  e9: 'k', e5: 'R', e0: 'K',
});
const facingMoves = moveSet(facingPosition, 'e5');
record(
  !facingMoves.has('e5-d5') && !facingMoves.has('e5-f5') && facingMoves.has('e5-e6'),
  '不能走出将帅照面，自将过滤有效',
  [...facingMoves].join(' '),
);

const defendedPosition = position({
  d9: 'k', e9: 'r', a4: 'R', e4: 'R', f0: 'K',
});
const defendedThreat = getThreats(defendedPosition).find((item) => item.square === 'e4');
record(
  defendedThreat?.attackers.includes('e9') && defendedThreat?.defenders.includes('a4'),
  '威胁注释同时保留真实攻击者与保护者',
  JSON.stringify(defendedThreat || null),
);

const matePosition = position({
  e9: 'k', e2: 'r', d1: 'r', f1: 'r', e0: 'K',
});
const mateStatus = getGameStatus(matePosition);
record(
  isInCheck(matePosition, 'w') && mateStatus.over && mateStatus.winner === 'b'
    && mateStatus.reason === 'checkmate' && mateStatus.legalMoveCount === 0,
  '将死被判为对手胜且无合法着',
  JSON.stringify(mateStatus),
);

const stalematePosition = position({
  e9: 'k', e5: 'p', d1: 'r', f1: 'r', e0: 'K',
});
const stalemateStatus = getGameStatus(stalematePosition);
record(
  !isInCheck(stalematePosition, 'w') && stalemateStatus.over && stalemateStatus.winner === 'b'
    && stalemateStatus.reason === 'stalemate-loss' && stalemateStatus.legalMoveCount === 0,
  '中国象棋困毙判负，不误写成和棋',
  JSON.stringify(stalemateStatus),
);

const historylessPosition = position({
  d9: 'k', a4: 'P', e0: 'K',
}, 'w', 120);
const historylessStatus = getGameStatus(historylessPosition);
record(
  !historylessStatus.over && historylessStatus.legalMoveCount > 0,
  '没有历史时不凭 halfmove 伪造长将、长捉或循环和棋',
  JSON.stringify(historylessStatus),
);

let illegalRejected = false;
try {
  applyMove(parseFen(START_FEN), { from: 'a0', to: 'b1' });
} catch {
  illegalRejected = true;
}
record(illegalRejected, '非法走法会被棋核拒绝');

const searchStarted = performance.now();
const searched = search(START_FEN, { timeBudgetMs: 90, maxDepth: 4 });
let replay = parseFen(START_FEN);
let pvLegal = Boolean(searched?.move && searched?.pv?.length);
for (const item of searched?.pv || []) {
  const legal = generateLegalMoves(replay).find((move) => move.from === item.from && move.to === item.to);
  if (!legal || moveToNotation(replay, legal) !== item.notation) {
    pvLegal = false;
    break;
  }
  replay = applyMove(replay, legal, { validate: false });
  if (toFen(replay) !== item.after) {
    pvLegal = false;
    break;
  }
}
const searchElapsed = performance.now() - searchStarted;
record(
  pvLegal
    && searched.branchCount === generateLegalMoves(START_FEN).length
    && searched.branches.length === searched.branchCount
    && searched.pv[0].from === searched.move.from
    && searched.pv[0].to === searched.move.to
    && searchElapsed < 2600,
  '搜索返回合法可重放 PV、真实全部根分叉且守住时限',
  `depth=${searched?.depth}｜pv=${searched?.pv?.length}｜branches=${searched?.branches?.length}｜${searchElapsed.toFixed(1)}ms`,
);

const fallback = search(START_FEN, { timeBudgetMs: 0, maxDepth: 4 });
const fallbackLegal = generateLegalMoves(START_FEN)
  .some((move) => move.from === fallback?.move?.from && move.to === fallback?.move?.to);
record(
  fallbackLegal && fallback.depth === 0 && fallback.pv.length === 0,
  '零预算只返回合法保底着，不冒充已搜索主变',
  `move=${fallback?.move?.from}-${fallback?.move?.to}｜depth=${fallback?.depth}｜pv=${fallback?.pv?.length}`,
);

const ranked = rankMoves(START_FEN);
let twoPlyOk = ranked.length === generateLegalMoves(START_FEN).length;
for (const candidate of ranked) {
  const root = parseFen(START_FEN);
  const move = generateLegalMoves(root)
    .find((item) => item.from === candidate.from && item.to === candidate.to);
  const child = move && applyMove(root, move, { validate: false });
  const replies = child ? generateLegalMoves(child) : [];
  const replyScores = replies.map((reply) => {
    const replyPosition = applyMove(child, reply, { validate: false });
    const replyTarget = squareToIndex(reply.to);
    const continuations = generateLegalMoves(replyPosition)
      .filter((response) => response.captured && squareToIndex(response.to) === replyTarget);
    return {
      reply,
      score: continuations.length
        ? Math.max(...continuations.map((response) =>
          evaluate(applyMove(replyPosition, response, { validate: false }))))
        : evaluate(replyPosition),
    };
  });
  const expected = replyScores.length ? Math.min(...replyScores.map((item) => item.score)) : 100000;
  const replyLegal = !candidate.reply || replies
    .some((reply) => reply.from === candidate.reply.from && reply.to === candidate.reply.to);
  if (!move || candidate.replyCount !== replies.length || candidate.score !== expected || !replyLegal) {
    twoPlyOk = false;
    break;
  }
}
const topRankedKey = `${ranked[0]?.from}-${ranked[0]?.to}`;
record(
  twoPlyOk && !['b2-b9', 'h2-h9'].includes(topRankedKey),
  '候选排序会看对方强回应与合法回吃，不把开局送炮换马排成首选',
  `首选=${ranked[0]?.notation} ${topRankedKey}｜回应=${ranked[0]?.reply?.notation || '终局'}｜depth=${ranked[0]?.searchedDepth}`,
);

const redMaterial = position({ d9: 'k', a4: 'R', e0: 'K' });
const blackMaterial = position({ d9: 'k', a5: 'r', e0: 'K' });
record(
  evaluate(redMaterial) > 0 && evaluate(blackMaterial) < 0,
  '唯一评估函数方向固定为正=红优、负=黑优',
  `${evaluate(redMaterial)} / ${evaluate(blackMaterial)}`,
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '未通过' : '全绿'}：${results.length - failed.length}/${results.length} 项通过，零跳过。`);
if (failed.length) process.exitCode = 1;
