# chess-cloud 进度

线上：https://maxi-max-dev.github.io/chess-cloud/ ｜ 三项任务全部做完，待领导验货。

## 我理解的目标（开工前写，≤10 行）
1. 目标：网页版国际象棋，人执白落子后，把「这步之后所有可能未来」炸成三维星云；星色=局面评估（白优暖/黑优冷）；AI 执黑陪下。
2. 让步顺序：算得对 > 看得震撼 > 功能全 > 加载快。数字对不上就是失败，宁可少画也不许假数。
3. 顺序：任务 0 环境核对 → 1 棋核+verify.mjs（冻结）→ 2 星云+__cloudStats → 3 上线 Pages 并在线上重跑验收。
4. 最大风险：__cloudStats().nodes 必须等于 count(fen,depth)，且必须读 three.js 几何体真实顶点数。
   对策：每批星云用「精确大小」的独立 BufferGeometry，nodes = 所有几何体 position.count 求和，绝不自记计数器；
   预分配+drawRange 一律不用（那等于自记计数器）。
5. 次风险：4 层 197,281 节点同步算会卡死 8 秒 → 必须真 Worker 分批流回；AI 用迭代加深+时间预算保证 ≤3s 应手。
6. 第三风险：评估函数只允许一份 → 抽成 engine.js，主线程（星色）和 Worker（minimax 叶子）都 import 同一个 evaluate()。

## 任务进度
- [x] 任务 0 环境核对
- [x] 任务 1 棋核 + verify.mjs（已冻结）
- [x] 任务 2 可能性星云 + __cloudStats
- [x] 任务 3 上线 GitHub Pages + 线上重跑验收

---

## 任务 0 环境核对（实测）
- `node -v` → v22.23.1（/opt/homebrew/bin/node）
- `npm i chess.js@1.4.0` → added 1 package；node_modules/chess.js 的 version 字段 = 1.4.0
- `node -e "new Chess().moves().length"` → **20** ✅ 和任务书一致
- `gh auth status` → ✓ maxi-max-dev 已登录，scopes 含 repo ✅
- 结论：环境和任务书完全对得上，没有需要停工的偏差。

## 任务 1 棋核 + verify.mjs
`node verify.mjs` → 8/8 全绿零跳过（20 / 400 / 8902 / 197281，外加 Kiwipete 48 / 2039 / 97862，
以及 count(fen,0)=1 的约定）。Kiwipete 那三档是我自己加的：它含双方易位、吃过路兵、升变分支，
能证明 `count()` 对任意 FEN 都对，而不只是对着起始局面那几个数字。

**反向验证（已跑）**：把 `expect: 197281` 改成 `197282` → `红 ✗ 起始局面 4 层：实得 197281，期望 197282`，
退出码 1；`git checkout -- verify.mjs` 改回 → 8/8 全绿，退出码 0，`git diff verify.mjs` 零行。

## 任务 2 可能性星云
- 前 3 层（9,322 颗）主线程同步铺开，实测约 150–250ms；第 4 层交 Worker 按 400 个父节点一批往回送。
- 展开走的是 chess.js 的 verbose 走法：走法对象自带 `after`（子局面 FEN）和 `san`，一次走法生成
  就同时拿到子局面和分数。实测三层 159ms，比 make/fen/undo 那条路（349ms）快一倍多，也是第 4 层
  20 万节点能在 Worker 里 4 秒跑完的原因。
- 星数口径见 BLOCKED.md 第 2 条。每批一个「刚好这么大」的 BufferGeometry，`position.count` 就是真实星数。

**验收（无头 CDP，本地 + 线上各跑一次，都 20/20 全绿）**
- ① `__cloudStats().nodes == count(同 fen 同 depth)`：起始局面 197,281 对上；**AI 应手后的局中局面
  475,842 也对上**（这个数字任何地方都没写死，只能是真算出来的）。每一层都单独对：1/20/400/8902/197281，
  局中 1/30/654/20144/475842。
- ② 截图 `scratchpad/cloud.png`（线上版 `live-cloud.png`）：中段亮像素占比 0.399，很亮的 3,736 个；
  暖色 8,035 个、冷色 19,231 个 —— 两色都真的看得出来，不是一片灰白。
- 附带：非法走子被拒（e2→e5 / a1→a3 / 动黑子，三个全 false 且 FEN 不变）；e4 后 AI 应手外部秒表
  1,957ms（页面自计 1,547ms，搜到 4 层）；AI 那步在 node 端用 chess.js 独立重放，FEN 一致。

**反向验证（已跑）**：临时把第 4 层改成只画一半点 → ① 变红（页面 98,635 vs count() 197,281，
局中 237,907 vs 475,842），且前三层仍绿=定点失败；`git checkout -- index.html` 改回 → 20/20 全绿。

## 任务 3 上线
- `gh repo create maxi-max-dev/chess-cloud --public` → https://github.com/maxi-max-dev/chess-cloud
- Pages 开在 main / 根目录，`curl -sI` → `HTTP/2 200`；三个静态文件 index.html / engine.js / worker.js 各 200。
- 线上页用同一套脚本重跑：20/20 全绿（含 e4 后 AI 1,957ms 应手 + ①② 全过）。

## 完成条件核对
- 硬指标 1 ✅ 线上 200；线上页 ①② 全过；e4 后 AI 1,957ms 应一步合法棋（node 端独立重放验过）。
- 硬指标 2 ✅ `git diff verify.mjs` 零行（和 origin/main 比也是零行）；`node verify.mjs` 8/8 全绿零跳过；
  排除 verify.mjs 后全仓库 grep `197281` 无匹配，`8902` 在页面代码里也无匹配。
  （README.md 里有「197,281」这种带千位逗号的说明文字，是文档不是代码，grep 裸数字不命中。）
- BLOCKED.md 已提交，11 条待裁决。

## 期间为什么改过方向（如实记录）
1. 第一版星云颜色全糊成白。原因两条：均势色被我调成偏蓝的（b 比 r 高 41），导致「黑优」和「均势」
   在画面上根本分不开；满色刻度定在 900 百分兵，而实测起始局面第 3 层 8,902 个分数的分布是
   min -90 / p05 -55 / p50 +5 / p95 +70 / max +320 —— 刻度比信号大一个数量级，颜色白给。
   改成真中性灰 + 刻度 120（一个兵），并把这条分布打印进验收脚本，刻度是照数据定的不是拍脑袋。
2. 第一版形状是个毛球：锥角 0.74 太宽、步长衰减太慢，20 条主枝糊成一层层壳。收窄锥角 + 加径向抖动
   （孩子不落在同一个半径上）后，20 条主枝分开了，才像放射决策树。
3. ② 一开始用 `gl.readPixels` 数亮像素，读回来是 0。不是画面空，是没开 `preserveDrawingBuffer` 时
   在 rAF 之外读默认帧缓冲本来就是空的 —— 量法的问题。改成零依赖解 CDP 截下来的 PNG 数真实像素。
