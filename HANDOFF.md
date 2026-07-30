# 交接文档 · chess-cloud

写给下一个接手的人（AI 或人类）。这份文档是自足的：**不需要问任何人，也不需要看聊天记录**，
照着做就能接着干。截止 2026-07-30，当前最终架构已经写进这份文档；本地最终复验已是
`verify.mjs` 8/8、`live-check.mjs` 64/64。线上发布状态和文件哈希必须以第 8 节的发布后实测为准。

- 线上：https://maxi-max-dev.github.io/chess-cloud/
- 仓库：https://github.com/maxi-max-dev/chess-cloud （main 分支，GitHub Pages 从 main 根目录发布）
- 本地：`~/code/chess-cloud`
- 公开署名一律写 **Max**，不写真名。

---

## 0. 三十秒看懂这是什么

一个国际象棋网页。你执白落一子之后，页面回答两个问题：

1. **「接下来到底有多少种可能」** —— 以当前局面为根，往下四层全展开成三维星云
   （起始局面 197,281 颗星，就是公认的 perft(4)）。这块现在收在左上角小窗，点开可全屏。
2. **「这些可能里哪几条靠谱」** —— 右边整块是主舞台「可能性分叉」：一列 = 一步棋，
   列头写着这一步一共有多少种走法，列里先摆最靠谱的几条，点任意一条，右边几列顺它重新分叉。

黑方由自写的 minimax + alpha-beta 在 Web Worker 里应手。

**这个项目的灵魂是「数字必须是真的」**。所有展示出来的数量，都能被一个独立的 Node 脚本
重新算一遍撞上。下面第 3 节的红线，全是围绕这一条。

---

## 1. 先跑一遍，确认接手时是绿的

```bash
cd ~/code/chess-cloud && npm i chess.js@1.4.0
```

**棋核验收**：

```bash
node verify.mjs
```

期望：`全绿：8/8 项通过，零跳过`，退出码 0。
断言的是 perft 标准值：起始局面 20 / 400 / 8902 / 197281，Kiwipete 局面 48 / 2039 / 97862，
外加 `count(fen, 0) === 1` 的约定。

**真机验收**（无头 Chrome + CDP）：

```bash
node live-check.mjs
```

脚本用 `EXPECTED_RESULTS = 64` 锁定固定 64 项；成功时应输出 `全绿：64/64 项通过`。它会自己起
静态服务器、拉起无头 Chrome、走棋、截图、对数，
并切到 390×844 / 667×375 / 844×390 / 1024×768 验手机与平板布局、
真实触摸/滑动、黑白棋子像素、AI 竞态、背景和星云全屏。

**打线上**：

```bash
node live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/
```

参数：`--url`（不给就打本地）、`--port`（默认自动选空闲 CDP 端口；显式端口已占用会拒绝）、
`--shot`（截图落盘路径）。本地静态服务也自动选空闲端口。

> 如果这三条有任何一条是红的，**先把它弄绿再动新功能**。绿是基线。

---

## 2. 文件与数据流

| 文件 | 行数 | 干什么 |
|---|---|---|
| `index.html` | 2191 | 整个页面：分层 SVG 3D 棋子、SVG 棋盘、three.js 星图、分叉、响应式与交互 |
| `engine.js` | 299 | **唯一的评估函数** + 搜索 + 逐层展开 + 走法排序 |
| `worker.js` | 91 | Web Worker：AI 应手 / 第 1～4 层星云。页面开两个实例，互不排队 |
| `verify.mjs` | 94 | Node 端棋核验收，导出 `count(fen, depth)` 给别人对数用 |
| `live-check.mjs` | 2075 | 无头 Chrome 验收（含 PNG 差分、棋子/FEN、路径几何、触控与竞态） |
| `README.md` / `BLOCKED.md` / `PROGRESS.md` | | 对外说明 / 待裁决清单 / 迭代过程记录 |

没有构建工具、没有框架、没有后端。chess.js 和 three.js 直接从 CDN 引，版本钉死：

- `https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm`
- `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`

### engine.js 对外导出

```js
export { Chess };                       // 转出 chess.js，全项目只从这里拿
export const MATE = 100000;
export function evaluate(fen)           // ★ 唯一的评估函数。正=白优，单位百分兵
export function scoreChild(move)        // 给一个 verbose 走法打分（'#' 结尾判将死，其余走 evaluate）
export function expand(parentFens, opts)// 从一层局面展开出下一层：{parents, scores, fens}
export function rankMoves(fen, opts)    // 走法排序，opts.depth=2 = 往前看两步
export function search(fen, opts)       // 迭代加深 alpha-beta，返回 {move, san, score, depth, nodes, ms}
```

