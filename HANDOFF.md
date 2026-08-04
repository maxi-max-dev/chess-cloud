# 交接文档 · chess-cloud

写给下一位接手的人（AI 或人类）。这份文档是自足的：**不需要问任何人，也不需要看聊天记录**。
截止 2026-08-03，项目已经定位为“一个棋局未来地图产品 + 两套独立真实棋核”：规则分开，
产品壳、视觉语法、路线状态和验收契约统一。

- 线上：https://maxi-max-dev.github.io/chess-cloud/
- 仓库：https://github.com/maxi-max-dev/chess-cloud（`main`，GitHub Pages 从根目录发布）
- 本地：`~/code/chess-cloud`
- 公开署名只写 **Max**

---

## 0. 三十秒看懂

根首页先选择规则，但进入的是同一个产品：

1. `chess.html`：国际象棋，人执白、AI 执黑。3D 全景、2D 推演树、五列分叉和棋子助手都读取
   同一条预演路线。
2. `xiangqi.html`：中国象棋，人执红、AI 执黑。真正的 9×10 规则核；3D 感全景与 2D 推演树
   共用同一个候选、全部合法回应、分析建议和走后局面。
3. `future-map.css`：两页共用的产品壳、颜色角色、图例、路线语境栏与移动端行为。它不包含任何
   棋种规则。
4. 两页都以 `[data-future-map]` 声明当前规则 / 模式 / 阶段，并公开同形的
   `window.__futureTest` 只读验收契约。

产品目标不是展示两个各做各的棋盘，而是让用户一眼看到当前全部真实下一步，并把“已选择的动作”
与“未知的对手未来”分开。3D 全景负责“看全局”，2D 推演负责“读清路径”；切换视图不能改变实战
FEN 或丢失预演。国际象棋点击后继续由用户显式选择首步与条件回应；中国象棋 P0.3 会在首次加载 /
reset 后自动选择金色分析主线、连续云演 4 ply 并停住。两种棋的桌面候选都支持鼠标悬停或键盘
聚焦后自动连演 4 ply；悬停路线只属于预览，不会冒充用户选路或实战落子。所有合法回应仍完整可选，
换线会立刻接管。
两页的确认动作仍只提交第一步，任何预演都不改变实战。

国际象棋放大全景默认进入“跟随推演”：每选择一步，中央“正在看的局面”会成为新的几何根，从该
FEN 重新展开真实未来；过去路径退到根后方作为面包屑。空间布局使用严格向前的时间走廊与逐父节点
花束，不再把各层卷成同一团。顶部“全局总览”可随时切回以实战 FEN 为根，条件路径不会丢失。

视觉 Phase 1 已把两页统一到深空蓝紫层次。国际象棋使用单 Composer 的选择性 bloom 与加法混合，
只有真实线云和“现在”节点发光；`?cinema=1` 提供只留全屏云图与真值数字行的录屏模式。中国象棋
仍完全使用 SVG / CSS，没有引入 Three.js。

视觉 Phase 2 在这个静态底座上加入有限叙事：新线短暂定向流动；玩家落子后旧云向金色选线坍缩，
AI 思考脉冲与搜索并行，结果回来后从选线末端重生新云。所有变形只写共享 shader uniform，旧云
快照不进入 `layers` / `__cloudStats()`；页面隐藏、离开视口、切 2D 或减少动态都会暂停或定格，稳定后
继续保持零 rAF / WebGL frame。

视觉 Phase 3 把叙事收进棋子与界面细节：选中棋子有限呼吸 2 秒；位移完成后依次出现 400ms 落点
涟漪和 500ms 吃子碎裂；新面板只建立一次 200ms 扫描；悬停连演路径按 ply 逐段传导。视觉对象与
真实棋子 / FEN / 路径计数分账，减少动态时只保留静态语义。

**项目的灵魂仍然是“数字必须是真的”。** 页面说有多少棋子、合法走法、分叉或路径，就必须能从
当前局面 / DOM / geometry 现读，并由独立 Node 或真 Chrome 裁判重算。浅层排序只能叫分析建议，
不能叫预测或概率。

---

## 1. 接手先跑：绿是基线

```bash
cd ~/code/chess-cloud
npm install
```

### 1.1 快速固定裁判

```bash
npm test
```

它依次运行：

```text
node verify.mjs
node xiangqi-verify.mjs
node portal-check.mjs
```

当前期望输出：

- 国际象棋棋核：**8/8**
- 中国象棋棋核：**20/20**
- 统一产品入口 / 共享未来地图契约 / 运行代码红线：**27/27**

中国象棋起始局面 perft 必须是：

| 深度 | 局面数 |
|---|---:|
| 1 | 44 |
| 2 | 1,920 |
| 3 | 79,666 |
| 4 | 3,290,240 |

### 1.2 真 Chrome 验收

```bash
node live-check.mjs
node xiangqi-live-check.mjs
```

当前本地期望：

- 国际象棋：**116/116**
- 中国象棋：**72/72**

两条脚本都会自己起本地静态服务和无头 Chrome。国际象棋脚本的本地目标已经改为
`chess.html`；中国象棋脚本会从根首页实际点击两张卡，验证路由后再进入 `xiangqi.html`。
它们都覆盖手机尺寸、真实触控、Worker 应手、合法重放和页面零 JS 错误。

### 1.3 固定 10 局稳定性审计

```bash
node self-play.mjs
node xiangqi-self-play.mjs
```

这两条是正确性 / 稳定性冒烟，**不是棋力基准**。最新国际象棋真实输出为 10 局 / 767 plies /
727 次搜索，`abnormalGames / illegalMoves / fenMismatches / pvFailures / annotationFailures`
全为 0。
最新中国象棋真实输出：

- 10 局、788 plies、788 次搜索、1,428 个 PV 节点；
- 6 局到真实终局，4 局达到 100 plies 测试上限并如实记作 `capped`；
- `illegalMoves=0`
- `fenMismatches=0`
- `pvFailures=0`
- `branchFailures=0`
- `threatFailures=0`
- 单次搜索最大 29.9ms

> `npm test` 不包含两套真 Chrome 和两套自对弈。发布前不能只跑 `npm test`。

---

## 2. 文件职责与数据流

### 2.1 路由与文件

