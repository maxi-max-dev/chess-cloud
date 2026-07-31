#!/usr/bin/env node

// engine.js 自我对弈稳定性审计。
//
// 这不是棋力基准：默认每次 search() 只有 18ms，重点检查合法性、FEN 一致性、
// 重复局面保护，以及 UI 的 situation / quality 是否仍与 engine.js 分数同源。

import crypto from 'node:crypto';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const SETTINGS = Object.freeze({
  games: 10,
  openingPlies: 4,
  maxPlies: 120,
  searchBudgetMs: 18,
  searchMaxDepth: 5,
  openingRankDepth: 2,
  seeds: [1103, 2207, 3301, 4409, 5501, 6607, 7703, 8807, 9901, 10103],
});

const ENGINE_CDN = 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

/**
 * Node 不支持 engine.js 使用的 https: ESM import。这里只在内存里把钉死的 CDN URL
 * 换成本仓库已安装的同版 chess.js 文件 URL；engine.js 的评估、排序和搜索源码保持原样。
 */
async function loadEngine() {
  let source = fs.readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
  const occurrences = source.split(ENGINE_CDN).length - 1;
  if (occurrences !== 1) {
    throw new Error(`engine.js 的 chess.js CDN import 应恰好出现一次，实际 ${occurrences} 次`);
  }
  const localChessUrl = import.meta.resolve('chess.js');
  source = source.replace(ENGINE_CDN, localChessUrl);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

/**
 * 读取页面正在使用的两个人话映射函数，避免审计另一份复制实现。
 * 函数提取器处理字符串与模板字符串，且只接受完整、唯一的函数声明。
 */
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) {
    throw new Error(`index.html 中 ${name}() 应恰好出现一次`);
  }
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`index.html 中 ${name}() 没有完整结束`);
}

function loadScoreLanguage(MATE) {
  const source = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const factory = new Function(
    'MATE',
    `${extractFunction(source, 'scoreSituation')}
${extractFunction(source, 'moveQuality')}
return { scoreSituation, moveQuality };`,
  );
  return factory(MATE);
}

function expectedSituation(score, MATE) {
  if (score >= MATE) return 'mate-win';
  if (score <= -MATE) return 'mate-loss';
  if (score >= 150) return 'white-clear';
  if (score >= 50) return 'white-edge';
  if (score > -50) return 'balanced';
  if (score > -150) return 'black-edge';
  return 'black-clear';
}

