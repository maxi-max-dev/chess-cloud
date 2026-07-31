// portal-check.mjs —— 双棋种入口与静态路由契约。
// 行为/触控另由 live-check.mjs 与 xiangqi-live-check.mjs 在真 Chrome 中验。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const results = [];

function record(ok, name, detail = '') {
  results.push({ ok: Boolean(ok), name, detail });
  console.log(`${ok ? '绿 ✓' : '红 ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(name) {
  const file = path.join(ROOT, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

const portal = read('index.html');
const chess = read('chess.html');
const xiangqi = read('xiangqi.html');

record(Boolean(portal), '根首页存在');
record(
  /href=["']\.?\/?chess\.html["'][^>]*data-game=["']chess["']|data-game=["']chess["'][^>]*href=["']\.?\/?chess\.html["']/.test(portal),
  '根首页有国际象棋入口',
);
record(
  /href=["']\.?\/?xiangqi\.html["'][^>]*data-game=["']xiangqi["']|data-game=["']xiangqi["'][^>]*href=["']\.?\/?xiangqi\.html["']/.test(portal),
  '根首页有中国象棋入口',
);
record(
  (portal.match(/data-game=["'](?:chess|xiangqi)["']/g) || []).length === 2,
  '首页恰好呈现两个棋种选择',
);
record(
  portal.includes('国际象棋') && portal.includes('中国象棋'),
  '两个入口都用清楚的中文名称',
);

record(
  chess.includes("from './engine.js'") && chess.includes("new Worker('./worker.js'"),
  '国际象棋独立页面仍接原棋核与 Worker',
);
record(
  chess.includes('window.__test') && !chess.includes('data-game="xiangqi"'),
  '国际象棋验收钩子保留且未混入另一套规则',
);
record(
  (xiangqi.includes("from './xiangqi-engine.js'") || xiangqi.includes("import('./xiangqi-engine.js')"))
    && xiangqi.includes("new Worker('./xiangqi-worker.js'"),
  '中国象棋独立页面接自己的棋核与 Worker',
);
record(
  xiangqi.includes('__xiangqiTest') && /data-xq-board/.test(xiangqi),
  '中国象棋页面公开只读验收钩子和棋盘标记',
);

const forbidden = ['8902', '197281'];
for (const file of ['index.html', 'chess.html', 'engine.js', 'worker.js', 'xiangqi.html', 'xiangqi-engine.js', 'xiangqi-worker.js']) {
  const source = read(file);
  record(
    forbidden.every((number) => !source.includes(number)),
    `${file} 未把国际象棋基线数字写死进页面/运行代码`,
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '未通过' : '全绿'}：${results.length - failed.length}/${results.length} 项通过，零跳过。`);
if (failed.length) process.exitCode = 1;