| 文件 | 职责 |
|---|---|
| `index.html` | 统一产品首页；恰好两个真实规则入口 |
| `future-map.css` | 两页共用的产品壳、路线颜色、图例、语境栏和响应式规则 |
| `portal-check.mjs` | 首页、共享样式、同形未来地图根 / 状态契约和运行代码红线的 27 项静态裁判 |
| `package.json` | `npm test` 与两套棋种验收快捷命令 |
| `chess.html` | 国际象棋 UI；3D 全景、2D 推演、五列分叉、棋盘和同一路线语境 |
| `engine.js` | 国际象棋唯一评估函数、排序、威胁、搜索、PV 和路径展开 |
| `worker.js` | 国际象棋 AI search Worker / cloud Worker 的共同入口 |
| `verify.mjs` | 国际象棋 perft / 棋核裁判 |
| `live-check.mjs` | 国际象棋 116 项真 Chrome 裁判；支持三阶段专项与 `--shot` 存档 |
| `self-play.mjs` | 国际象棋固定 10 局稳定性审计 |
| `xiangqi.html` | 中国象棋 9×10 UI；3D 感全景、2D 推演、可能回应、路线后果、实战历史和威胁 |
| `xiangqi-engine.js` | 中国象棋规则、唯一评估函数、排序、威胁、搜索与 PV |
| `xiangqi-worker.js` | 中国象棋搜索 / 分叉 / 分析 Worker 入口 |
| `xiangqi-verify.mjs` | 中国象棋 20 项棋核 / 搜索 / 固定分支事实裁判 |
| `xiangqi-live-check.mjs` | 中国象棋 72 项真 Chrome / 零点击与悬停云演 / 完整全景 / 身份隔离 / 视觉 / 路由 / 威胁 / 手机裁判 |
| `xiangqi-self-play.mjs` | 中国象棋固定 10 局稳定性审计 |
| `README.md` / `BLOCKED.md` / `PROGRESS.md` | 对外说明 / 决策边界 / 历史记录 |

没有构建工具、框架或后端。两套规则生成、评估和 Worker 刻意独立，不能混成条件分支全局状态；
产品壳、视觉角色和选路验收契约则刻意统一。国际象棋从 CDN 载入钉死版本的 chess.js / three.js；
中国象棋棋核为仓库内纯 ES module。

### 2.2 国际象棋对外契约

`engine.js` 的核心导出：

```js
export { Chess };
export const MATE = 100000;
export function evaluate(fen);
export function scoreChild(move);
export function expand(parentFens, opts);
export function rankMoves(fen, opts);
export function captureSquare(move);
export function currentAttacks(fen);
export function analyzeCandidateThreat(afterFen, movedSquare, replies);
export function search(fen, opts);
```

约束：

- `evaluate(fen)` 是国际象棋唯一评估函数，正数表示白优。
- `search()` 只公开最后一层完整搜完的 PV。每手带
  `san/from/to/promotion/after`；`depth=0` 必须 `pv=[]`。
- AI search Worker 与 cloud Worker 是两个实例，重开会 terminate / recreate，避免旧同步任务堵住新请求。
- 3D 路径 L1–L4 全在 cloud Worker 生成；主线程只用回传数组创建精确 geometry。
- 缩略只保留完整 L3；明确放大才计算 L4；完成后同层批次合并，收起 / 离屏 / 后台释放 L4。
- `__cloudStats()` 的路径数从真实非索引 `LineSegments.position.count / 2` 求和。
- `__forkStats()` 的卡片数从当前 SVG `g.card` 现数。
- 灰色是其他合法路线；蓝色只表示用户明确选择的预演；金色表示引擎分析建议，其中搜索 PV
  使用金色虚线并必须从搜索源 FEN 逐手验证；白色是实战历史，红色是吃子 / 威胁等直接后果。
  建议路线不能冒充用户选择。

一次真实落子：

```text
玩家确认合法着
  → chess.js 改 FEN、先画棋盘
  → searchWorker 搜黑方应手
  → thinking 期间旧分叉淡化 + inert，不计算会被替换的中间路径
  → Worker 回来后从搜索源 FEN 校验 move / PV
  → 落下黑方首着并真正绘制
  → 安装剩余金色 PV
  → 后续任务重建最终分叉与 cloud
```

### 2.3 中国象棋对外契约

`xiangqi-engine.js` 的公开 API：

```js
START_FEN, MATE
indexToSquare(), squareToIndex()
parseFen(), toFen()
generatePseudoMoves(), generateLegalMoves()
applyMove(), isInCheck(), getGameStatus()
evaluate(), moveToNotation(), getThreats()
search(), rankMoves()
```

局面对象：

```js
{
  board: Array(90),  // FEN 顺序：黑方底线 → 红方底线
  turn: 'w' | 'b',  // w = 红，b = 黑
  halfmove,
  fullmove
}
```

坐标采用常见引擎坐标：`a0` 是红方左下，`i9` 是黑方右上。

规则核已覆盖将 / 帅九宫与照面、士、象眼与不过河、马腿、车、炮架、兵卒过河、己方被将过滤、
将死和困毙。`evaluate()` 是中国象棋唯一评估函数，正数表示红优。`search()` 返回：

```js
{
  move, notation, score, depth, nodes, ms, pv,
  branchCount, branches
}
```

页面使用三个 `xiangqi-worker.js` 实例：

- `searchWorker`：黑方 AI，页面预算 1.1 秒，2.8 秒 watchdog；
- `branchWorker`：当前局面全部候选和浅层强回应；
- `previewWorker`：可取消的 1–10 ply 悬停连演，不排在分叉长任务后。

两者必须分开，否则较慢的分叉排序会把 AI 应手排在后面。reset 会同时重建两个实例。
搜索预算在引擎层钳到 2.4 秒，给消息传输 / 绘制留出 3 秒红线余量。

中国象棋 UI 的数量来自当前事实：

- 棋子数：`[data-piece]` / `[data-side]` 的实际 DOM；
- 合法落点：当前合法着生成结果与 `[data-target]`；
- 当前分叉：实际 `.branch-node` 数量；
- 节点分叉数：从该节点 `data-fen` 重新生成下一手合法着；
- 路径节点：实际 DOM 的 `data-fen/data-branches/data-ply`。

首次加载或 reset 会自动选择金色浅层分析主线，并按 1–10 ply 选择器连续云演；FEN 和实战路径
不变。所有真实回应仍完整列出，用户点任一候选 / 回应会立即接管并取消旧 run。3D 感全景必须在
44 个真实 L1 候选之外常驻展开当前整条主线，每一步携带真实父子 FEN 与走后合法分支数；点深层
节点只回看该步的预演投影，不改实战。全景与 2D 推演树必须保留同一个候选、回应集合和预演 FEN。
只有明确的首步确认按钮或棋盘合法落点才真正落子。排序会
看对方回应和一步合法回吃，但仍不是预测、胜率或概率。

