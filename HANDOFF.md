# 交接文档 · chess-cloud

写给下一位接手的人（AI 或人类）。这份文档是自足的：**不需要问任何人，也不需要看聊天记录**。
截止 2026-07-31，项目已经定位为“一个棋局未来地图产品 + 两套独立真实棋核”：规则分开，
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
   共用同一个候选、强回应和走后局面。
3. `future-map.css`：两页共用的产品壳、颜色角色、图例、路线语境栏与移动端行为。它不包含任何
   棋种规则。
4. 两页都以 `[data-future-map]` 声明当前规则 / 模式 / 阶段，并公开同形的
   `window.__futureTest` 只读验收契约。

产品目标不是展示两个各做各的棋盘，而是让用户一眼看到当前全部真实下一步，选择任一路线后继续
看强回应和直接后果。3D 全景负责“看全局”，2D 推演负责“读清路径”；切换视图不能改变实战 FEN
或丢失预演。现在两页选择路线后，主棋盘都会按“你走 → 对方回应”逐拍移动，并停在推演后的局面供
对照；这只是独立重放，只有明确点击“走这步”才会改变实战。

**项目的灵魂仍然是“数字必须是真的”。** 页面说有多少棋子、合法走法、分叉或路径，就必须能从
当前局面 / DOM / geometry 现读，并由独立 Node 或真 Chrome 裁判重算。浅层排序只能叫建议或
强回应，不能叫概率。

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
- 中国象棋棋核：**19/19**
- 统一产品入口 / 共享未来地图契约 / 运行代码红线：**23/23**

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

- 国际象棋：**95/95**
- 中国象棋：**51/51**

两条脚本都会自己起本地静态服务和无头 Chrome。国际象棋脚本的本地目标已经改为
`chess.html`；中国象棋脚本会从根首页实际点击两张卡，验证路由后再进入 `xiangqi.html`。
它们都覆盖手机尺寸、真实触控、Worker 应手、合法重放和页面零 JS 错误。

### 1.3 固定 10 局稳定性审计

```bash
node self-play.mjs
node xiangqi-self-play.mjs
```

这两条是正确性 / 稳定性冒烟，**不是棋力基准**。最新国际象棋真实输出为 10 局 / 634 plies /
594 次搜索，`abnormalGames / illegalMoves / fenMismatches / pvFailures / annotationFailures`
全为 0。
最新中国象棋真实输出：

- 10 局、814 plies、814 次搜索、1,560 个 PV 节点；
- 5 局到真实终局，5 局达到 100 plies 测试上限并如实记作 `capped`；
- `illegalMoves=0`
- `fenMismatches=0`
- `pvFailures=0`
- `branchFailures=0`
- `threatFailures=0`
- 单次搜索最大 28.6ms

> `npm test` 不包含两套真 Chrome 和两套自对弈。发布前不能只跑 `npm test`。

---

## 2. 文件职责与数据流

### 2.1 路由与文件

| 文件 | 职责 |
|---|---|
| `index.html` | 统一产品首页；恰好两个真实规则入口 |
| `future-map.css` | 两页共用的产品壳、路线颜色、图例、语境栏和响应式规则 |
| `portal-check.mjs` | 首页、共享样式、同形未来地图根 / 状态契约和运行代码红线的 23 项静态裁判 |
| `package.json` | `npm test` 与两套棋种验收快捷命令 |
| `chess.html` | 国际象棋 UI；3D 全景、2D 推演、五列分叉、棋盘和同一路线语境 |
| `engine.js` | 国际象棋唯一评估函数、排序、威胁、搜索、PV 和路径展开 |
| `worker.js` | 国际象棋 AI search Worker / cloud Worker 的共同入口 |
| `verify.mjs` | 国际象棋 perft / 棋核裁判 |
| `live-check.mjs` | 国际象棋 95 项真 Chrome 裁判 |
| `self-play.mjs` | 国际象棋固定 10 局稳定性审计 |
| `xiangqi.html` | 中国象棋 9×10 UI；3D 感全景、2D 推演、强回应、路线后果、实战历史和威胁 |
| `xiangqi-engine.js` | 中国象棋规则、唯一评估函数、排序、威胁、搜索与 PV |
| `xiangqi-worker.js` | 中国象棋搜索 / 分叉 / 分析 Worker 入口 |
| `xiangqi-verify.mjs` | 中国象棋 19 项棋核 / 搜索裁判 |
| `xiangqi-live-check.mjs` | 中国象棋 51 项真 Chrome / 路由 / 未来地图契约 / 上一步 / 威胁 / 棋子材质 / 手机裁判 |
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
- 灰色是其他合法路线；蓝色只表示用户明确选择的预演；金色表示引擎建议 / 强回应，其中搜索 PV
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