function expectedQuality(score, bestScore, white, MATE) {
  const wins = white ? score >= MATE : score <= -MATE;
  const loses = white ? score <= -MATE : score >= MATE;
  const bestWins = white ? bestScore >= MATE : bestScore <= -MATE;
  if (wins) return 'wins';
  if (loses) return 'mated';
  if (bestWins) return 'misses-mate';
  const loss = Math.max(0, white ? bestScore - score : score - bestScore);
  if (loss <= 15) return 'best';
  if (loss <= 50) return 'steady';
  if (loss <= 100) return 'accurate';
  return 'risky';
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = state + 0x6D2B79F5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function positionKey(fen) {
  // 三次重复只取棋子、行棋方、王车易位和吃过路权；半回合钟/回合号不属于局面。
  return fen.split(' ').slice(0, 4).join(' ');
}

function moveSignature(move) {
  return `${move.from}:${move.to}:${move.promotion || ''}:${move.san}:${move.after}`;
}

function principalVariationError(fen, searched, Chess) {
  if (!Array.isArray(searched.pv)) {
    return 'search PV missing';
  }
  if (searched.depth === 0) {
    return searched.pv.length === 0
      ? ''
      : `incomplete search returned a ${searched.pv.length}-ply PV`;
  }
  if (searched.pv.length === 0) {
    return `completed depth ${searched.depth} returned an empty PV`;
  }
  if (searched.pv.length > searched.depth) {
    return `search PV length ${searched.pv.length} exceeds completed depth ${searched.depth}`;
  }

  const first = searched.pv[0];
  if (
    first.from !== searched.move.from
    || first.to !== searched.move.to
    || (first.promotion || '') !== (searched.move.promotion || '')
    || first.san !== searched.san
  ) {
    return 'search PV first move does not match returned move/SAN';
  }

  const replay = new Chess(fen);
  for (let index = 0; index < searched.pv.length; index++) {
    const step = searched.pv[index];
    if (
      !step
      || typeof step.san !== 'string'
      || typeof step.from !== 'string'
      || typeof step.to !== 'string'
      || typeof step.promotion !== 'string'
      || typeof step.after !== 'string'
    ) {
      return `search PV ply ${index} is missing san/from/to/promotion/after`;
    }
    const legal = replay.moves({ verbose: true }).find((move) =>
      move.from === step.from
      && move.to === step.to
      && (move.promotion || '') === step.promotion
    );
    if (!legal) {
      return `search PV ply ${index} is illegal: ${step.from}-${step.to}`;
    }
    if (legal.san !== step.san) {
      return `search PV ply ${index} SAN mismatch: ${step.san} != ${legal.san}`;
    }
    if (legal.after !== step.after) {
      return `search PV ply ${index} after FEN mismatch`;
    }
    replay.move({
      from: legal.from,
      to: legal.to,
      ...(legal.promotion ? { promotion: legal.promotion } : {}),
    });
  }
  if (searched.pv.length < searched.depth && replay.moves().length > 0) {
    return `search PV stopped at ${searched.pv.length}/${searched.depth} before a terminal position`;
  }
  return '';
}

function classifyTerminal(game, guard = '') {
  if (guard) return guard;
  if (game.isCheckmate()) return game.turn() === 'w' ? '0-1 checkmate' : '1-0 checkmate';
  if (game.isStalemate()) return '1/2-1/2 stalemate';
  if (game.isThreefoldRepetition()) return '1/2-1/2 threefold';
  if (game.isInsufficientMaterial()) return '1/2-1/2 insufficient';
  if (game.isDraw()) return '1/2-1/2 draw';
  if (game.isGameOver()) return 'game-over other';
  return 'unfinished';
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function commonPrefix(a, b) {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}

function auditLabels({
  gameIndex,
  ply,
  fen,
  rankMoves,
  scoreSituation,
  moveQuality,
  MATE,
  samples,
}) {
  const ranked = rankMoves(fen, { depth: 2 });
  const white = fen.split(' ')[1] === 'w';
  const bestScore = ranked[0]?.score;
  const ordered = ranked.every((move, index) =>
    index === 0
    || (
      white
        ? ranked[index - 1].score >= move.score
        : ranked[index - 1].score <= move.score
    )
  );
  for (const move of ranked.slice(0, 3)) {
    const situation = scoreSituation(move.score);
    const quality = moveQuality(move.score, bestScore, white);
    samples.push({
      game: gameIndex + 1,
      ply,
      turn: white ? 'w' : 'b',
      san: move.san,
      score: move.score,
      bestScore,
      situation: situation.key,
      quality: quality.key,
      ordered,
      ok:
        ordered
        && situation.key === expectedSituation(move.score, MATE)
        && quality.key === expectedQuality(move.score, bestScore, white, MATE),
    });
  }
}

function playOne({
  gameIndex,
  seed,
  Chess,
  MATE,
  rankMoves,
  search,
  scoreSituation,
  moveQuality,
  annotationSamples,
}) {
  const random = mulberry32(seed);
  const game = new Chess();
  const seen = new Map([[positionKey(game.fen()), 1]]);
  const sans = [];
  const opening = [];
  const searchTimes = [];
  const searchDepths = [];
  const errors = [];
  let illegal = 0;
  let fenMismatch = 0;
  let pvFailures = 0;
  let zeroDepth = 0;
  let guard = '';
  const started = performance.now();

  for (let ply = 0; ply < SETTINGS.maxPlies; ply++) {
    if (game.isGameOver()) break;
    const beforeFen = game.fen();
    const beforeTurn = game.turn();
    const beforeHistoryLength = game.history().length;
    const legal = game.moves({ verbose: true });
    if (legal.length === 0) break;

    let chosen;
    let source;
    if (ply < SETTINGS.openingPlies) {
      const ranked = rankMoves(beforeFen, { depth: SETTINGS.openingRankDepth });
      const expectedSet = legal.map(moveSignature).sort();
      const actualSet = ranked.map(moveSignature).sort();
      if (JSON.stringify(actualSet) !== JSON.stringify(expectedSet)) {
        errors.push(`ply ${ply}: rankMoves legal set mismatch`);
        break;
      }
      const rank = Math.floor(random() * Math.min(3, ranked.length));
      chosen = ranked[rank];
      source = `rank#${rank + 1}`;
      opening.push(chosen.san);
    } else {
      const searchStarted = performance.now();
      const searched = search(beforeFen, {
        maxDepth: SETTINGS.searchMaxDepth,
        timeBudgetMs: SETTINGS.searchBudgetMs,
      });
      const wall = performance.now() - searchStarted;
      if (!searched) {
        errors.push(`ply ${ply}: search returned null with ${legal.length} legal moves`);
        break;
      }
      const pvError = principalVariationError(beforeFen, searched, Chess);
      if (pvError) {
        pvFailures++;
        errors.push(`ply ${ply}: ${pvError}`);
        break;
      }
      searchTimes.push(wall);
      searchDepths.push(searched.depth);
      if (searched.depth === 0) zeroDepth++;
      chosen = { ...searched.move, san: searched.san };
      source = `search(d${searched.depth})`;
    }

    const legalMove = legal.find((move) =>
      move.from === chosen.from
      && move.to === chosen.to
      && (move.promotion || '') === (chosen.promotion || '')
    );
    if (!legalMove) {
      illegal++;
      errors.push(`ply ${ply}: ${source} returned illegal ${chosen.from}-${chosen.to}`);
      break;
    }
    if (chosen.san && chosen.san !== legalMove.san) {
      errors.push(`ply ${ply}: SAN mismatch ${chosen.san} != ${legalMove.san}`);
      break;
    }

    if (ply === 4 || ply === 17 || ply === 38) {
      auditLabels({
        gameIndex,
        ply,
        fen: beforeFen,
        rankMoves,
        scoreSituation,
        moveQuality,
        MATE,
        samples: annotationSamples,
      });
    }

    const independent = new Chess(beforeFen);
    const moveInput = {
      from: legalMove.from,
      to: legalMove.to,
      ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}),
    };
    const independentMove = independent.move(moveInput);
    const played = game.move(moveInput);
    if (!played || !independentMove) {
      illegal++;
      errors.push(`ply ${ply}: legal move rejected during replay`);
      break;
    }

    const afterFen = game.fen();
    const fenOk =
      afterFen === legalMove.after
      && independent.fen() === afterFen
      && independentMove.after === afterFen
      && new Chess(afterFen).fen() === afterFen
      && game.history().length === beforeHistoryLength + 1
      && game.turn() !== beforeTurn
      && played.san === legalMove.san;
    if (!fenOk) {
      fenMismatch++;
      errors.push(`ply ${ply}: FEN/history/turn mismatch after ${legalMove.san}`);
      break;
    }

    sans.push(played.san);
    const key = positionKey(afterFen);
    const visits = (seen.get(key) || 0) + 1;
    seen.set(key, visits);
    if (visits >= 3) {
      guard = game.isThreefoldRepetition()
        ? '1/2-1/2 threefold'
        : 'audit repetition guard';
      break;
    }
  }

  if (!guard && !game.isGameOver() && sans.length >= SETTINGS.maxPlies) {
    guard = 'audit max-plies';
  }
  const counts = [...seen.values()];
  const repeatVisits = counts.reduce((sum, value) => sum + Math.max(0, value - 1), 0);
  return {
    game: gameIndex + 1,
    seed,
    result: classifyTerminal(game, guard),
    plies: sans.length,
    opening,
    illegal,
    fenMismatch,
    pvFailures,
    errors,
    elapsedMs: performance.now() - started,
    searchCalls: searchTimes.length,
    searchAvgMs:
      searchTimes.length > 0
        ? searchTimes.reduce((sum, value) => sum + value, 0) / searchTimes.length
        : 0,
    searchP95Ms: quantile(searchTimes, 0.95),
    searchMaxMs: Math.max(0, ...searchTimes),
    avgDepth:
      searchDepths.length > 0
        ? searchDepths.reduce((sum, value) => sum + value, 0) / searchDepths.length
        : 0,
    minDepth: searchDepths.length > 0 ? Math.min(...searchDepths) : 0,
    maxDepth: searchDepths.length > 0 ? Math.max(...searchDepths) : 0,
    zeroDepth,
    uniquePositions: seen.size,
    repeatVisits,
    maxOccurrence: Math.max(...counts),
    uniqueRatio: seen.size / (sans.length + 1),
    lineHash: crypto.createHash('sha256').update(sans.join(' ')).digest('hex').slice(0, 12),
    sans,
    finalFen: game.fen(),
  };
}