`getThreats()` 表示几何攻击线，并列出攻击者 / 保护者。它不保证攻击者下一手有合法吃法，
也不代表被瞄准的棋一定会丢。

### 2.4 统一未来地图契约与 P0.3 身份协议

两页都必须提供：

- `[data-future-map]`：`data-game / data-mode / data-phase / data-route-owner / data-root-fen`；
- `[data-future-context]`：全页唯一的路线语境栏；
- `#board[data-future-preview]`：主棋盘路线预演协议；
- `window.__futureTest`：`schema / game / snapshot / selectNode / rewind / setMode / commitSelected`；
- `snapshot()`：`root / selectedPath / suggestedPath / frontier / preview / enginePath / rendered`。

国际象棋的 `selectedPath` 只能来自用户明确选路；中国象棋允许零点击云演把分析主线写进当前
`selectedPath`，但必须同时标明 autoplay / engine 语境，不能冒充真人选择或确定未来。根 FEN、根
分叉、每步 after FEN 和后续分叉必须能由独立棋核重放。`setMode()` 只能改变视图，不能改变实战
FEN、历史或预演路线。

国际象棋继续遵守显式选路契约；中国象棋在同一数据契约上增加默认自动选线。共同约束如下：

- 桌面鼠标停留 140ms 或近期键盘导航聚焦候选后，可从该候选自动接续最多 4 ply；换候选取消旧线，
  移出清理预览。触摸、按下和脚本恢复焦点不得误触发；悬停线进入 `preview.path`，但
  `selectedPath` 必须保持为空。

- 棋盘公开 `data-preview-phase / data-preview-root-fen / data-preview-display-fen /
  data-preview-line-id / data-preview-step-index / data-preview-step-count`；
- 国际象棋第一次选择只生成一拍并进入 `await-reply`，用户显式选回应后才进入
  `conditional-playing → conditional-settled`；
- 中国象棋自动主线从 `autoplay_started` 起连续 4 ply，并在 8 秒内进入稳定
  `conditional-settled`；减少动态对应 `conditional-static`。`frontier` 仍完整列出全部合法回应，
  自动选择只代表分析主线，不代表真人 / AI 必然如此；
- 每一拍都从实战根 FEN 用独立棋核重放，不得修改实战 FEN、历史或路径；
- 棋盘上每个静态路径使用 `[data-future-preview-step="you"]` 或
  `[data-future-preview-step="reply"]`，运动中的真实棋子使用
  `[data-future-motion-piece="true"]`；同一时刻最多一枚棋子移动；
- 每次选路或重播必须生成新的 `runId / data-preview-line-id`；运动完成回调必须同时校验
  `positionId + runId`，旧定时器、旧 `animationend` 和旧棋子不得推进新路线；
- 首拍播放期间，主图、2D 树、变体棋盘、回应条和测试钩子都不能跳进第二拍；首拍稳定后才同步解锁。
  快速切换已显式回应可以取消旧条件动画并生成新 line ID；
- 动画结束后停在最终推演局面供分析，主棋盘在整个预演期间只读；只有明确确认按钮能提交第一步。取消、
  reset 或实战变化必须重绘根局面；
- `prefers-reduced-motion: reduce` 下不播放位移：中国象棋自动静态投影四拍，国际象棋保持显式条件
  语义；播放中切换偏好也要立即收束，切回普通动态不能补播旧路线。

中国象棋的四类身份不可混用：

- `positionKey`：由规范 FEN 的棋盘布局与行棋方组成，是可比较的局面内容键；当前棋核没有历史，
  因而不声称它能区分长将 / 长捉责任。
- `positionId`：每次真实根局面建立、重置、实战落子、悔棋或测试装载时单调递增的实例号；同一个
  `positionKey` 在 reset 后也必须得到新的 `positionId`。
- `requestId`：一次当前局面候选分析请求；Worker 回包必须同时匹配请求号、请求时的
  `positionId` 与 `positionKey`。
- `runId`：一次预演 / 云演运行；暂停 / 继续保持同一 run，换线、退出、重置和新实战根都会使旧
  run 失效。

每拍顺序固定为：运动完成时原子提交预演 FEN → 落点脉冲 → 威胁 / 路线后果展开 → 下一拍。
页面隐藏或棋盘低于 60% 可见时只自动暂停，不擅自恢复；暂停会冻结任务、Web Animation 和剩余预算。

---

## 3. 八条红线

这些不是风格偏好，是产品地基。

1. **数量必须从当前渲染对象或局面现读，不许自记账。**
   - 国际象棋路径：真实非索引 `LineSegments.position.count / 2`。
   - 国际象棋 / 中国象棋卡片：当前 DOM `querySelectorAll(...).length`。
   - 中国象棋棋子 / 路径节点：当前 `[data-*]` 元素现数。
   - 不许预分配 buffer 再用 `drawRange` 冒充真实全量；不许用另一个计数器覆盖少画 / 漏画。

2. **不许把验证基线写死进运行页面。**
   - 国际象棋的 8,902 / 197,281 只能出现在裁判或文档。
   - 中国象棋的 perft 表只能出现在裁判或文档；页面不能拿常量 `44` 当起始分叉总数
     （CSS 中 `44px` 是触控尺寸，不是棋局基线）。
   - 运行以下命令必须全绿，而不是靠删检查：

   ```bash
   node portal-check.mjs
   ```

3. **不许改裁判来让实现变绿。**
   - `verify.mjs`、`xiangqi-verify.mjs`、`portal-check.mjs`、两套 live-check 都是裁判。
   - 允许新增断言；新增后要先让它对旧 / 故意破坏的实现红一次，再修实现，最后完整跑绿。
   - 不许降低期望项数、跳过失败分支、放宽数字或把真实错误改成日志。

4. **每个规则集只能有一份评估函数。**
   - 国际象棋只有 `engine.js::evaluate(fen)`。
   - 中国象棋只有 `xiangqi-engine.js::evaluate(position)`。
   - 两个棋种各一份是规则边界，不是重复实现；同一棋种再复制第二份才违反红线。