页面使用两个 `xiangqi-worker.js` 实例：

- `searchWorker`：黑方 AI，页面预算 1.1 秒，2.8 秒 watchdog；
- `branchWorker`：当前局面全部候选和浅层强回应。

两者必须分开，否则较慢的分叉排序会把 AI 应手排在后面。reset 会同时重建两个实例。
搜索预算在引擎层钳到 2.4 秒，给消息传输 / 绘制留出 3 秒红线余量。

中国象棋 UI 的数量来自当前事实：

- 棋子数：`[data-piece]` / `[data-side]` 的实际 DOM；
- 合法落点：当前合法着生成结果与 `[data-target]`；
- 当前分叉：实际 `.branch-node` 数量；
- 节点分叉数：从该节点 `data-fen` 重新生成下一手合法着；
- 路径节点：实际 DOM 的 `data-fen/data-branches/data-ply`。

点任一未来节点只建立蓝色用户预演，金色路线表示浅层强回应；FEN 和实战路径不变。3D 感全景与
2D 推演树必须保留同一个候选、强回应和预演 FEN。只有“走这步”或棋盘合法落点才真正落子。
排序会看对方强回应和一步合法回吃，但仍不是胜率或概率。

`getThreats()` 表示几何攻击线，并列出攻击者 / 保护者。它不保证攻击者下一手有合法吃法，
也不代表被瞄准的棋一定会丢。

### 2.4 统一未来地图契约

两页都必须提供：

- `[data-future-map]`：`data-game / data-mode / data-phase / data-route-owner / data-root-fen`；
- `[data-future-context]`：全页唯一的路线语境栏；
- `#board[data-future-preview]`：主棋盘路线预演协议；
- `window.__futureTest`：`schema / game / snapshot / selectNode / rewind / setMode / commitSelected`；
- `snapshot()`：`root / selectedPath / suggestedPath / preview / enginePath / rendered`。

`selectedPath` 只能来自用户明确选路；建议不能冒充已选。根 FEN、根分叉、每步 after FEN 和后续
分叉必须能由独立棋核重放。`setMode()` 只能改变视图，不能改变实战 FEN、历史或预演路线。

主棋盘预演必须遵守以下同形契约：

- 棋盘公开 `data-preview-phase / data-preview-root-fen / data-preview-display-fen /
  data-preview-line-id / data-preview-step-index / data-preview-step-count`；
- 每一拍都从实战根 FEN 用独立棋核重放，不得修改实战 FEN、历史或路径；通常是“你的选择 → 对方
  回应”两拍，终局路线允许只有一拍；
- 棋盘上每个静态路径使用 `[data-future-preview-step="you"]` 或
  `[data-future-preview-step="reply"]`，运动中的真实棋子使用
  `[data-future-motion-piece="true"]`；同一时刻最多一枚棋子移动；
- 每次选路或重播必须生成新的 `data-preview-line-id`，旧定时器、旧 `animationend` 和旧棋子不得
  推进新路线；快速切换后 DOM 中只能留下当前 line ID；
- 动画结束后停在最终推演局面供分析，主棋盘在整个预演期间只读；只有明确确认按钮能提交。取消、
  reset 或实战变化必须重绘根局面；
- `prefers-reduced-motion: reduce` 下不播放位移，直接显示同一个最终局面；播放中切到减少动态也要
  立即停止并投影最终局面，切回普通动态不能补播旧路线。

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
   - 国际象棋保留 1.3s / 0.9s 搜索预算、2.2s watchdog、合法 fallback、reset 重建 Worker。
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

`live-check.mjs` 用 `EXPECTED_RESULTS = 95` 锁定 95 项，覆盖：

- L0–L4 真实 geometry、DOM 分叉数和 Node 独立 perft 对撞；
- 零 `THREE.Points`、无预分配 / drawRange / 隐藏孤儿对象；
- 3D / 2D 路径、真实变体棋盘、FEN 回合、蓝 / 金两条路线；
- 棋子 SVG 几何与真实像素，避免白棋因 Unicode / 字体回退变黑；
- 棋子助手、几何攻击、合法一步吃子、回吃和亏交换；
- 390×844、短横屏、平板、安全区、44px 触控；
- AI deadline、watchdog、reset / fallback / PV 和空闲零持续帧。
- 统一未来地图初始建议不冒充用户选路；选路 after FEN / 分叉可重放；2D / 3D 切换保留
  同一个预演且不改实战。
