#!/usr/bin/env node
// verify.mjs —— 棋核验收脚本（任务 1 后冻结，git diff 必须为空）
//
// 干什么：用 chess.js 递归数「全树」，把结果和公认的 perft 标准值对撞。
// count(fen, depth) 也导出给线上验收用：拿它去和页面 __cloudStats().nodes 对数。
//
// 跑法：node verify.mjs
// 退出码 0 = 全绿；1 = 有红。

import { Chess } from 'chess.js';

const START_FEN = new Chess().fen();
// Kiwipete：公认的 perft 测试局面，含双方易位、吃过路兵、升变分支，专门用来抓走法生成的漏洞
const KIWIPETE_FEN = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

/**
 * 递归数全树：fen 局面下，正好走满 depth 步能到达的合法局面总数（即 perft(depth)）。
 * depth = 0 时约定为 1（就是根局面自己）。
 */
export function count(fen, depth) {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`depth 必须是非负整数，收到 ${depth}`);
  }
  if (depth === 0) return 1;
  return walk(new Chess(fen), depth);
}

function walk(game, depth) {
  const moves = game.moves({ verbose: true });
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) {
    game.move({ from: m.from, to: m.to, promotion: m.promotion });
    total += walk(game, depth - 1);
    game.undo();
  }
  return total;
}

const CASES = [
  { label: '起始局面 1 层（走法数）', fen: START_FEN, depth: 1, expect: 20 },
  { label: '起始局面 2 层', fen: START_FEN, depth: 2, expect: 400 },
  { label: '起始局面 3 层', fen: START_FEN, depth: 3, expect: 8902 },
  { label: '起始局面 4 层', fen: START_FEN, depth: 4, expect: 197281 },
  { label: 'Kiwipete 1 层', fen: KIWIPETE_FEN, depth: 1, expect: 48 },
  { label: 'Kiwipete 2 层', fen: KIWIPETE_FEN, depth: 2, expect: 2039 },
  { label: 'Kiwipete 3 层', fen: KIWIPETE_FEN, depth: 3, expect: 97862 },
];

function main() {
  console.log(`chess.js 起始 FEN: ${START_FEN}`);
  let failed = 0;
  for (const c of CASES) {
    const t0 = performance.now();
    let got, err = null;
    try {
      got = count(c.fen, c.depth);
    } catch (e) {
      err = e;
    }
    const ms = (performance.now() - t0).toFixed(0);
    if (err) {
      failed++;
      console.log(`红 ✗ ${c.label}：抛异常 ${err.message}`);
    } else if (got === c.expect) {
      console.log(`绿 ✓ ${c.label}：${got}（期望 ${c.expect}，${ms}ms）`);
    } else {
      failed++;
      console.log(`红 ✗ ${c.label}：实得 ${got}，期望 ${c.expect}（${ms}ms）`);
    }
  }
  // count(fen, 0) 的约定也一起断言，页面把根局面当第 0 层画
  const zero = count(START_FEN, 0);
  if (zero === 1) {
    console.log(`绿 ✓ 第 0 层（根局面自己）：1`);
  } else {
    failed++;
    console.log(`红 ✗ 第 0 层（根局面自己）：实得 ${zero}，期望 1`);
  }

  console.log('');
  if (failed === 0) {
    console.log(`全绿：${CASES.length + 1}/${CASES.length + 1} 项通过，零跳过。`);
    process.exit(0);
  } else {
    console.log(`有红：${failed} 项失败。`);
    process.exit(1);
  }
}

// 只有直接 node verify.mjs 才跑断言；被 import 时只提供 count()
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
