// xiangqi-worker.js —— 中国象棋 AI、威胁与真实分叉全部在 Worker 内计算。

import {
  START_FEN,
  parseFen,
  generateLegalMoves,
  getGameStatus,
  getThreats,
  moveToNotation,
  rankMoves,
  search,
} from './xiangqi-engine.js';

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

  if (message.type === 'branches') {
    try {
      const branches = rankMoves(message.fen || START_FEN);
      self.postMessage({
        type: 'branchesDone',
        id: message.id,
        result: { branchCount: branches.length, branches },
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
