// xiangqi-worker.js —— 中国象棋 AI、威胁与真实分叉全部在 Worker 内计算。

import {
  START_FEN,
  applyMove,
  parseFen,
  generateLegalMoves,
  getGameStatus,
  getThreats,
  moveToNotation,
  rankMoves,
  search,
  squareToIndex,
  toFen,
} from './xiangqi-engine.js';

function sameMove(left, right) {
  const from = (move) => Number.isInteger(move?.fromIndex)
    ? move.fromIndex
    : squareToIndex(move?.from);
  const to = (move) => Number.isInteger(move?.toIndex)
    ? move.toIndex
    : squareToIndex(move?.to);
  return !!left && !!right && from(left) === from(right) && to(left) === to(right);
}

function buildAutoplayLine(fen, rootBranches, maxPly = 4) {
  let position = parseFen(fen);
  let ranked = rootBranches;
  const line = [];
  while (line.length < maxPly && ranked.length) {
    const candidate = ranked[0];
    const legalMove = generateLegalMoves(position).find((move) => sameMove(move, candidate));
    if (!legalMove) break;
    position = applyMove(position, legalMove, { validate: false });
    line.push({ ...candidate, after: toFen(position) });
    if (line.length >= maxPly || !candidate.reply) break;

    const legalReply = generateLegalMoves(position).find((move) => sameMove(move, candidate.reply));
    if (!legalReply) break;
    position = applyMove(position, legalReply, { validate: false });
    line.push({ ...candidate.reply, after: toFen(position) });
    if (line.length >= maxPly) break;
    ranked = rankMoves(toFen(position));
  }
  return line;
}

function buildPreviewLine(fen, requestedMoves, maxPly = 4) {
  let position = parseFen(fen);
  const seed = (Array.isArray(requestedMoves) ? requestedMoves : [requestedMoves]).filter(Boolean);
  let seedIndex = 0;
  let requested = seed[0] || null;
  const line = [];
  while (requested && line.length < maxPly) {
    const legalMove = generateLegalMoves(position).find((move) => sameMove(move, requested));
    if (!legalMove) break;
    position = applyMove(position, legalMove, { validate: false });
    line.push({ ...requested, ...legalMove, after: toFen(position) });
    if (line.length >= maxPly) break;
    seedIndex += 1;
    requested = seed[seedIndex] || search(toFen(position), {
      timeBudgetMs: 90,
      maxDepth: 2,
    }).move || null;
  }
  return line;
}

self.onmessage = (event) => {
  const message = event.data || {};

  if (message.type === 'ping') {
    generateLegalMoves(parseFen(START_FEN));
    self.postMessage({ type: 'pong' });
    return;
  }

  if (message.type === 'search') {
    try {
      const result = search(message.fen || START_FEN, {
        timeBudgetMs: message.timeBudgetMs,
        maxDepth: message.maxDepth,
      });
      self.postMessage({ type: 'searchDone', id: message.id, result });
    } catch (error) {
      self.postMessage({
        type: 'searchError',
        id: message.id,
        message: String(error?.message || error),
      });
    }
    return;
  }

  if (message.type === 'analyze') {
    try {
      const fen = message.fen || START_FEN;
      const position = parseFen(fen);
      const moves = generateLegalMoves(position).map((move) => ({
        from: move.from,
        to: move.to,
        piece: move.piece,
        captured: move.captured || '',
        notation: moveToNotation(position, move),
      }));
      self.postMessage({
        type: 'analyzeDone',
        id: message.id,
        result: {
          status: getGameStatus(position),
          threats: getThreats(position),
          legalMoveCount: moves.length,
          moves,
        },
      });
    } catch (error) {
      self.postMessage({
        type: 'analyzeError',
        id: message.id,
        message: String(error?.message || error),
      });
    }
    return;
  }

  if (message.type === 'previewLine') {
    try {
      const line = buildPreviewLine(
        message.fen || START_FEN,
        message.moves || message.move,
        Math.max(1, Math.min(4, Number(message.maxPly) || 4)),
      );
      self.postMessage({
        type: 'previewLineDone',
        id: message.id,
        positionId: message.positionId,
        positionKey: message.positionKey,
        moveKey: message.moveKey,
        rootMoveKey: message.rootMoveKey,
        result: { line },
      });
    } catch (error) {
      self.postMessage({
        type: 'previewLineError',
        id: message.id,
        positionId: message.positionId,
        positionKey: message.positionKey,
        moveKey: message.moveKey,
        rootMoveKey: message.rootMoveKey,
        message: String(error?.message || error),
      });
    }
    return;
  }

  if (message.type === 'branches') {
    try {
      const branches = rankMoves(message.fen || START_FEN);
      const autoplayLine = buildAutoplayLine(message.fen || START_FEN, branches);
      self.postMessage({
        type: 'branchesDone',
        id: message.id,
        result: { branchCount: branches.length, branches, autoplayLine },
      });
    } catch (error) {
      self.postMessage({
        type: 'branchesError',
        id: message.id,
        message: String(error?.message || error),
      });
    }
  }
};