- 旧确认按钮不能绕过用户选路直接提交金色建议；清空路线后两个确认入口都必须重新禁用。
- 选路后主棋盘按独立 FEN 重放“你走 → 回应”，停在最终局面且实战不变；取消和非法棋盘输入后
  DOM / 协议必须同源。
- 快速切换路线、同路线重播与播放中切换减少动态均隔离旧代；手机画中画也必须可读且不能绕过确认。

数量钩子仍在 `chess.html` 的 `window.__test`；统一产品选路契约另由 `window.__futureTest` 暴露。
数量类只能从 DOM / geometry 返回。

### 4.2 中国象棋

`xiangqi-verify.mjs` 固定 19 项，覆盖：

- FEN 无损往返；
- 起始 perft 1–4；
- 马腿、象眼 / 不过河、炮架、兵过河、将帅照面；
- 将军、将死、困毙和非法着拒绝；
- 攻击者 / 保护者、唯一评估方向；
- search 合法 PV、真实根分叉、时限与 `depth=0,pv=[]`；
- 候选会看对方强回应与一步合法回吃，不把开局送炮换马排第一。

`xiangqi-live-check.mjs` 用 `EXPECTED_RESULTS = 51` 锁定 51 项，覆盖：

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
- 建议路线与用户选路分离；候选和强回应可由 Node 重放；全景 / 推演模式切换保留同一预演且不改 FEN。
- Worker 回包前先选路线时，回应就绪后必须升级同一预演；全景大幅拖动后 44 条真实下一步仍全部可见。
- 未选建议保持金色；即便路线会吃子，用户明确选中后仍以蓝色选路为最高视觉优先级。
- 主棋盘必须实际出现两条静态路径与逐拍棋子位移，并在预演期间完全只读；只能由“走这步”提交。
- 不同路线快速切换、同路线重播和动态减少偏好切换必须清掉旧代动画 / 定时器，最终 FEN 由 Node
  独立重放对撞。

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
- 修复后当前门户锁定 **23/23**，国际真机锁定 **95/95**，中国象棋真机锁定 **51/51**；裁判
  期望项数没有降低。

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
- **未来地图预演不是落子。** 蓝色是用户明确选择，金色是建议 / 强回应；全景与推演切换只能
  换呈现，不能改变 FEN。只有确认动作改变实战。
- **CDP 新标签可能 `document.hidden=true`。** 真 WebGL 验收要 bring-to-front 并启用 focus emulation。
- **无头 Chrome 测 WebGL 不要直接 `--disable-gpu`。** 使用 ANGLE / SwiftShader 参数。
- **`Runtime.evaluate` 的裸 `await` 会报错。** 包进 async IIFE 并设置 `awaitPromise: true`。
- **本机验收环境是 Node 22。** `/opt/homebrew/bin/node` 当前为 v22.23.1。

---

## 6. 已确认本地基线

| 指标 | 当前基线 |
|---|---|
| 根首页 | 同一个“棋局未来地图”产品，两个真实规则入口 |
| 共享产品层 | `future-map.css` + `[data-future-map]` + 同形 `window.__futureTest` |
| 国际象棋起始 perft 1/2/3/4 | 20 / 400 / 8,902 / 197,281 |
| 中国象棋起始 perft 1/2/3/4 | 44 / 1,920 / 79,666 / 3,290,240 |
| `npm test` | 国际 8/8 + 中国 19/19 + 门户 23/23 |
| `node live-check.mjs` | 95/95 |
| `node xiangqi-live-check.mjs` | 51/51 |
| 国际路径线程 | L1–L4 全在 cloud Worker；主线程只建 geometry |
| 国际路径生命周期 | 缩略 L3 / 明确放大 L4 / 收起释放 / 再放大完整重建 |
| 国际空闲渲染 | 静置 rAF +0、WebGL frame +0 |
| 国际棋子 | 六类分层 SVG 3D 视觉造型；零 Unicode |
| 国际路线语义 | 灰=其他合法路线、蓝=用户预演、金=建议 / 强回应 / 已验证 PV、白=实战、红=直接后果 |
| 国际搜索 | 最后完整层单条 PV；fallback 无伪 PV |
| 两页主棋盘预演 | 独立重放“你走 → 回应”；停在最终局面；实战不变；预演期只读；减少动态直接投影结果 |
| 中国规则线程 | search / branch 两个 Worker 实例 |
| 中国棋盘初始 | 90 个交互点、32 枚棋、44 条合法分叉 |
| 中国未来地图 | 3D 感全景 / 2D 推演共用候选、强回应和预演 FEN |
| 中国搜索页面预算 / watchdog | 1.1s / 2.8s；实测 AI ≤3s |
| 中国上一步 | 空起点 + 金色实线 + 落点环 + 行棋方 / 记谱 / 坐标；真实 Worker 应手同源 |
| 中国威胁 | 全部真实攻击线保留；单条主强调、“攻→危”端点与手动攻击者切换；仍只是几何攻击线 |
| 中国有限动效 | 棋子位移 / 落点 / 攻击流有限次后停止；减少动态保留静态语义，切回普通不补播；持续 rAF 为 0 |
| 中国棋子视觉 | 象牙漆面三层渐变 + 双刻线 + 四层静态纵深；选中 / 上一步走内圈，威胁走外圈，不互相压扁 |
| 国际 10 局自走 | 634 plies / 594 searches；五类错误汇总全 0；最大搜索 20.49ms |
| 中国 10 局自走 | 814 plies / 814 searches / 1,560 PV 节点；5 终局 / 5 capped；五类错误全 0 |
| 环境 | Node v22.23.1、chess.js 1.4.0、three.js 0.160.0 |