### 为什么拆成三个文件（不是一个 HTML）

因为「评估函数只准有一份」。页面的分叉排序调用 `engine.js`，cloud Worker 用它展开并给星打分，
search Worker 用它做 minimax 叶子打分；三条路径只有 import 同一个 ES module 才可能共享一套口径。
要塞进单文件，就得把评估函数源码字符串化再拼 Blob URL 造 Worker，那才是真的坑。

### 一次落子发生了什么

```
玩家点棋盘 → tryMove(from, to)
   ├─ chess.js 判合法（非法就直接 return false，这就是「被拒」）
   ├─ renderBoard()      → 先把玩家走法画出来
   ├─ requestAi()        → 派给独立 searchWorker
   ├─ prepareCloud()     → 终止旧云，只留根点；thinking 时不算中间云
   └─ markForkStale()    → 旧分叉淡化 + inert + 禁用确认，当前任务立即返回
AI 应手回来 → onAiMove()
   ├─ chess.js 落子 + renderBoard() + 状态文字
   ├─ 一帧真正绘制后才设置 lastAi.painted / totalMs
   └─ 再延迟一个后续任务 renderFork(true)，随后让 cloudWorker 从第 1 层长最终星云
```

搜索 Worker 有两道时限：引擎内部每 32 节点/根候选看 deadline；主线程另有 2.2 秒 watchdog。
Worker 超时、报错或通信失败时，页面会终止它并走请求发出时预存的第一步合法棋。reset 也会直接
terminate + 重建 Worker，不能只丢弃旧回包，否则新请求仍会排在旧同步搜索后面。
验收的 3 秒终点是棋盘完成绘制后的 `painted=true`，不是 Worker 回包或页面提前记下的数字。

### 棋盘棋子怎么画

- 不使用 `♚` 之类 Unicode 字符，也不依赖系统字体。旧实现对黑白双方都用了黑棋字形，只靠 fill 染白，
  Safari/彩色字体回退会忽略 fill，正是“白棋也变黑”的根因。
- `<defs id="boardPieceDefs">` 有兵/车/马/象/后/王六套分层 SVG 几何。每颗实际棋是
  `g.piece3d[data-sq][data-color][data-type][data-render="vector-3d"]`；黑白共用几何，只换渐变材质。
- `boardSquares / boardPieces / boardOverlay` 三层分开清理。棋子 `pointer-events:none`，触控仍落到格子；
  合法落点和分叉预览单独在 overlay 上画。
- 这是六种确定性的**分层 SVG 3D 视觉造型**，不是另一个可旋转的 WebGL mesh 棋盘；不要在文案里
  把它说成真实网格模型或自由相机棋局。

### 分叉图（主舞台）怎么算的

- `buildColumns()`：从当前局面出发，连续 `COLS`(=5) 列。每列调 `rankMoves(fen, {depth: RANK_DEPTH})`
  拿到**全部**走法（已按对行棋方好坏排序），选中的那条决定下一列的局面。
- `branchPath[i]` = 第 i 列选中的是排序后的第几条（默认 0，也就是最靠谱那条）。
- `expanded[i]` = 这一列有没有被点开「还有 N 条」。
- 渲染是**纯 SVG 字符串拼接**后 `innerHTML` 一次性塞进去，事件用委托。列一律**顶对齐**——
  这一点是踩过坑才改的，见第 5 节。

### 星云怎么算的

- 第 0 层 = 根局面自己（1 颗）。第 1–4 层棋局展开**全部在 cloud Worker**：第 1–3 层逐层整批回传，
  第 4 层按父节点边界分批回传；主线程只把真实数组转换成 Three.js geometry。
- 展开走的是 chess.js 的 verbose 走法：**走法对象自带 `after`（子局面 FEN）和 `san`**，
  一次走法生成就同时拿到子局面和分数，不用 make/undo。
- 每一批星单独开一个「刚好这么大」的 `BufferGeometry`。**不预分配、不用 drawRange。**
- 移动端星图离屏时只保留真实第 0–3 层并释放第 4 层 geometry；回到视口时用保存的第 3 层 FEN
  重新完整计算第 4 层。`deepPending` 明确表示“还有完整第 4 层待长”，不能把三层伪装成四层。

---

## 3. 红线（改之前先读这一节）

违反下面任何一条，这个项目就失去它唯一的价值。**这些不是风格偏好，是产品的地基。**