5. **重计算必须真的在对应 Worker 中完成。**
   - 国际象棋 L1–L4 路径展开不能移回主线程后假装分批回传。
   - 两个棋种的 AI 搜索都不能在主线程先算完再包装成 Worker 结果。
   - 中国象棋 search / branch Worker 必须隔离，不能让候选排序堵住 AI。

6. **AI 可见应手 ≤3 秒是硬上限。**
   - 国际象棋保留 1.0s / 0.9s 搜索预算、2.2s watchdog、合法 fallback、reset 重建 Worker。
   - 中国象棋保留 1.1s 页面预算、2.8s watchdog、引擎 2.4s 最大钳制与合法 fallback。
   - `depth=0` fallback 只能给合法着和空 PV，不能冒充已经搜索。

7. **不新增构建工具、框架或后端。**
   - 当前是可直接发布到 GitHub Pages 的静态文件。
   - 若要引入 WASM、外部职业引擎或后端，先在 `BLOCKED.md` 写清许可、体积、线程和降级方案。

8. **改完必须跑真实验收，并诚实表达规则边界。**
   - 行为变化必须加对应裁判 + 做反向验证。
   - 中国象棋没有历史状态，就不能用 `halfmove` 伪造长将 / 长捉 / 循环裁决或随意判和。
   - 几何威胁不能写成“必吃”或概率，浅层排序不能写成职业棋力。
   - 交付时贴实际输出，不写“理论上应该通过”。

运行代码红线检查的覆盖文件至少要包含：

```text
index.html
future-map.css
chess.html
engine.js
worker.js
xiangqi.html
xiangqi-engine.js
xiangqi-worker.js
```

---

## 4. 验收怎么扩

### 4.1 国际象棋

`verify.mjs` 固定 8 项：起始局面 20 / 400 / 8902 / 197281，Kiwipete
48 / 2039 / 97862，以及 `count(fen, 0) === 1`。

`live-check.mjs` 用 `EXPECTED_RESULTS = 116` 锁定 116 项，覆盖：

- L0–L4 真实 geometry、DOM 分叉数和 Node 独立 perft 对撞；
- 零 `THREE.Points`、无预分配 / drawRange / 隐藏孤儿对象；
- 3D / 2D 路径、真实变体棋盘、FEN 回合、蓝 / 金两条路线；
- 放大全景按当前推演 FEN 真正重根、全局总览无损切回、焦点 generation 隔离与时间走廊花束；
- 棋子 SVG 几何与真实像素，避免白棋因 Unicode / 字体回退变黑；
- 棋子助手、几何攻击、合法一步吃子、回吃和亏交换；
- 390×844、短横屏、平板、安全区、44px 触控；
- AI deadline、watchdog、reset / fallback / PV 和空闲零持续帧。
- 统一未来地图初始建议不冒充用户选路；选路 after FEN / 分叉可重放；2D / 3D 切换保留
  同一个预演且不改实战。
- 旧确认按钮不能绕过用户选路直接提交金色建议；清空路线后两个确认入口都必须重新禁用。
- 首拍只重放用户选择，回应条完整列出独立棋核生成的全部合法着；金色建议与蓝色已选回应分账。
- 首拍 `playing` 时，主 SVG、2D 树、变体棋盘、回应条和 `selectNode()` 都拒绝第二拍；
  `await-reply` 后同步解锁，不能出现只锁不解或测试钩子旁路。
- 显式回应后才播放条件分支；快速换回应、同路线重播与动态偏好切换均隔离旧代；取消和非法棋盘
  输入后 DOM / 协议同源，手机画中画与横向回应条可读。
- 普通分叉与全景树的“回到现在”清空投影 / 助手但不改实战，SVG 重建后恢复键盘焦点；预演棋盘
  的 64 格完全只读，回到实战才恢复合法键盘入口。
- 390px 主分叉可真实横滑并连续触摸五列，每一步的 FEN 和“共 N 种”都由 Node 独立重放；全景
  探索器保留三步自身边界，不能拿它替代五列验收。
- 用户提交首步、AI 实际应手后，棋子助手必须保留此前的分析上下文，并用蓝线标出真实结果；不能
  因清理旧预演而退回空闲态。
- 五列、2D 树、3D 标签与回应卡的鼠标悬停 / 键盘聚焦会自动安装合法 4 ply；路线不写入
  `selectedPath`，实战 FEN / history 不变，移出后清理。手机触摸仍按点击语义，画中画棋盘不拦截
  后方分叉和 PV 横滑。
- Phase 1 的单 Composer / bloom layer / 加法混合 / 独立“现在”节点与 `__cloudStats()` 真值隔离；
  bloom 开关截图同时锁定可见下限和不过曝上限；`?cinema=1` 的 1440×900 画布与数字行逐层对账。
- Phase 2 的共享 shader uniform 定向流动、零逐帧 geometry 写入、落子坍缩几何守恒、搜索并行、
  思考脉冲启停、末端重生、真实数字揭示，以及减少动态 / 静置归零。
- Phase 3 的 2 秒有限选中呼吸、运动完成后 400ms 落点涟漪、8–12 粒 / 500ms 吃子碎裂、一次性
  200ms 面板扫描和逐 ply 路径传导；视觉对象清理后棋子与路线真值必须不变。
- `--headed --phase-one-only` 用本机 GPU 跑 5 项视觉复核；默认完整套件继续使用
  `--headless=new + SwiftShader`，两条渲染路径的阈值分别实测。

数量钩子仍在 `chess.html` 的 `window.__test`；统一产品选路契约另由 `window.__futureTest` 暴露。
数量类只能从 DOM / geometry 返回。

### 4.2 中国象棋

`xiangqi-verify.mjs` 固定 20 项，覆盖：

- FEN 无损往返；
- 起始 perft 1–4；
- 马腿、象眼 / 不过河、炮架、兵过河、将帅照面；
- 将军、将死、困毙和非法着拒绝；
- 攻击者 / 保护者、唯一评估方向；
- search 合法 PV、真实根分叉、时限与 `depth=0,pv=[]`；
- 候选会看对方强回应与一步合法回吃，不把开局送炮换马排第一。
- 固定主线首步后的三种真实黑方分支事实：马、炮、卒的坐标与记谱均独立重放。

`xiangqi-live-check.mjs` 用 `EXPECTED_RESULTS = 71` 锁定 71 项，除原有裁判外新增覆盖：