function printReport(reports, annotationSamples, wallMs) {
  for (const report of reports) {
    console.log(
      `G${String(report.game).padStart(2, '0')} seed=${report.seed}`
      + ` result=${report.result} plies=${report.plies}`
      + ` opening=${report.opening.join(' ')}`
      + ` illegal=${report.illegal} fenMismatch=${report.fenMismatch}`
      + ` pvFailures=${report.pvFailures}`
      + ` errors=${report.errors.length}`
      + ` search=${report.searchCalls}`
      + ` avg/p95/max=${report.searchAvgMs.toFixed(1)}/${report.searchP95Ms.toFixed(1)}`
      + `/${report.searchMaxMs.toFixed(1)}ms`
      + ` depth=${report.avgDepth.toFixed(2)}[${report.minDepth}-${report.maxDepth}]`
      + ` d0=${report.zeroDepth}`
      + ` repeatVisits=${report.repeatVisits} maxOcc=${report.maxOccurrence}`
      + ` unique=${(report.uniqueRatio * 100).toFixed(1)}%`
      + ` elapsed=${report.elapsedMs.toFixed(0)}ms hash=${report.lineHash}`,
    );
    if (report.errors.length > 0) console.log(`  errors: ${report.errors.join(' | ')}`);
  }

  const pairPrefixes = [];
  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      pairPrefixes.push(commonPrefix(reports[i].sans, reports[j].sans));
    }
  }
  const totalSearchCalls = reports.reduce((sum, report) => sum + report.searchCalls, 0);
  const weightedSearchMs = reports.reduce(
    (sum, report) => sum + report.searchAvgMs * report.searchCalls,
    0,
  );
  const results = Object.fromEntries(
    [...new Set(reports.map((report) => report.result))].map((result) => [
      result,
      reports.filter((report) => report.result === result).length,
    ]),
  );
  const annotationFailures = annotationSamples.filter((sample) => !sample.ok);
  const summary = {
    settings: SETTINGS,
    games: reports.length,
    abnormalGames: reports.filter(
      (report) => report.illegal || report.fenMismatch || report.errors.length,
    ).length,
    illegalMoves: reports.reduce((sum, report) => sum + report.illegal, 0),
    fenMismatches: reports.reduce((sum, report) => sum + report.fenMismatch, 0),
    pvFailures: reports.reduce((sum, report) => sum + report.pvFailures, 0),
    totalPlies: reports.reduce((sum, report) => sum + report.plies, 0),
    results,
    searchCalls: totalSearchCalls,
    weightedSearchAvgMs: totalSearchCalls > 0 ? weightedSearchMs / totalSearchCalls : 0,
    maxSearchMs: Math.max(...reports.map((report) => report.searchMaxMs)),
    zeroDepthSearches: reports.reduce((sum, report) => sum + report.zeroDepth, 0),
    uniqueOpenings: new Set(reports.map((report) => report.opening.join(' '))).size,
    uniqueLines: new Set(reports.map((report) => report.lineHash)).size,
    pairwiseCommonPrefixAvg:
      pairPrefixes.reduce((sum, value) => sum + value, 0) / pairPrefixes.length,
    pairwiseCommonPrefixMax: Math.max(...pairPrefixes),
    repeatVisits: reports.reduce((sum, report) => sum + report.repeatVisits, 0),
    maxPositionOccurrence: Math.max(...reports.map((report) => report.maxOccurrence)),
    annotationSamples: annotationSamples.length,
    annotationFailures: annotationFailures.length,
    wallMs,
  };
  console.log('--- aggregate ---');
  console.log(JSON.stringify(summary, null, 2));

  console.log('--- annotation sample (index.html functions fed rankMoves scores) ---');
  for (const sample of annotationSamples.slice(0, 18)) {
    console.log(
      `G${sample.game} ply=${sample.ply} turn=${sample.turn} ${sample.san}`
      + ` score=${sample.score} best=${sample.bestScore}`
      + ` situation=${sample.situation} quality=${sample.quality}`
      + ` ordered=${sample.ordered} ok=${sample.ok}`,
    );
  }
  if (annotationFailures.length > 0) {
    console.log('annotation failures:', JSON.stringify(annotationFailures.slice(0, 10), null, 2));
  }
  return summary;
}

async function main() {
  const auditStarted = performance.now();
  const { Chess, MATE, rankMoves, search } = await loadEngine();
  const { scoreSituation, moveQuality } = loadScoreLanguage(MATE);
  const annotationSamples = [];
  const reports = SETTINGS.seeds.slice(0, SETTINGS.games).map((seed, gameIndex) =>
    playOne({
      gameIndex,
      seed,
      Chess,
      MATE,
      rankMoves,
      search,
      scoreSituation,
      moveQuality,
      annotationSamples,
    })
  );
  const summary = printReport(reports, annotationSamples, performance.now() - auditStarted);
  const failed =
    summary.games !== SETTINGS.games
    || summary.abnormalGames !== 0
    || summary.illegalMoves !== 0
    || summary.fenMismatches !== 0
    || summary.pvFailures !== 0
    || summary.annotationFailures !== 0;
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error('self-play 审计脚本失败:', error);
  process.exitCode = 2;
});