1. **`__cloudStats()` / `__forkStats()` 里的数量，必须从渲染对象上现读，不许自己记计数器。**
   - 星数：`obj.geometry.attributes.position.count` 求和。
   - 卡片数：`forkEl.querySelectorAll('g.card[data-col="i"]').length`。
   - 一旦改成「我记一个变量」，少画一半点也报得出漂亮数字，验收就成了摆设。
   - 同理不许预分配大 buffer 再用 `drawRange` —— 那等于自记计数器。

2. **不许把 8902 / 197281 这类数字写死进页面代码。**
   它们必须是算出来的。检查（只查代码，文档里作为说明文字提到不算）：

   ```bash
   grep -n "197281\|8902" index.html engine.js worker.js
   ```

   必须无匹配。`verify.mjs` 里有 197281 是对的——它是裁判，断言值就该写在那儿。

3. **不许改 `verify.mjs` 来让验收变绿。** 它是裁判，不是被告。
   （唯一允许的改动是**加**新断言，且加完必须自己先跑红一次证明它真的会红。）

4. **评估函数只准有一份**，就是 `engine.js` 里的 `evaluate(fen)`。
   星色、分叉排序、AI 搜索，全部读它。想加第二套打分标准 → 先在 BLOCKED.md 写清楚为什么。

5. **第 1–4 层棋局展开必须全在 Worker 里算。** 不许把前 1–3 层挪回主线程，也不许主线程
   算完第 4 层再假装分批送进来。主线程只接收数组、创建真实 geometry 和更新交互。

6. **AI 应手有硬上限 ≤3 秒。** 搜索预算是桌面 1.5 秒、手机/矮视口 0.9 秒，但预算本身不算硬保证；
   必须保留 2.2 秒主线程 watchdog、合法 fallback、reset 时 terminate/recreate Worker，
   且 thinking 时不得启动任何会被 AI 应手替换的云展开。四道一起才守得住冷启动和连续重开的 3 秒；
   加任何耗时功能前，先想清楚会不会挤掉这 3 秒。

7. **不新增构建工具 / 框架 / 后端。** 想加就先写进 BLOCKED.md 等人拍板。

8. **改完必须自己跑验收并贴出真实输出。** 「我觉得应该没问题」不算。
   改了行为就要有对应的新验收项，并且做一次**反向验证**（故意改坏 → 看它变红 → 改回 → 看它变绿）。

---

## 4. 验收脚本怎么用、怎么扩

`live-check.mjs` 现在固定验这些（64 项，`EXPECTED_RESULTS = 64`，少跑一项也会失败）：

| 组 | 验什么 |
|---|---|
| ① | `__cloudStats().nodes` 与 `count(同 fen, 同 depth)` 逐层相等。起始局面 1/20/400/8902/197281，**AI 应手后的局中局面 1/30/654/20144/475842 也对**（这个数字哪里都没写死，只能是真算的） |
| ② | 截图里星云确实成形 + 暖冷两色可见；根点的 geometry 只有 1 点且在原点；第一层真实点/线等于合法走法数，并以方向一致性证明它向未来展开而非球壳 |
| ③ | 分叉图每列总数和卡片数对账；排序方向对；每列恰有一张选中卡、一条选中边和一段连续主干；真实点击改路；真实展开→收起；推荐区外的选中卡在收起后仍可见；走满两回合后仍对 |
| ④ | 390×844、667/844 横屏与 1024 平板；真实页面/分叉滑动；≥44px；背景首尾；真全屏四角；真实 SAN 标签和多步主路径；触摸标签只选路不落子；拖动后标签显隐；按钮收起；移动星云 L3→L4→离屏释放回 L3→回屏完整重建 L4；真实 touch e4 后 AI ≤3 秒 |
| ⑤ | 实际棋子与 FEN 逐格对撞；32/16/16 和六类数量；六种分层造型；零 Unicode；黑白同几何不同材质；桌面/手机截图差分后的真实亮度、覆盖与明暗跨度 |
| 其他 | 非法走子；吃子/升变/王车易位后的棋子/FEN；引擎 deadline；首屏冷启动；重开终止旧搜索；强杀 Worker 的合法保底；AI 真实绘制后再延迟可视化；旧分叉淡化、`inert` 且不可触发重排；旧 AI/UI/横滚清理；云坐标 finite；AI 合法重放；页面零 JS 报错 |

最近一次反向验证是在脚本尚为 63 项时，同时故意破坏白方单类材质、引擎 deadline、Worker/星云
生命周期和旧分叉隔离等关键路径，验收准确出现 **10/63 项失败**。恢复实现后才新增固定项并把
`EXPECTED_RESULTS` 锁到 64；不要把“10/63”改写成“10/64”，那不是当时真实运行的输出。
随后又针对新补的黑棋可见轮廓与手机精确层集合做聚焦反向验证：让黑象只剩公共底座，并只在手机端
删除第 2 层，固定套件准确出现 **6/64 项失败**；恢复正式实现后完整复跑为 64/64。

