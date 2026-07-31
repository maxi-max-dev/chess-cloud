#!/usr/bin/env node
// xiangqi-self-play.mjs —— 固定 10 局的中国象棋搜索/主变/分叉稳定性审计。
// 这是正确性冒烟，不是棋力基准；达到手数上限会如实写 capped，不冒充和棋。

import {
  START_FEN,
  applyMove,
  generateLegalMoves,
  getGameStatus,
  getThreats,
  moveToNotation,
  parseFen,
  search,
  toFen,
} from './xiangqi-engine.js';

const GAMES = 10;
const MAX_PLIES = 100;
const SEARCH_MS = 22;
const MAX_DEPTH = 4;

function moveKey(move) {
  return `${move.from}-${move.to}`;
}

function replayPv(fen, result) {
  let cursor = parseFen(fen);
  if (result.depth === 0 && result.pv.length === 0) {
    return { ok: true, fallback: true };
  }
  if (!result.pv.length || moveKey(result.pv[0]) !== moveKey(result.move)) {
    return { ok: false, reason: 'PV 首着与最佳着不同' };
  }
  for (let index = 0; index < result.pv.length; index++) {
    const item = result.pv[index];
    const legal = generateLegalMoves(cursor).find((move) => moveKey(move) === moveKey(item));
    if (!legal) return { ok: false, reason: `PV 第 ${index + 1} 手非法 ${moveKey(item)}` };
    if (moveToNotation(cursor, legal) !== item.notation) {
      return { ok: false, reason: `PV 第 ${index + 1} 手记谱不一致` };
    }
    cursor = applyMove(cursor, legal, { validate: false });
    if (toFen(cursor) !== item.after) {
      return { ok: false, reason: `PV 第 ${index + 1} 手 after FEN 不一致` };
    }
  }
  return { ok: true };
}

function branchAudit(fen, legal, result) {
  if (result.branchCount !== legal.length || result.branches.length !== legal.length) {
    return `根分叉 ${result.branchCount}/${result.branches.length}≠${legal.length}`;
  }
  const position = parseFen(fen);
  const legalKeys = new Set(legal.map(moveKey));
  for (const branch of result.branches) {
    if (!legalKeys.has(moveKey(branch))) return `分叉含非法着 ${moveKey(branch)}`;
    const move = legal.find((candidate) => moveKey(candidate) === moveKey(branch));
    const child = applyMove(position, move, { validate: false });
    const replies = generateLegalMoves(child).length;
    if (branch.replyCount !== replies) {
      return `${moveKey(branch)} 回应数 ${branch.replyCount}≠${replies}`;
    }
  }
  for (let index = 1; index < result.branches.length; index++) {
    const previous = result.branches[index - 1].score;
    const current = result.branches[index].score;
    if (position.turn === 'w' ? previous < current : previous > current) {
      return `${position.turn} 方分叉排序方向错误`;
    }
  }
  return '';
}

let totalPlies = 0;
let searches = 0;
let pvPlies = 0;
let maxSearchMs = 0;
let illegalMoves = 0;
let fenMismatches = 0;
let pvFailures = 0;
let branchFailures = 0;
let threatFailures = 0;
let terminalGames = 0;
let cappedGames = 0;
const gameSummaries = [];
const started = performance.now();

for (let gameIndex = 0; gameIndex < GAMES; gameIndex++) {
  let position = parseFen(START_FEN);
  let status = getGameStatus(position);
  let plies = 0;
  let failure = '';

  while (!status.over && plies < MAX_PLIES) {
    const fen = toFen(position);
    if (toFen(parseFen(fen)) !== fen) {
      fenMismatches++;
      failure = 'FEN 往返不一致';
      break;
    }

    const legal = generateLegalMoves(position);
    const result = search(fen, { timeBudgetMs: SEARCH_MS, maxDepth: MAX_DEPTH });
    searches++;
    maxSearchMs = Math.max(maxSearchMs, result?.ms || 0);
    if (!result) {
      illegalMoves++;
      failure = '非终局搜索返回空';
      break;
    }

    const chosenLegal = legal.find((move) => moveKey(move) === moveKey(result.move));
    if (!chosenLegal) {
      illegalMoves++;
      failure = `搜索给出非法着 ${moveKey(result.move)}`;
      break;
    }

    const pvAudit = replayPv(fen, result);
    pvPlies += result.pv.length;
    if (!pvAudit.ok) {
      pvFailures++;
      failure = pvAudit.reason;
      break;
    }

    const branchError = branchAudit(fen, legal, result);
    if (branchError) {
      branchFailures++;
      failure = branchError;
      break;
    }

    // 前三手用固定种子在引擎排好的前几条中分流，让十局不是同一盘复制品。
    let actual = chosenLegal;
    if (plies < 3 && result.branches.length > 1) {
      const width = Math.min(5, result.branches.length);
      const rank = (gameIndex * 3 + plies * 2) % width;
      const selected = result.branches[rank];
      actual = legal.find((move) => moveKey(move) === moveKey(selected)) || chosenLegal;
    }

    position = applyMove(position, actual, { validate: false });
    const nextFen = toFen(position);
    if (toFen(parseFen(nextFen)) !== nextFen) {
      fenMismatches++;
      failure = '落子后 FEN 往返不一致';
      break;
    }

    const threats = getThreats(position);
    const targetSide = position.turn;
    for (const threat of threats) {
      const target = position.board.find((piece, index) =>
        index >= 0
        && `${'abcdefghi'[index % 9]}${9 - Math.floor(index / 9)}` === threat.square);
      const actualSide = target && target === target.toUpperCase() ? 'w' : target ? 'b' : '';
      if (threat.certainty !== 'geometric' || actualSide !== targetSide || !threat.attackers.length) {
        threatFailures++;
        failure = `威胁注释不实 ${threat.square}`;
        break;
      }
    }
    if (failure) break;

    plies++;
    totalPlies++;
    status = getGameStatus(position);
  }

  if (status.over) terminalGames++;
  else if (!failure && plies >= MAX_PLIES) cappedGames++;
  gameSummaries.push({
    game: gameIndex + 1,
    plies,
    result: failure || (status.over
      ? `${status.winner === 'w' ? '红胜' : status.winner === 'b' ? '黑胜' : '和棋'}:${status.reason}`
      : 'capped'),
  });
}

const elapsed = performance.now() - started;
for (const summary of gameSummaries) {
  console.log(`第 ${summary.game} 局：${summary.plies} plies｜${summary.result}`);
}
console.log('');
console.log(`总计：${GAMES} 局 / ${totalPlies} plies / ${searches} 次搜索 / ${pvPlies} 个 PV 节点`);
console.log(`终局=${terminalGames}｜达到测试上限=${cappedGames}｜最大搜索=${maxSearchMs.toFixed(1)}ms｜总耗时=${(elapsed / 1000).toFixed(2)}s`);
console.log(`illegalMoves=${illegalMoves}｜fenMismatches=${fenMismatches}｜pvFailures=${pvFailures}｜branchFailures=${branchFailures}｜threatFailures=${threatFailures}`);

const failures = illegalMoves + fenMismatches + pvFailures + branchFailures + threatFailures;
if (gameSummaries.some((summary) => !['capped'].includes(summary.result) && !summary.result.includes('胜') && !summary.result.includes('和棋'))) {
  process.exitCode = 1;
} else if (failures || maxSearchMs >= 2800) {
  process.exitCode = 1;
}