- 首次加载零点击自动选择主线、连续提交 4 ply、8 秒内稳定，实战 FEN / 历史不变；
- `positionKey / positionId / requestId / runId` 生命周期与动画回调双重身份校验；
- `motion_committed → landing_impact → threats_revealed` 四拍顺序；
- 暂停 / 继续冻结 run 和预算，reset 后旧 run 回调被拒；
- `prefers-reduced-motion` 直接得到同一 4 ply 静态结果且没有运动棋子；
- 推演中 / 稳定后都显示“采纳首步继续 / 返回棋盘自己下”，返回后主棋盘立即恢复可操作。
- 独立 preview Worker 在鼠标悬停或键盘聚焦后安装合法 4 ply，`selectedPath` 为空、实战不变、
  `positionId / positionKey` 不变；移出或换线终止旧 Worker / run。
- 深空蓝紫 SVG / CSS 全景中根节点比深层分支更亮，蓝选路与金建议角色不变，页面资源中 Three.js
  数量继续为 0；桌面与 390×844 截图由 `--shot` 存档。
- 全景根节点与路线事实只从真实合法着 / 已绘制路径读取，300ms 收敛只揭示真值；减少动态不播放。

- 根首页两张卡可实际点击；
- 起始 32 枚棋、红 16 / 黑 16、90 个交互点；
- 起始 44 张分叉卡及每卡 FEN / 后续分叉与 Node 重放一致；
- 选棋 / 预演不改 FEN，真实落子后 Worker AI ≤3 秒且 PV 可重放；
- 连续两回合后路径 ply / FEN / 分叉继续前进，不会卡在第一步；
- 威胁固定局面、真实攻击者 / 保护者 / “攻→危”攻击流逐项同源；
- 上一步空起点 / 金色轨迹 / 落点 / 行棋文字与 Worker 真应手逐项同源；
- 双攻击者仍保留全部真线，只强调当前一条并可手动切换；
- 棋子位移、落点与威胁动效有限次停止，减少动态时仍保留全部静态语义；
- 棋子三层漆面、双刻线、静态纵深和红黑字色由 computed style 现读；选中 / 上一步内圈不能覆盖
  本体阴影，反向清空材质必须让同一条断言变红；
- 390px 字盘比例、667×375 紧凑双栏、缩放、reset 竞态、强杀 Worker 合法 fallback；
- 1440×900、390×844、667×375 无根横向溢出，非棋盘控件 ≥44px；
- 页面静止 `requestAnimationFrame` 请求 / 回调均不增长，零 JS 错误。
- 建议路线与用户选路分离；首拍后全部合法回应可由 Node 重放；全景 / 推演模式切换保留同一预演且不改 FEN。
- Worker 回包前先选路线时，只补建议标记和回应集合，不能自动推进第二拍；全景大幅拖动后 44 条
  真实下一步仍全部可见。
- 未选建议保持金色；即便路线会吃子，用户明确选中后仍以蓝色选路为最高视觉优先级。
- 首拍必须只有一条静态路径并进入 `await-reply`；显式点回应后才出现第二条路径，终局零回应进入
  `terminal`。预演期间主盘完全只读，只能由明确的首步确认按钮提交第一步。
- 回应列表在手机横滑与重绘后保留滚动、焦点和 ARIA 语义；不同路线快速切换、同路线重播和减少动态
  切换必须清掉旧代动画 / 定时器，最终 FEN 由 Node 独立重放对撞。
- “回到现在”恢复对应根候选焦点；每张回应卡显示的后续分叉数都必须与其 child FEN 的合法着数
  独立一致，不能只验证页面内部自洽。
- 2D 推演与 3D 感全景分别把“回到现在”的焦点送回当前可见的同一路线节点，不能聚焦隐藏视图。

规则 / DOM 钩子是 `window.__xiangqiTest`；统一产品选路钩子是 `window.__futureTest`。裁判不能
信任页面自报总数，必须从 DOM 和 `xiangqi-engine.js` 两边独立对撞。

### 4.3 已做过的反向验证

- 门户裁判先对旧单页运行：**8/16**，两条路由和中国象棋契约按预期报红；实现后 **16/16**。
- 中国象棋 live-check 首次运行：**30/31**，真实测出 `＋/－` 控件只有 40×44；修为 44×44 后
  完整 **31/31**。
- 本轮先把 5 条威胁 / 响应式断言加入旧页面：旧实现因找不到真实攻击箭头按预期超时变红；
  实现中间态为 **35/36**，唯一红项精确指出 390px 棋子直径小于棋盘宽度的 1/11；
  调整棋子与字号后一度为 **36/36**。
- 最终审查发现同步二次 render 会在首帧前销毁危险环 pulse，旧动效断言又会把无动画元素默认的
  `animationIterationCount=1` 误判为通过。加强为必须出现真实 animation 名 / 对象，并加入
  箭头几何可见性、多目标切换和横屏完整首屏后，旧实现按预期为 **35/37**；保留棋子 DOM 生命周期
  并收紧横屏后完整 **37/37**。
- 第二次审查用相邻一格的 `e5→e4` 证明固定 `5.2 + 6.1` 缩进会让短线反向；新增夹具后旧实现
  按预期为 **37/38**。箭头改为按中心距离动态缩进，短线使用紧凑 marker，最终 **38/38**。
  没有改 `verify.mjs` 或删旧项。
- 上一步 / 攻击流的 5 项新断言先对旧页面运行，按预期精确得到 **38/43**：Worker 应手无轨迹、
  空起点无标记、同权 V 形箭头无方向端点、没有有限落子动画，反向污染也无法建立真值基线。
  实现后 **43/43**；双攻击者夹具再核对主线 `0.94` / 背景 `0.22` 与 `1/2 → 2/2` 切换，
  任一 from/to 污染都会被同一 Node 独立真值断言抓住。
- 国际象棋历史反向验证的详细过程保留在 `PROGRESS.md`；`verify.mjs` 没有被放宽。
- 统一未来地图契约先加入门户和两套真机裁判，再完成实现。旧产品门户按预期为 **16/20**，前一版
  完成为 **21/21**。
- 本轮主棋盘路线预演继续先红后绿：旧两页跑门户为 **21/23**；旧中国象棋为 **48/51**，精确缺失
  主盘只读、同路线重播隔离和播放中减少动态；国际象棋旧版的新增预演分支也分别在 reset / 非法输入
  同源及播放中减少动态处报红。首次并行旧版总跑为 **91/95**，其中 3 项是预期新红项，另 1 项是
  独立复跑未复现的冷启动时序波动；随后用隔离污染页逐项确认了真正缺陷。