### 加一条新验收

1. 页面上开一个只读钩子（放在 `index.html` 底部 `window.__test` 附近），
   **数量类的一律从 DOM / 几何体现读**。
2. 在 `live-check.mjs` 里 `evalJs('window.__xxx()')` 拿回来，
   用 `count()` 或 `new Chess(...)` 在 Node 端独立算一遍对撞，`record(ok, 名字, 细节)`。
3. 跑一次红的（故意改坏页面），再改回来跑绿，两份输出都留着。

### 截图取样区

不要再按屏幕比例猜。现在是 `window.__test.skyRect()` 返回 canvas 的
`getBoundingClientRect()`，`shotStats(file, rect)` 只统计那个矩形。**以后怎么改版式都不用改量法。**

---

## 5. 踩过的坑（别重踩）

- **`gl.readPixels` 在 rAF 之外读回来是全 0**。没开 `preserveDrawingBuffer` 时这是规范行为，
  不是画面空。→ 改成解 CDP 截下来的 PNG 数像素（`decodePng` 在 live-check.mjs 里，零依赖）。
- **CDP 新开的 tab `document.hidden = true`，rAF 全冻结**，three.js 一帧都不画。
  → attach 后必须发 `Emulation.setFocusEmulationEnabled` + `Page.bringToFront`。
- **无头 Chrome 跑 WebGL 别用 `--disable-gpu`**（会出合成伪影/黑画布）。
  用 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`。
- **星云的「均势」颜色一定要是真中性灰**。曾经调成偏蓝的（b 比 r 高 41），
  结果「黑优」和「均势」在画面上根本分不开，肉眼和像素统计都被骗过。
- **满色刻度要照实测分布定**。起始局面第 3 层 8,902 个分数实测 min -90 / p05 -55 / p50 +5 /
  p95 +70 / max +320（百分兵）。刻度定 900 时整个画面是灰白的，颜色白给。现在 `COLOR_FULL = 120`。
- **加性混合下 20 万个点会叠爆成白**，所以越深的层不透明度越低（`PT_OPAC`）。
- **分叉图的列必须顶对齐，展开后「收起」要留在顶部。** 曾经让每列在整块高度里垂直居中，结果点开某一列的 38 条之后，
  其他列的卡片被推到屏幕外面去了。
- **第一层不能 360° 铺球。** 根点虽然真的是 1 个，20 个首层走法若用 Fibonacci sphere 围住它，
  第一眼仍然只会看到一颗球。现在根方向固定向未来，首层只在前向锥内张开。
- **棋子不能再退回 Unicode 字形。** 黑白双方共用黑棋码点再靠 `fill` 染色，在本机 Chrome 看似正常，
  到 Safari/彩色字体回退就可能全部发黑。必须保留本地几何和真实截图差分验收。
- **重开不能只作废旧 AI 回包。** `search()` 在 Worker 里是同步的；只校验 id 会让新请求排在旧搜索后。
  reset 必须 terminate + recreate。实测旧实现 `e4 → reset → d4` 外部 3,559ms，已越过硬线。
- **引擎预算不等于真实硬上限。** 旧版每 1024 节点才看钟，首屏并发时第一次检查前就跑了约 4 秒。
  现在每 32 节点/根候选检查，外加主线程 watchdog 和合法 fallback；三道保护都不能删。
- **AI 思考时不要长任何中间云。** 那朵黑方待走云会被 AI 新局面替换，只会抢 CPU。
- **旧分叉只降透明度不够。** SVG 仍能吃鼠标、触摸、键盘和 hover，甚至会在 AI 思考期间触发
  `rankMoves()`。必须保留 `forkStale`、`forkWrap.inert`、确认按钮禁用和事件入口的双重守卫，
  直到延迟的 `renderFork(true)` 真正换成新局面。
- **移动端第 4 层不能只“暂停绘制”却继续占着 geometry。** 离屏要删除 L4、恢复 L3 的真实计时和
  `deepPending`；回屏再从保存的 L3 FEN 完整续长，验收会跑 L3→L4→L3→L4 全生命周期。
- **云 Worker 的代际校验要同时比当前实例和 `cloudState.gen`。** 只比旧闭包自己的 gen 永远会通过。
- **不要只把带 `backdrop-filter` 面板里的子元素设成 fixed 来做全屏。**
  这个父层会建立 fixed containing block 和 stacking context，子元素会偏移、露暗边、还可能被后面的面板盖住。
  现在是 `body.cloud-full #cloudPanel` 自己接管 viewport，`#skyBox` 只在里面绝对铺满。
