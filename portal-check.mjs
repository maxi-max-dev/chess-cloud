// portal-check.mjs —— 双棋种入口与静态路由契约。
// 行为/触控另由 live-check.mjs 与 xiangqi-live-check.mjs 在真 Chrome 中验。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_RESULTS = 27;
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
const sharedUi = read('future-map.css');

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
  portal.includes('棋局未来地图')
    && (portal.match(/同一张未来地图/g) || []).length === 2,
  '首页用同一个产品定位介绍两套规则',
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
    && xiangqi.includes("new Worker('./xiangqi-worker.js?v=p0.5.0'"),
  '中国象棋独立页面接自己的棋核与 Worker',
);
record(
  xiangqi.includes('__xiangqiTest') && /data-xq-board/.test(xiangqi),
  '中国象棋页面公开只读验收钩子和棋盘标记',
);
record(
  Boolean(sharedUi)
    && chess.includes("href=\"./future-map.css\"")
    && xiangqi.includes("href=\"./future-map.css\""),
  '两套棋共用同一份未来地图视觉语法',
);
record(
  /data-future-map[^>]*data-game=["']chess["']/.test(chess)
    && /data-future-map[^>]*data-game=["']xiangqi["']/.test(xiangqi),
  '两页都声明同形的未来地图根节点',
);
record(
  chess.includes('window.__futureTest')
    && xiangqi.includes('window.__futureTest')
    && chess.includes('data-future-context')
    && xiangqi.includes('data-future-context'),
  '两页都公开同形选路状态并提供唯一的路线语境栏',
);
record(
  [chess, xiangqi].every((source) =>
    source.includes('data-future-preview')
      && source.includes('data-preview-phase')
      && source.includes('data-preview-root-fen')
      && source.includes('data-preview-display-fen')
      && source.includes('data-preview-line-id')
      && source.includes('data-preview-step-index')
      && source.includes('data-preview-step-count')),
  '两页主棋盘都声明同形的两段路线预演状态',
);
record(
  [chess, xiangqi].every((source) =>
    source.includes('data-future-motion-piece')
      && source.includes('data-future-preview-step'))
    && sharedUi.includes('data-future-motion-piece')
    && sharedUi.includes('prefers-reduced-motion'),
  '两页共用真棋子运动、静态路线与减少动态协议',
);
record(
  [chess, xiangqi].every((source) =>
    source.includes('data-future-reply-list')
      && source.includes('data-future-reply-option')
      && source.includes('data-reply-count')
      && source.includes('data-engine-suggested')
      && source.includes('await-reply')
      && source.includes('conditional-playing')
      && source.includes('conditional-settled')
      && source.includes('conditional-static')
      && /id=["'](?:futureClear|xqClearPreview)["']/.test(source)
      && !/<[^>]*data-future-reply-list[^>]*aria-live=/i.test(source)
      && /(?:可能|假设)回应/.test(source))
    && sharedUi.includes('data-future-reply-list')
    && sharedUi.includes('data-future-reply-option'),
  '两页都完整保留不确定回应协议，国际显式选线、中国可由零点击主线先演后接管',
);

const xiangqiFutureNode = xiangqi.match(
  /function futureNodeData\([\s\S]*?(?=\nfunction buildFutureReplyOptions)/,
)?.[0] || '';
const xiangqiReplyBuilder = xiangqi.match(
  /function buildFutureReplyOptions\([\s\S]*?(?=\nfunction orderedFutureReplies)/,
)?.[0] || '';
const xiangqiKnownLegal = xiangqi.match(
  /function applyKnownLegal\([\s\S]*?(?=\nfunction play)/,
)?.[0] || '';
record(
  xiangqiFutureNode.includes('currentMoves.find')
    && xiangqiFutureNode.includes('applyKnownLegal(position, legalMove)')
    && !xiangqiFutureNode.includes('applyOn(position, move)')
    && xiangqiReplyBuilder.includes('applyKnownLegal(parent, move)')
    && !xiangqiReplyBuilder.includes('applyOn(parent, move)')
    && /api\.applyMove\(positionBefore, legalMove, \{ validate: false \}\)/.test(xiangqiKnownLegal),
  '中国象棋节点和回应批量复用已校验合法着，不在主线程重复生成同一父局面',
);

record(
  ['positionKey', 'positionId', 'requestId', 'runId'].every((name) => xiangqi.includes(name))
    && xiangqi.includes('dataset.previewPositionId')
    && xiangqi.includes('dataset.previewRunId')
    && xiangqi.includes('playback.positionId === Number(expectedPositionId)')
    && xiangqi.includes('playback.runId === Number(expectedRunId)'),
  '中国象棋云演显式区分四种身份，动画回调同时校验 positionId + runId',
);

record(
  xiangqi.includes('AUTOPLAY_BUDGET_MS = 8000')
    && [chess, xiangqi].every((source) =>
      source.includes('PREVIEW_PLY_MIN = 1')
        && source.includes('PREVIEW_PLY_MAX = 10')
        && source.includes('PREVIEW_PLY_DEFAULT = 4')
        && source.includes('let previewPly = PREVIEW_PLY_DEFAULT')
        && source.includes('setPreviewDepth')
        && /<select id="(?:chess|xq)PreviewDepth"/.test(source)
        && (source.match(/<option value="(?:[1-9]|10)"/g) || []).length === 10)
    && xiangqi.includes("recordAutoplayEvent('motion_committed'")
    && xiangqi.includes("recordAutoplayEvent('landing_impact'")
    && xiangqi.includes("recordAutoplayEvent('threats_revealed'")
    && xiangqi.includes('previewTiming(frames.length)')
    && xiangqi.includes("document.addEventListener('visibilitychange'")
    && xiangqi.includes('IntersectionObserver')
    && xiangqi.includes("event.key === ' '")
    && xiangqi.includes("event.key === 'Escape'")
    && xiangqi.includes('touchGuard')
    && xiangqi.includes('id="xqReturnToPlay"')
    && xiangqi.includes('id="xqAdoptPreview"')
    && [chess, xiangqi].every((source) =>
      source.includes("addEventListener('pointerover'")
        && source.includes("addEventListener('focusin'"))
    && chess.includes('id="chessReturnToPlay"')
    && chess.includes('id="chessAdoptPreview"')
    && [portal, chess, xiangqi].every((source) =>
      source.includes('rel="icon" href="data:image/svg+xml')),
  '两棋种包含 1–10 ply 悬停连演、默认 4 ply、零点击云演、原子时序、键盘与移动端保护',
);

const forbidden = ['8902', '197281'];
for (const file of ['index.html', 'chess.html', 'future-map.css', 'engine.js', 'worker.js', 'xiangqi.html', 'xiangqi-engine.js', 'xiangqi-worker.js']) {
  const source = read(file);
  record(
    forbidden.every((number) => !source.includes(number)),
    `${file} 未把国际象棋基线数字写死进页面/运行代码`,
  );
}

if (results.length !== EXPECTED_RESULTS) {
  record(
    false,
    '验收项总数没有静默缩水或意外膨胀',
    `运行到 ${results.length} 项，应为固定 ${EXPECTED_RESULTS} 项`,
  );
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '未通过' : '全绿'}：${results.length - failed.length}/${results.length} 项通过，零跳过。`);
if (failed.length) process.exitCode = 1;