- 本轮未知回应协议先加裁判再改实现：旧门户精确为 **23/24**；旧中国象棋核心新增项精确为
  **51/54**，布局反向污染为 **53/54**；国际象棋旧版的三条新不确定性分支均定点报红。最终审查
  又用首拍期间的主 SVG / 2D 树 / 变体棋盘 / 测试钩子证明跨入口旁路，并在实现修复前保持红色。
- 中国象棋合法着复用红线加入后，临时恢复每个节点重复生成父局面合法着，门户精确为 **24/25**；
  恢复复用后为 **25/25**。两套回应卡的 `data-branch-count` 也由 child FEN 独立重算。
- P0.3 后当前门户锁定 **27/27**，国际真机锁定 **101/101**，中国象棋真机锁定 **63/63**；
  裁判期望项数只增加，没有降低。

加新验收时：

1. 页面只开放只读状态 / DOM 钩子；
2. Node 端根据 FEN 自己生成合法着、应用走法和数分叉；
3. 先故意让实现错一处，看新增断言定点红；
4. 恢复 / 修复后跑完整固定套件，确认没有少执行项目。

---

## 5. 踩过的坑

- **白棋不能用黑棋 Unicode 再靠 fill 染白。** Safari / 彩色字体可能忽略 fill。国际象棋必须保留
  六类本地分层 SVG 几何和真实截图差分。
- **3D 路径不能用预分配 + drawRange。** 那让 buffer 容量替代实际绘制数，数字会自欺。
- **收到首个 L4 batch 不等于 L4 完整。** Worker 错误时删掉部分 L4，退回完整 L3。
- **停止旋转不等于停止渲染。** 只有相机过渡或用户明确巡航才续 rAF；默认静置必须零新帧。
- **L4 完成后不能留下上百批 geometry。** 同层精确合并并 dispose 旧批次，否则拖动 draw calls 爆炸。
- **AI reset 不能只丢弃旧回包。** 同步 Worker 仍会堵队列；必须 terminate / recreate。
- **预算不等于硬上限。** 引擎内部周期查钟、主线程 watchdog、合法 fallback 缺一不可。
- **AI thinking 时不要算会被应手替换的中间图。** 这只会抢搜索 CPU。
- **旧分叉只变淡不够。** 必须 `inert`、禁按钮并在事件入口再守一次。
- **变体棋盘不能只把正确 FEN 塞进 `data-*`。** 真实棋子几何也要逐格与该 FEN 对上。
- **中国象棋不能靠 `halfmove >= N` 伪造和棋。** 没有完整历史就无法判长将、长捉和循环责任方；
  当前实现选择不假装裁决。
- **中国象棋零预算搜索允许合法 fallback + 空 PV。** 自对弈裁判不能把这个契约误报成 PV 失败。
- **中国象棋分叉和 AI 必须用两个 Worker。** 单 Worker 会让昂贵候选分析排在 AI 应手前。
- **威胁是几何攻击线。** 被钉住的攻击者、将军限制和后续交换会改变“能否真吃”；文案不能升级成概率。
- **上一步起点不能只给 `.piece` 加样式。** 落子后来源格为空，必须用独立覆盖层画起点并一直保留。
- **门户拆分后，审计脚本也要读实际 UI 文件。** `self-play.mjs` 的人话函数来源是 `chess.html`，
  不是只含两张入口卡的 `index.html`；这个路径曾让 10 局审计在启动前直接失败。
- **未来地图预演不是预测或落子。** 蓝色是用户明确选择，金色是分析建议；全景与推演切换只能
  换呈现，不能改变 FEN。只有确认动作改变实战。
- **CDP 新标签可能 `document.hidden=true`。** 真 WebGL 验收要 bring-to-front 并启用 focus emulation。
- **无头 Chrome 测 WebGL 不要直接 `--disable-gpu`。** 使用 ANGLE / SwiftShader 参数。
- **`Runtime.evaluate` 的裸 `await` 会报错。** 包进 async IIFE 并设置 `awaitPromise: true`。
- **本机验收环境是 Node 22。** `/opt/homebrew/bin/node` 当前为 v22.23.1。

---

## 6. 已确认本地基线

自对弈脚本固定局数、种子、单局上限和错误断言，但搜索按墙钟预算运行；机器调度会让总 plies、
searches、PV 节点和最大耗时小幅变化。因此稳定验收基线是“10 局 + 所有错误计数为 0”，表中的
精确总数只是本次发布前实测记录，不是必须逐字复现的常量。

| 指标 | 当前基线 |
|---|---|
| 根首页 | 同一个“棋局未来地图”产品，两个真实规则入口 |
| 共享产品层 | `future-map.css` + `[data-future-map]` + 同形 `window.__futureTest` |
| 国际象棋起始 perft 1/2/3/4 | 20 / 400 / 8,902 / 197,281 |
| 中国象棋起始 perft 1/2/3/4 | 44 / 1,920 / 79,666 / 3,290,240 |
| `npm test` | 国际 8/8 + 中国 20/20 + 门户 27/27 |
| `node live-check.mjs` | 116/116 |
| `node xiangqi-live-check.mjs` | 72/72 |
| Phase 1 双渲染复核 | SwiftShader 5/5 + 本机 GPU 5/5 |
| Phase 2 叙事复核 | SwiftShader 5/5 + 本机 GPU 5/5 |
| Phase 3 细节复核 | 国际专项 6/6 + 中国专项 9/9 |
| 国际路径线程 | L1–L4 全在 cloud Worker；主线程只建 geometry |
| 国际路径生命周期 | 缩略 L3 / 明确放大 L4 / 收起释放 / 再放大完整重建 |
| 国际空闲渲染 | 静置 rAF +0、WebGL frame +0 |
| 国际棋子 | 六类分层 SVG 3D 视觉造型；零 Unicode |
| 国际路线语义 | 灰=其他合法路线、蓝=用户显式条件路线、金=分析建议 / 已验证 PV、白=实战、红=直接后果 |
| 国际搜索 | 最后完整层单条 PV；fallback 无伪 PV |
| 主棋盘预演 | 两棋悬停 / 键盘聚焦自动 4 ply；国际点击显式选路；中国零点击 4 ply / 8 秒硬预算；实战不变；下棋入口常驻 |
| 中国规则线程 | search / branch / hover preview 三个 Worker 实例；hover 可取消、不排长队 |
| 中国棋盘初始 | 90 个交互点、32 枚棋、44 条合法分叉 |
| 中国未来地图 | 3D 感全景常驻完整 1–10 ply 主线；与 2D 推演共用候选、全部合法回应、建议和预演 FEN |
| 中国搜索页面预算 / watchdog | 1.1s / 2.8s；实测 AI ≤3s |
| 中国上一步 | 空起点 + 金色实线 + 落点环 + 行棋方 / 记谱 / 坐标；真实 Worker 应手同源 |
| 中国威胁 | 全部真实攻击线保留；单条主强调、“攻→危”端点与手动攻击者切换；仍只是几何攻击线 |
| 中国有限动效 | 棋子位移 / 落点 / 攻击流有限次后停止；减少动态保留静态语义，切回普通不补播；持续 rAF 为 0 |
| 中国棋子视觉 | 象牙漆面三层渐变 + 双刻线 + 四层静态纵深；选中 / 上一步走内圈，威胁走外圈，不互相压扁 |
| 国际 10 局自走（本次实测） | 767 plies / 727 searches；五类错误汇总全 0；最大搜索 24.7ms |
| 中国 10 局自走（本次实测） | 788 plies / 788 searches / 1,428 PV 节点；6 终局 / 4 capped；五类错误全 0；最大搜索 24.4ms |
| 环境 | Node v22.23.1、chess.js 1.4.0、three.js 0.160.0 |