- **`Runtime.evaluate` 里裸 `await` 会报错**，要包成 `(async()=>{...})()` 并传 `awaitPromise: true`。
- **本机铁律**：`/opt/homebrew/bin/node` 必须指向 node@22（全栈只在 v22 上验过）。

---

## 6. 已确认的基线

下面是恢复正式实现后在本机跑出的真实基线，不沿用旧架构数字。耗时会受机器负载影响，
但数量、线程归属、renderer 和固定验收项数不能漂移。

| 指标 | 基线 |
|---|---|
| 起始局面 perft 1/2/3/4 | 20 / 400 / 8,902 / 197,281 |
| 1.e4 Nc6 后 perft 1/2/3/4 | 30 / 654 / 20,144 / 475,842 |
| 星云展开线程 | 第 1–4 层全部在 cloud Worker；主线程只建 geometry |
| 移动星云生命周期 | 屏外 L3 / 入屏 L4 / 离屏释放回 L3 / 回屏完整重建 L4 |
| 棋子 renderer | 六种分层 SVG 3D 视觉造型；零 Unicode；不是 WebGL mesh |
| `live-check.mjs` 项数 | 固定 64 项；反向验证真实输出为 10/63、聚焦复验 6/64 失败 |
| `verify.mjs` 项数 | 固定 8 项 |
| 本地完整验收 | `verify.mjs` 8/8；`live-check.mjs` 64/64 |
| AI 首屏云并发 / 正常桌面 / 真实手机 | 1,554ms / 1,538ms / 967ms |
| 4× CPU 慢速手机 / reset 后新请求 / Worker 被杀保底 | 948ms / 1,629ms / 2,250ms |
| 正预算 deadline 探针 | 正常 140.4ms；临时关周期查钟 210.7ms 并按预期报红 |
| 桌面白/黑棋截图中位亮度 | 195.7 / 57.4；逐类型最小差 122.9 |
| 环境 | node v22.23.1、chess.js 1.4.0、three 0.160.0 |

---

## 7. 接下来可以做什么

**BLOCKED.md 里 19 条是完整的待裁决清单，先读那个。** 下面是我认为最值得做的几件，按优先级：

1. **把分叉排序做准一点**（BLOCKED #17）。现在 `rankMoves(depth:2)` 只往前看两步，
   能认出送子，认不出更深的战术，开局会把 Nc3/Nf3 排在 e4/d4 前面，懂棋的人看着别扭。
   两条路：① 第一列改成往前看三步（约 160ms，只在落子后算一次）；
   ② 直接调 `search()` 给每个候选打分。**注意别挤掉「AI ≤3 秒」那条红线。**

2. **让 `search()` 返回主变例（PV）**（BLOCKED #13）。有了 PV 就能在分叉图上画出
   「AI 认为接下来会这样走」，比现在的贪心/浅层排序有说服力得多。
   实现：negamax 里维护三角 PV 数组，只在 alpha 提升时收集。

3. **升变选棋子的界面**（BLOCKED #7）。现在默认成后。
   `tryMove(from, to, promotion)` 已经收第三个参数，接个 UI 就行。

4. **搜索加和棋判定**（BLOCKED #4）。现在只判将死和困毙，不判三次重复 / 50 步 / 子力不足，
   残局会自我感觉良好。代价是每个节点多一次走法生成，深度会掉。

5. **正式名还没定**（BLOCKED #9）。仓库名 `chess-cloud` 是定死的，页面标题现在叫「可能性分叉」。

---

## 8. 发布流程

```bash
cd ~/code/chess-cloud
node verify.mjs && node live-check.mjs      # 先本地全绿
git add -A && git commit -m "..."
git push origin main
# Pages 大约 30–60 秒后生效，用文件哈希确认线上确实换了版本再验：
curl -s https://maxi-max-dev.github.io/chess-cloud/ | shasum -a 256
shasum -a 256 index.html
node live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/
```

**不要留未推送的 commit。** 这个仓库是公开展示用的，本地和线上必须一致。

---

## 9. 交接时的状态

- 当前功能基线：六种分层 SVG 3D 棋子（非 WebGL mesh）；主视图是连续分叉路径；星图从「现在」
  向未来展开并带真实标签；手机竖屏/短横屏均已适配。
- 本轮最终本地输出：`node verify.mjs` **8/8**；`node live-check.mjs` **64/64**。
- `main` 同步状态、线上复验和三个静态文件哈希由主代理发布后填写；本节不提前宣称已经完成。