当前“棋局未来地图”运行源码冻结于 commit `083a58c`。以下 SHA-256 已在 GitHub Pages
逐文件下载并与本地逐字节核对：

| 运行文件 | SHA-256 |
|---|---|
| `index.html` | `5909c17a139c2e2eb2e6a3859710e0b4e44821fec9eaf76da848f12ef07735ed` |
| `future-map.css` | `64e839fb16a8a0f0b56b5c75b5b8128c41b97b73969f222de1c4235c788d60bf` |
| `chess.html` | `ec563f2e2879e6aade7b9bec6cc4db3488a098d3c4d9badd6744051bd54db64c` |
| `engine.js` | `8d20e54fd56e67ca3cd0b29c0d66f586ed5807de8e4781a623f03cf51b7a8959` |
| `worker.js` | `a065d664f7bbbf3e67f9ac5b3ea546e11cc94db4c36a2d00a30d4d4b1b1d9aed` |
| `xiangqi.html` | `83963fa448995869e67e86bd1df0f6b298703eb6b9fca0a55749a041edd6692e` |
| `xiangqi-engine.js` | `e1e3c2c8862e06a9f75d9a5fedac8c5f0738df6182a9e13b77d90a006d96f290` |
| `xiangqi-worker.js` | `06c9d33c946722bd2e6bfe0d4b13e304a89de61873a06eaace49a5a093459cd4` |

线上行为复验：

- `node live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/`：**95/95**；
- `node xiangqi-live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/`：**51/51**；
- 本轮线上国际首个 AI 外部可见应手 **1,523ms**，中国象棋 **1,183ms**，都低于 3 秒硬上限；
- 国际局中 L4 **475,842** 条，逐层与独立棋核一致；
- 中国象棋提前选路竞态会从 1 层升级为合法 2 层预演；全景大拖动后仍 **44/44** 节点可见；
- 两页主棋盘预演、快速切路、预演期只读和播放中切换减少动态均在线上真 Chrome 通过；
- 页面 JS 错误均为 0。

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
- 中国象棋保留独立规则 / Worker，新增 3D 感全景，并与 2D 推演共用候选、强回应、走后 FEN
  和路线后果。
- 两页选择路线后，主棋盘都会逐拍显示“你走 → 对方回应”，停在最终推演局面供比较；动画使用
  独立 FEN 重放与 line ID 隔离，预演期只读，减少动态直接显示相同结果。
- 中国棋子已改为轻量的象牙漆面与刻字双圈；选中 / 上一步使用内圈，威胁使用外圈，三种状态不再
  重写或遮掉棋子本身的纵深阴影，预演编号也已移到左侧避开右上“危”。
- 新增第八个运行文件 `future-map.css`。
- 当前源码基线：`npm test` 为 **8/8 + 19/19 + 23/23**，国际真机 **95/95**，
  中国真机 **51/51**。
- 两套固定 10 局已完成：国际 634 plies，中国 814 plies；非法着、FEN、PV、分叉、威胁和注释
  失败全部为 0。
- 运行源码 commit `083a58c` 已推到 `main` 并发布；八个运行文件与 GitHub Pages 逐字节一致，
  线上复验为国际象棋 **95/95**、中国象棋 **51/51**。本段的文档封印 commit 紧随其后，
  运行文件哈希不变。