当前 Phase 3 运行源码冻结于 commit `c261223`。以下 SHA-256 已在 GitHub Pages
逐文件下载并与本地逐字节核对：

| 运行文件 | SHA-256 |
|---|---|
| `index.html` | `34fff9a3824ad3ee0d86a5ef7d80ed0c1eb27af4641860a93a00d140817067f7` |
| `future-map.css` | `0b37f982f6028289dc0805e05bcc3b45e6adfc8cba6183fcf5a071899423ba14` |
| `chess.html` | `471b3a1165b914e06e0dfcf86732dd1eaf467550df3d279adb6ed5596f9a7657` |
| `engine.js` | `8d20e54fd56e67ca3cd0b29c0d66f586ed5807de8e4781a623f03cf51b7a8959` |
| `worker.js` | `1ae0ea3c78d63aff081b1abb2bb41155d8d2bca1c82c2945f5745df94e35e520` |
| `xiangqi.html` | `676ad57d87bc3d320f158174296fa2e306bbb25e200abbc73287429bc29847c8` |
| `xiangqi-engine.js` | `e1e3c2c8862e06a9f75d9a5fedac8c5f0738df6182a9e13b77d90a006d96f290` |
| `xiangqi-worker.js` | `9dc7d9314231c76418a35e3a9e1e01b665a9aa31efa215a9a7cb19323e7f874e` |

线上行为复验：

- Pages workflow
  [`30800342436`](https://github.com/maxi-max-dev/chess-cloud/actions/runs/30800342436) 成功发布
  `c261223`；
- Phase 3 线上专项：国际象棋 **6/6**、中国象棋 **9/9**；本地完整真机为 **115/115 + 71/71**；
- Phase 3 线上实测运动完成 → 涟漪 → 10 粒碎裂顺序、500ms 清理、2 秒有限选中呼吸、200ms
  面板扫描、逐 ply 悬停传导与 reduced-motion 全部通过；页面 JS 错误为 0；
- 当前本地完整计时：国际首屏并发 **2,210ms**、4× 慢速手机 **1,155ms**、普通应手
  **1,086ms**；中国 4 ply **3,695ms**、10 ply **7,664ms**、真实 AI 应手 **1,205ms**；
- 8 个运行文件均已从 Pages 下载并与本地 SHA-256 逐字节对账；页面 JS 错误为 0。

### 焦点棋云发布封印（2026-08-04）

国际象棋逐步重根与时间走廊的运行源码冻结于 commit `0ebaa27`。Pages workflow
[`30879471675`](https://github.com/maxi-max-dev/chess-cloud/actions/runs/30879471675) 已成功发布；以下八个
运行文件从公开地址重新下载后均与本地逐字节一致：

| 运行文件 | SHA-256 |
|---|---|
| `index.html` | `47416f22d0f98e251f545bb43dc1fc172355be1cc4e9fa0fd8216f3b8ebb1988` |
| `future-map.css` | `0b37f982f6028289dc0805e05bcc3b45e6adfc8cba6183fcf5a071899423ba14` |
| `chess.html` | `ca5b1dc5a5f01bcbe72b0ed27fe3bec0ebd61d0762eca3a76f91f8180de829ef` |
| `engine.js` | `8d20e54fd56e67ca3cd0b29c0d66f586ed5807de8e4781a623f03cf51b7a8959` |
| `worker.js` | `1ae0ea3c78d63aff081b1abb2bb41155d8d2bca1c82c2945f5745df94e35e520` |
| `xiangqi.html` | `6b63f7d86c6ac74cc853aee87222b77ca6d62677478536ed763191defe914186` |
| `xiangqi-engine.js` | `e1e3c2c8862e06a9f75d9a5fedac8c5f0738df6182a9e13b77d90a006d96f290` |
| `xiangqi-worker.js` | `9dc7d9314231c76418a35e3a9e1e01b665a9aa31efa215a9a7cb19323e7f874e` |

最终验证：

- `npm test`：国际棋核 **8/8**、中国棋核 **20/20**、门户 **27/27**；零跳过。
- 本地 headless 真机：国际 **116/116**；中国 **71/71**。
- 最终运行源码线上：中国 **71/71**；国际焦点触摸快验 **3/3**，真实连续触摸
  `d3 → d6` 严格一触一层，预演棋盘 **32/32**，路线点 **2 → 3**，实战不变、零 JS 错误。
- 最终源码线上国际应手：冷启动 **694ms**、4× 慢速手机 **1,223ms**、正常深搜 **1,128ms**、
  Worker 故障保底 **2,316ms**；中国 4 / 10 ply 为 **3,741ms / 7,456ms**，真实 AI **1,150ms**。
- 最终线上国际全量复跑已通过所有已到达断言，但本机同时运行的 FileProvider / StorageManagement
  扫描使第三个 58 万边 L4 在 90 秒裁判等待上限内仍在增长，脚本以环境超时退出；裁判阈值没有放宽。
  同一源码的本地完整 116 项与线上专门复现项均全绿。
- 该仓库按纪律继续为零构建静态站，没有 lint / build script；模块语法检查与 `git diff --check` 均通过。

### 中国象棋完整主线全景发布封印（2026-08-04）

中国象棋全景 1–10 ply 常驻时间带的运行源码冻结于 commit `851549e`。Pages workflow
[`30881620777`](https://github.com/maxi-max-dev/chess-cloud/actions/runs/30881620777) 已成功发布；八个运行文件
从公开地址重新下载后均与本地 SHA-256 逐字节一致，其中本次变更的 `xiangqi.html` 为
`1dd862f2282786c44b2bdd64480fe1ec0b230a8f622fcca66ceb62424b6f6e81`。

最终验证：

- `npm test`：国际棋核 **8/8**、中国棋核 **20/20**、门户 **27/27**；零跳过。
- 本地 headless 真机：国际 **116/116**、中国 **72/72**；公开站点中国完整复跑 **72/72**。
- 公开站点 4 / 10 ply 云演为 **3,658ms / 7,033ms**，真实 AI 应手 **1,145ms**；分别守住
  8 秒 / 3 秒硬线，页面 JS 错误为 0。
- 新裁判独立重放第 2–10 步的父子 FEN、中文着法与走后合法分支数，并验证点第 6/10 步只改变
  预演投影、不改变实战 FEN；桌面 / 390px 十步全景截图已人工检查。

---

## 7. 下一步候选

按优先级：

1. **中国象棋历史规则。** 若要判长将、长捉与复杂循环，必须先把位置 / 着法历史加入局面与搜索，
   明确采用哪套竞赛规则，再加专门测试；不能拿 `halfmove` 阈值凑一个“和棋”。
2. **更强的中国象棋分析。** 当前是可解释的小型本地引擎，不是职业棋力。若接 Fairy-Stockfish、
   Pikafish 或其他引擎，先核对许可、浏览器 / WASM 分发、Worker 体积、移动端启动和无引擎降级；
   UI 的“概率 / 胜率”文案仍需真实 WDL 来源。
3. **国际象棋分叉排序加深。** `rankMoves(depth:2)` 能看送子但认不出更深战术，开局排序仍可能
   不符合人类常识。加深不能挤破 AI 3 秒红线。
4. **国际象棋和棋 / 升变 UI。** 搜索尚不判三次重复、50 步、子力不足；升变默认后。
5. **更深路径交互。** 国际 3D / 2D 目前可连续预演三步；任意 L4+ 节点重新设根仍未做。
6. **继续收紧统一契约。** 若以后抽共享 JS，只抽产品状态与渲染协议，不能合并两套规则 / 评估；
   新增字段必须先有跨棋种真机断言。

`BLOCKED.md` 保留更完整的历史理由和推翻方式。

---

## 8. 发布流程

```bash
cd ~/code/chess-cloud

npm test
node live-check.mjs
node xiangqi-live-check.mjs
node self-play.mjs
node xiangqi-self-play.mjs

git add -A
git commit -m "..."
git push origin main
```

Pages 生效后，逐一核对全部运行文件，不能只看根 `index.html`：

```bash
for f in \
  index.html future-map.css \
  chess.html engine.js worker.js \
  xiangqi.html xiangqi-engine.js xiangqi-worker.js
do
  local_hash=$(shasum -a 256 "$f" | awk '{print $1}')
  online_hash=$(curl -fsS --retry 12 --retry-delay 5 \
    "https://maxi-max-dev.github.io/chess-cloud/$f?v=$(date +%s)" \
    | shasum -a 256 | awk '{print $1}')
  printf '%s  local=%s  online=%s\n' "$f" "$local_hash" "$online_hash"
  test "$local_hash" = "$online_hash" || exit 1
done
```

再打线上行为：

```bash
node live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/
node xiangqi-live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/
```

最后：

```bash
git status --short
git rev-list --left-right --count origin/main...main
```

期望工作树为空、左右都是 0。不要留下未推送 commit，也不要只凭 Pages 首页肉眼变化判断发布成功。

---

## 9. 当前交接状态

- 产品已从“两个各自展示的棋种页面”收束为同一个“棋局未来地图”：首页统一定位，两页共用
  产品壳、路线角色、模式语言和 `window.__futureTest` 契约。
- 国际象棋保留独立规则 / Worker，新增建议与用户选路分离、路线语境和 2D / 3D 同状态切换。
- 中国象棋保留独立规则 / Worker，3D 感全景与 2D 推演共用候选、全部合法回应、分析建议、走后
  FEN 和路线后果；全景在第一层候选云之外常驻显示完整 1–10 ply 主线，并可点任一步回看。
- 国际象棋点击后先播放用户明确选择的第一步；中国象棋首次加载 / reset 自动选分析主线并连续云演。
  两页均可选择 1–10 ply（默认 4），候选可悬停 / 键盘聚焦后按该深度连演，并常驻“采纳首步 / 返回棋盘”入口。两页都完整
  保留真实回应，金色建议不冒充已知未来；动画使用独立 FEN 重放，预演期只读。
- 国际象棋首拍期间的主 SVG / 2D 树 / 变体棋盘 / 测试钩子旁路已统一封住；两页回应列表保留
  手机横滑、焦点与 ARIA 状态，终局零回应不伪造第二步。
- 国际象棋放大全景默认跟随正在看的局面逐步重根；实战 FEN、焦点 FEN 和 Worker generation 分账，
  手机在新 L1 几何到达前也有确定性标签可继续点，标签不计入真实云节点。
- 中国棋子已改为轻量的象牙漆面与刻字双圈；选中 / 上一步使用内圈，威胁使用外圈，三种状态不再
  重写或遮掉棋子本身的纵深阴影，预演编号也已移到左侧避开右上“危”。
- 新增第八个运行文件 `future-map.css`。
- 当前源码基线：`npm test` 为 **8/8 + 20/20 + 27/27**，国际真机 **116/116**，
  中国真机 **72/72**；Phase 1 与 Phase 2 专项在 SwiftShader / 本机 GPU 均各 **5/5**，
  Phase 3 双页专项为 **6/6 + 9/9**。
- 两套 10 局本次实测已完成：国际 767 plies，中国 788 plies；非法着、FEN、PV、分叉、威胁和注释
  失败全部为 0。
- 当前运行源码 commit、八个文件 SHA-256 与线上复验结果以第 6 节发布封印为准。
