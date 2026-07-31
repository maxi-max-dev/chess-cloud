# 交接文档 · chess-cloud

写给下一个接手的人（AI 或人类）。这份文档是自足的：**不需要问任何人，也不需要看聊天记录**，
照着做就能接着干。截止 2026-07-31，当前最终架构已经写进这份文档；固定验收现在是
`verify.mjs` 8 项、`live-check.mjs` 83 项，最终本地与线上输出见第 6、9 节。

- 线上：https://maxi-max-dev.github.io/chess-cloud/
- 仓库：https://github.com/maxi-max-dev/chess-cloud （main 分支，GitHub Pages 从 main 根目录发布）
- 本地：`~/code/chess-cloud`
- 公开署名一律写 **Max**，不写真名。

---

## 0. 三十秒看懂这是什么

一个国际象棋网页。页面现在不只展示“很多未来”，而是直接辅助你做下一步决定：

1. **「这枚棋子怎么走、对手会怎么回」** —— 点任意白棋，助手列出这枚棋子的前三候选，
   先用黄线动画演示“你的一步”，再用蓝线演示“对手的强回应”。它明确是引擎强度，
   不是伪造的历史概率；预演不落子，确认后才走。实际应手回来后还会对照是否命中。
2. **「接下来到底有多少种可能」** —— 以当前局面为根，往下四层全展开成三维父子路径网
   （起始局面第 4 层 197,281 条路径，就是公认的 perft(4)）。零 `THREE.Points`；每个未来
   节点恰有一条真实入边。缩略窗只建真实 L3；明确点「放大探索」才加载 L4，收起即释放。
   同一位置可切成纯 2D 纵向树：每层列出当前父局面的全部合法孩子，每张卡写真实“走后 N 个分支”，
   所选路线用连续 SVG 主干向下连接；全屏旁边仍是逐格显示分支结果的真实变体棋盘。
3. **「这些可能里哪几条靠谱」** —— 右边下半部是「可能性分叉」：一列 = 一步棋，
   列头写着这一步一共有多少种走法，列里先摆最靠谱的几条，点任意一条，右边几列顺它重新分叉。
   卡片主文案是“接近均衡 / 你稍优 / 风险较高”等人话，原始 `+0.35` 只保留作核对。

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

脚本用 `EXPECTED_RESULTS = 83` 锁定固定 83 项；成功时应输出 `全绿：83/83 项通过`。它会自己起
静态服务器、拉起无头 Chrome、走棋、截图、对数，
并切到 390×844 / 667×375 / 844×390 / 1024×768 验手机与平板布局、
真实触摸/滑动、黑白棋子像素、棋子助手、AI 竞态、空闲 WebGL 帧、背景和路径网全屏变体棋盘。

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
| `index.html` | 4616 | 整个页面：分层 SVG 3D 棋子、棋子助手、3D/2D 路径网、变体棋盘、分叉、响应式与交互 |
| `engine.js` | 309 | **唯一的评估函数** + 搜索 + 逐层展开 + 走法排序 |
| `worker.js` | 91 | Web Worker：AI 应手 / 第 1～4 层路径。页面开两个实例，互不排队 |
| `verify.mjs` | 94 | Node 端棋核验收，导出 `count(fen, depth)` 给别人对数用 |
| `live-check.mjs` | 4022 | 无头 Chrome 验收（含 PNG 差分、棋子/FEN、2D/3D 路径几何、空闲帧、助手、触控与竞态） |
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
export function rankMoves(fen, opts)    // 排序；结果还带 piece/captured/flags，助手用它解释回应类型
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
   ├─ captureCoachPrediction() → 保存该步及前三条强回应，只用于事后对照
   ├─ renderBoard()      → 先把玩家走法画出来
   ├─ requestAi()        → 派给独立 searchWorker
   ├─ prepareCloud()     → 终止旧云，只留根点；thinking 时不算中间云
   └─ markForkStale()    → 旧分叉淡化 + inert + 禁用确认，当前任务立即返回
AI 应手回来 → onAiMove()
   ├─ chess.js 落子 + renderBoard() + 状态文字
   ├─ 一帧真正绘制后才设置 lastAi.painted / totalMs，并用实际应手更新助手
   └─ 再延迟一个后续任务 renderFork(true)，随后让 cloudWorker 从第 1 层长最终路径网
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
  合法落点、分叉预览、助手的两段动画单独在 overlay 上画。
- 这是六种确定性的**分层 SVG 3D 视觉造型**，不是另一个可旋转的 WebGL mesh 棋盘；不要在文案里
  把它说成真实网格模型或自由相机棋局。

### 棋子助手怎么算的

- 只在白方可走且用户选中一枚白棋时工作。候选来自当前 `columns[0].ranked`，先按 `from` 过滤，
  DOM 最多展示前三条，但 `modelTotal` 保留该棋子的真实合法走法总数。
- 每个候选的对手回应来自 `rankMoves(candidate.after, {depth: 1})`，黑方排序方向由 `rankMoves`
  自己处理。文案只能说“对手强回应（按引擎强度）”，不能说历史胜率或概率。
- 动画只重建 `boardOverlay`，绝不 `game.move()`。切换棋子、重开、真实落子都会换 `lineId`
  或清空旧动画。黄/蓝两段都只播一次、1.5 秒后停住，不允许无限循环继续耗帧。
  棋盘格支持触摸、鼠标和 Enter/Space。
- `scoreSituation()` 把唯一引擎分翻译成“接近均衡 / 你稍优 / 对手明显优 / 将死”；`moveQuality()`
  用候选相对本列最佳的损失翻译成“首选 / 稳健可下 / 需要准确 / 风险较高”。黑方列必须反向算损失。
- 默认升变在预测和真实落子两边都归一成 `q`。白方一步直接结束棋局时走
  `presentCoachTerminal()`，不能留在“正在等黑方”。fallback 的说明必须使用真实 `reason`，
  不能把 Worker 故障一概伪装成超时。

### 分叉图（主舞台）怎么算的

- `buildColumns()`：从当前局面出发，连续 `COLS`(=5) 列。每列调 `rankMoves(fen, {depth: RANK_DEPTH})`
  拿到**全部**走法（已按对行棋方好坏排序），选中的那条决定下一列的局面。
- `branchPath[i]` = 第 i 列选中的是排序后的第几条（默认 0，也就是最靠谱那条）。
- `expanded[i]` = 这一列有没有被点开「还有 N 条」。
- 渲染是**纯 SVG 字符串拼接**后 `innerHTML` 一次性塞进去，事件用委托。列一律**顶对齐**——
  这一点是踩过坑才改的，见第 5 节。

### 全屏变体棋盘怎么算的

- `explorerState` 与真实 `game` 完全分离，只保存 `rootFen + path`。点线旁标签、右侧候选或面包屑，
  只用各步真实 `after` FEN 重画 `#exploreBoard`；绝不调用真实 `game.move()`。
- 当前分支局面的全部合法走法由 `rankMoves(fen, {depth: 1})` 生成并缓存，明确标成“即时评估”；
  棋子助手和主分叉用 depth=2、标成“含对手强回应”，两种视野不能混写成同一个分数。
- 变体最多连续探索 `SYNC_DEPTH`(=3) 步。选路同时驱动真实 L1–L3 geometry 上的亮线、SAN 标签、
  面包屑和逐格棋盘；第 3 步后明确提示回退，不伪造不存在的第 4 步交互。
- 变体棋盘复用主棋盘的六套分层 SVG 3D 几何和黑白材质。验收不仅对 `data-*`，还检查每枚棋子的
  实际屏幕矩形落在对应格内，避免“元数据对、棋子画错格”。

### 二维路径树怎么算的

- `#cloudMode` 在 3D 与 2D 间切换，两边**复用同一个 `explorerState.rootFen + path`**，没有第二本
  路径账。2D→3D→2D、在旧层换兄弟、甚至 L3 尚未回传时快速切换，选路都必须保留。
- 2D 每层只渲染“当前已选父节点”的全部合法孩子，最多交互 `SYNC_DEPTH`(=3) 步，不把完整 L4
  复制成几十万 DOM。每张卡的“走后 N 个分支”直接对 `move.after` 重新生成合法走法并取 `.length`。
- 内部 `data-depth` / `parentDepth` 始终是“从当前根往后”的相对 1–3 层，只用于索引和回退；
  **绝不能把它再写成实战步数**。可见标题的“第 N 回合、白/黑方走、已走 N 手”由 `fenTurnContext()`
  直接解析各层 `parentFen` 的 side/fullmove；副标题另写“未来第 1/2/3 步”。所以真实落子后首层会从
  第 1 回合前进到第 2、3…回合，`loadFen()` 到第 37 回合也不会因为 `game.history()` 为空而归零。
- 根到各层选中节点之间由实际 SVG path 连成连续主干；横向分支用真实滚动容器，桌面有左右箭头，
  手机可横滑；整棵树可纵向滚。箭头的显示和 disabled 状态从 `scrollWidth/clientWidth/scrollLeft`
  现读，不为终局或不可滚动层显示死按钮。
- 2D 缩略图只露当前下一层及每张卡的分叉数；全屏左/上是树，右/下是同源变体棋盘。
  390×844、短横屏、1440×900、1280×800，以及模拟 47px 刘海/34px 底部手势区都有几何断言。
- 进入 2D 会停巡航、取消待绘帧、释放 L4；放大/收起 2D 不调用 `renderer.setSize()`，因此隐藏
  WebGL backing store 的像素尺寸不变。AI 思考时树和变体棋盘同时 `inert/aria-busy`，清空旧卡；
  真实应手完成绘制后才按新 `game.fen()` 重建。

### 三维路径网怎么算的

- 第 0 层 = 根局面自己（用一条“过去 → 现在”的短边表示，终点严格在原点）。第 1–4 层棋局展开
  **全部在 cloud Worker**：第 1–3 层逐层整批回传，
  第 4 层按父节点边界分批回传；主线程只把真实数组转换成 Three.js geometry。
- 展开走的是 chess.js 的 verbose 走法：**走法对象自带 `after`（子局面 FEN）和 `san`**，
  一次走法生成就同时拿到子局面和分数，不用 make/undo。
- 每个未来节点恰有一条父→子 `THREE.LineSegments` 入边；零 `THREE.Points`。L1–L3 各自一个
  刚好尺寸的 geometry；L4 计算中每批也是刚好尺寸，完整结束后合并成一个同样精确的 geometry。
  真实路径数始终是 `position.count / 2`。**不预分配、不用 drawRange。**
  `selected-route` 单独挂在 scene，不进入 `layers` 账本。
- 缩略窗无论桌面或手机都只保留真实第 0–3 层；只有 `body.cloud-full` 且画布可见时才从保存的
  第 3 层 FEN 完整计算 L4。收起全屏、离开视口或切后台都会释放 L4，保留完整 L3 和当前变体路径。
  `deepPending` 明确表示“还有完整第 4 层待长”，不能把三层伪装成四层。
- L4 分批尚未完成时若 Worker 报错，`discardPartialDeepLayer()` 会删除部分 L4 并退回完整 L3；
  不能把“收到过一个 batch”当成“第 4 层完整”。
- 深层线透明度低但不是不可见：验收单独截图对撞“完整图 vs 隐藏 L4”。相机最大距离受 fog
  约束；全屏有“回到全景”，标签也会在进入雾区时隐藏，避免只剩浮空文字。
- 渲染是事件驱动的：`requestCloudRender()` 会合并同一帧请求；默认巡航关闭，镜头收敛后不再
  `requestAnimationFrame`。用户明确开巡航才约 24fps 运行，收起或切后台立即停止。
- 缩略窗 DPR 固定 1；全屏桌面封顶 1.5，粗指针/短边设备封顶 1.25。`ResizeObserver` 与
  `visualViewport.resize` 都会重算 backing store，避免旋转后既糊又白算像素。

---

## 3. 红线（改之前先读这一节）

违反下面任何一条，这个项目就失去它唯一的价值。**这些不是风格偏好，是产品的地基。**

1. **`__cloudStats()` / `__forkStats()` 里的数量，必须从渲染对象上现读，不许自己记计数器。**
   - 路径数：每个真实非索引 `LineSegments` 的 `obj.geometry.attributes.position.count / 2` 求和。
   - 卡片数：`forkEl.querySelectorAll('g.card[data-col="i"]').length`。
   - 一旦改成「我记一个变量」，少画一半线也报得出漂亮数字，验收就成了摆设。
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

6. **AI 应手有硬上限 ≤3 秒。** 搜索预算是桌面 1.3 秒、手机/矮视口 0.9 秒，但预算本身不算硬保证；
   必须保留 2.2 秒主线程 watchdog、合法 fallback、reset 时 terminate/recreate Worker，
   且 thinking 时不得启动任何会被 AI 应手替换的云展开。四道一起才守得住冷启动和连续重开的 3 秒；
   加任何耗时功能前，先想清楚会不会挤掉这 3 秒。

7. **不新增构建工具 / 框架 / 后端。** 想加就先写进 BLOCKED.md 等人拍板。

8. **改完必须自己跑验收并贴出真实输出。** 「我觉得应该没问题」不算。
   改了行为就要有对应的新验收项，并且做一次**反向验证**（故意改坏 → 看它变红 → 改回 → 看它变绿）。

---

## 4. 验收脚本怎么用、怎么扩

`live-check.mjs` 现在固定验这些（83 项，`EXPECTED_RESULTS = 83`，少跑一项也会失败）：

| 组 | 验什么 |
|---|---|
| ① | `__cloudStats().nodes` 与 `count(同 fen, 同 depth)` 逐层相等。起始局面 1/20/400/8902/197281，**AI 应手后的局中局面 1/30/654/20144/475842 也对**（这些数页面都没写死） |
| ② | 零 `THREE.Points`；根短边终点在原点；L1 边数等于合法走法；所有对象是真实非索引 `LineSegments`，顶点成对、颜色对齐、无隐藏/孤儿/drawRange；L4 完成后每层恰一个对象；截图对撞正常图、隐藏全网、单独隐藏 L4；真实差分中暖冷两色可见；缩略静置 700ms 后 rAF/WebGL 均为 0；L4 首批前切后台会停 Worker、保留 L3/选路并自动续满；真实 ＋/－/全景；连续点两步后路线、面包屑、逐格变体棋盘与 Node 重放 FEN 同源，实战不动；2D 根/每层完整走法集/每卡走后分叉逐一由 Node 重放，连续 SVG 主干端点必须落在真实选中卡，2D 不加载 L4、不重画或扩容隐藏 canvas，2D↔3D 与 L3 未到的快速切换都保留路径；AI thinking 时禁旧卡，完成后按新 FEN 重建；根已走手数、每层绝对 ply/fullmove/行棋方必须与父 FEN 相等，真实走完一回合显示第 2 回合，空 history 的第 37 回合 FEN 仍显示第 37 回合 |
| ③ | 分叉图每列总数和卡片数对账；排序方向对；每列恰有一张选中卡、一条选中边和一段连续主干；真实点击改路；真实展开→收起；推荐区外的选中卡在收起后仍可见；走满两回合后仍对 |
| ④ | 390×844、667/844 横屏与 1024 平板；真实页面/分叉/候选滑动；全部关键入口 ≥44px 且中心可命中；背景首尾；真全屏四角；真实 SAN 标签和多步主路径；连续触摸两层图标签会更新逐格棋盘且不落子；拖动后标签显隐；主动巡航会动、收起会停；缩略 L3→放大 L4→收起释放回 L3→再次放大完整 L4，空闲 rAF/WebGL=0；2D 手机缩略横滑、全屏纵滑、触摸选满三步、树/棋盘不重叠；桌面 1440×900 与 1280×800 不撞板；模拟 47px 刘海/34px 底部安全区仍不遮挡；667×375 全屏双栏可看可点可收；真实 touch e4 后 AI ≤3 秒 |
| ⑤ | 实际棋子与 FEN 逐格对撞；32/16/16 和六类数量；六种分层造型；零 Unicode；黑白同几何不同材质；桌面/手机截图差分后的真实亮度、覆盖与明暗跨度 |
| ⑥ | 手机真触摸选棋且 FEN 不变；候选逐项合法；回应能独立重放且等于 `rankMoves(after,{depth:1})` 首选；两段动画同 `lineId`；切棋/重开/落子清旧动画；人话分档与 raw score 同源，并覆盖黑方方向、默认升后、一步终局和键盘入口 |
| 其他 | 非法走子；吃子/升变/王车易位后的棋子/FEN；引擎 deadline；首屏冷启动；重开终止旧搜索；强杀 Worker 的合法保底；AI 真实绘制后再延迟可视化；旧分叉淡化、`inert` 且不可触发重排；旧 AI/UI/横滚清理；云坐标 finite；AI 合法重放；页面零 JS 报错 |

历史反向验证是在脚本尚为 63 项时，同时故意破坏白方单类材质、引擎 deadline、Worker/路径网
生命周期和旧分叉隔离等关键路径，验收准确出现 **10/63 项失败**。恢复实现后才新增固定项并把
`EXPECTED_RESULTS` 锁到 64；不要把“10/63”改写成“10/64”，那不是当时真实运行的输出。
随后又针对新补的黑棋可见轮廓与手机精确层集合做聚焦反向验证：让黑象只剩公共底座，并只在手机端
删除第 2 层，固定套件准确出现 **6/64 项失败**；恢复正式实现后完整复跑为 64/64。

本轮 70 项版又做了聚焦反向验证：临时把真实 L1 `LineSegments` 设为不可见，并把助手的强回应
排序反转。固定裁判分别准确报红“隐藏路径对象”和“回应不是 depth=1 首选”；看到两项红后停止该次
长跑，删除临时破坏，再完整复跑 70/70。`verify.mjs` 全程零改动。

本轮 75 项版再做了两次独立反向验证：① 在 `renderCloudFrame()` 末尾故意持续请求下一帧，
空闲断言准确报红 `rAF +15 / WebGL +15 / pending=1`；② 让变体棋盘故意始终渲染根 FEN，
“连续点两步、逐格棋盘与 Node 重放同源”准确报红。两次都看到目标红项后立刻停止长跑、删除临时
破坏，再完整复跑 75/75。`verify.mjs` 仍全程零改动。

固定项扩到 77 后又补了两个漏网边界：① L4 Worker 首批尚未到达时触发后台分支，旧实现准确报红
`后台 depth/growing/pending=3/true/false`；② 用旧样式真实打开 844×390 全屏，准确报红
`board=236`、重开/面包屑/候选/根标签四类触控目标不可命中。修复后必须完整复跑 77/77。

固定项扩到 82 后，2D 树做了新的反向验证：临时把每张卡显示的真实 `replies` 改为
`replies + 1`，裁判立即逐节点报红，例如 `L1 Nc3 走后分支 21≠20`，并连带让路径、手机和新 FEN
重建的同源断言变红。看到目标红后停止长跑，恢复真实值，完整复跑回 82/82；`verify.mjs` 零改动。

固定项扩到 83 前先把新的 FEN 回合断言放进裁判，旧页面按预期报红：
`根回合显示不是 FEN 实值：{}`、`L1 回合显示=空 / rel=undefined ...`。随后才实现
`fenTurnContext()`、DOM 回合字段和两行标题。正式实现对真实一回合与 fullmove=37 的空 history FEN
都通过，完整复跑 83/83；`verify.mjs` 仍零改动。

### 加一条新验收

1. 页面上开一个只读钩子（放在 `index.html` 底部 `window.__test` 附近），
   **数量类的一律从 DOM / 几何体现读**。
2. 在 `live-check.mjs` 里 `evalJs('window.__xxx()')` 拿回来，
   用 `count()` 或 `new Chess(...)` 在 Node 端独立算一遍对撞，`record(ok, 名字, 细节)`。
3. 跑一次红的（故意改坏页面），再改回来跑绿，两份输出都留着。

### 截图取样区

不要再按屏幕比例猜。现在是 `window.__test.skyRect()` 返回 canvas 的
`getBoundingClientRect()`，像素差只统计那个矩形。路径网截图前会冻结自动相机，再分别隐藏
`cloudGroup` 和 L4，避免标签移动造成假阳性。**以后怎么改版式都不用靠猜比例。**

---

## 5. 踩过的坑（别重踩）

- **`gl.readPixels` 在 rAF 之外读回来是全 0**。没开 `preserveDrawingBuffer` 时这是规范行为，
  不是画面空。→ 改成解 CDP 截下来的 PNG 数像素（`decodePng` 在 live-check.mjs 里，零依赖）。
- **CDP 新开的 tab `document.hidden = true`，rAF 全冻结**，three.js 一帧都不画。
  → attach 后必须发 `Emulation.setFocusEmulationEnabled` + `Page.bringToFront`。
- **无头 Chrome 跑 WebGL 别用 `--disable-gpu`**（会出合成伪影/黑画布）。
  用 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`。
- **路径网的「均势」颜色一定要是真中性灰**。曾经调成偏蓝的（b 比 r 高 41），
  结果「黑优」和「均势」在画面上根本分不开，肉眼和像素统计都被骗过。
- **满色刻度要照实测分布定**。起始局面第 3 层 8,902 个分数实测 min -90 / p05 -55 / p50 +5 /
  p95 +70 / max +320（百分兵）。刻度定 900 时整个画面是灰白的，颜色白给。现在 `COLOR_FULL = 120`。
- **20 万条线仍会叠成发光毛球**。现在用 NormalBlending、窄前向锥和逐层 `EDGE_OPAC`；
  L4 不能低到单独隐藏它时零像素差，也不能高到重新糊成球。
- **分叉图的列必须顶对齐，展开后「收起」要留在顶部。** 曾经让每列在整块高度里垂直居中，结果点开某一列的 38 条之后，
  其他列的卡片被推到屏幕外面去了。
- **第一层不能 360° 铺球。** 根虽然真的是 1 个，20 个首层走法若用 Fibonacci sphere 围住它，
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
- **第 4 层不能只“暂停绘制”却继续占着 geometry。** 现在缩略态一律 L3；只有明确放大全屏才加载
  L4，收起、离屏或切后台都删除 L4、恢复 L3 的真实计时和 `deepPending`。验收会跑
  L3→放大 L4→收起 L3→再次放大 L4 全生命周期。
- **“停止自动旋转”不等于停止渲染。** 如果 `renderCloudFrame()` 无条件再排下一帧，静止画面仍会
  满速提交 WebGL。只能在镜头尚未收敛或用户明确开巡航时续帧；验收会直接数 rAF 与 renderer 帧差。
- **L4 分批回传不能永久留下几十/上百个对象。** 计算中可以渐进显示，`cloudDone` 后必须把同层
  精确合并成一个 geometry 并 dispose 旧批次，否则拖动时 draw calls 会随局面分支数暴涨。
- **变体棋盘不能只把正确 FEN 塞进 `data-*`。** 真实图形也必须按那个 FEN 落格；验收用 Node
  chess.js 独立重放，再检查每枚棋子的屏幕矩形、材质和六类几何。真实 `game` 必须始终不变。
- **云 Worker 的代际校验要同时比当前实例和 `cloudState.gen`。** 只比旧闭包自己的 gen 永远会通过。
- **收到首个 L4 batch 不等于 L4 完整。** Worker 中途报错必须删掉部分层并回到完整 L3。
- **相机缩放上限要和 fog 配套。** 旧值允许退到 220、fog far 却只有 74，结果线全消失只剩标签。
  现在最大 58、标签检查 fog 距离，并有“回到全景”。
- **助手的相对质量要按行棋方算方向。** 白方损失是 `best-score`，黑方是 `score-best`；
  直接将死/错过将死也要反向，不能把黑方坏棋标成“首选”。
- **预测和真实落子的升变默认值必须同一处归一。** 未传 promotion 一律按 `q`；否则同分稳定排序
  可能预演升马、实际却升后。
- **fallback 原因不能统一写成超时。** Worker 加载、通信、搜索异常和无效走法都要展示真实 reason。
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
| 路径展开线程 | 第 1–4 层全部在 cloud Worker；主线程只建 geometry |
| 路径网生命周期 | 缩略 L3 / 明确放大 L4 / 收起释放回 L3 / 再放大完整重建 L4 |
| 空闲渲染 | 缩略静置 700ms：rAF +0、WebGL frame +0、pending=0；默认巡航关闭 |
| WebGL 对象 | L4 完成后 L0–L4 每层各 1 个 `LineSegments`；全屏约 6 draw calls，收起 geometry 6→5 |
| 渲染倍率 | 缩略 DPR 1；桌面全屏最高 1.5；粗指针/短边设备最高 1.25 |
| 棋子 renderer | 六种分层 SVG 3D 视觉造型；零 Unicode；不是 WebGL mesh |
| 棋子助手 | 候选 depth=2；回应 depth=1；黄/蓝两段 1.5s 单次 SVG 动画；预演不改 FEN |
| 全屏变体探索 | 全部合法走法；可连续 3 步；线、标签、面包屑、逐格 3D 棋盘同一 FEN；实战不动 |
| `live-check.mjs` 项数 | 固定 83 项；含 2D 数字/主干/生命周期/触控/安全区、AI/FEN 重建与真实 FEN 回合显示 |
| `verify.mjs` 项数 | 固定 8 项 |
| 本地完整验收 | `verify.mjs` 8/8；`live-check.mjs` 83/83 |
| 线上完整验收 | `live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/` 83/83 |
| AI 首屏路径并发 / 正常桌面 / 真实手机 | 1,397ms / 1,348ms / 967ms |
| 两套独立浏览器同时冷启动 | 2,718ms / 2,564ms，均未改 3 秒门槛 |
| 4× CPU 慢速手机 / reset 后新请求 / Worker 被杀保底 | 949ms / 1,423ms / 2,243ms |
| 正预算 deadline 探针 | 正常 140.4ms；临时关周期查钟 210.7ms 并按预期报红 |
| 桌面白/黑棋截图中位亮度 | 195.7 / 57.4；逐类型最小差 122.9 |
| 线上 AI 首屏路径并发 / 正常桌面 / 真实手机 | 1,930ms / 1,357ms / 955ms |
| 线上 4× CPU / reset / Worker 被杀保底 | 944ms / 1,420ms / 2,259ms |
| 环境 | node v22.23.1、chess.js 1.4.0、three 0.160.0 |

本轮发布后的逐字节哈希（本地与 GitHub Pages 已完全一致）：

```text
dc77fa90481ecd7938cf8870e097fcfdf80da4708d77c336fe650cd0cde2b1fe  index.html
64a26efa7b740e74d54ff3c371e4edf875306c03e8f6c0de4fa56aba98552156  engine.js
a065d664f7bbbf3e67f9ac5b3ea546e11cc94db4c36a2d00a30d4d4b1b1d9aed  worker.js
```

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
# Pages 大约 30–60 秒后生效；三个运行文件都要逐一核对，不能只看 index：
for f in index.html engine.js worker.js; do
  local_hash=$(shasum -a 256 "$f" | awk '{print $1}')
  online_hash=$(curl -fsS "https://maxi-max-dev.github.io/chess-cloud/$f?v=$(date +%s)" | shasum -a 256 | awk '{print $1}')
  test "$local_hash" = "$online_hash" || exit 1
done
node live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/
```

**不要留未推送的 commit。** 这个仓库是公开展示用的，本地和线上必须一致。

---

## 9. 交接时的状态

- 当前功能基线：六种分层 SVG 3D 棋子（非 WebGL mesh）；点棋子会出现合法候选、对手强回应和
  两段单次动画；局势优先显示人话；主视图是连续分叉；全景图是零光点的真实父子路径线网，
  可切成逐层列出全部合法走法和“走后 N 个分支”的 2D 纵向树；两种模式都可连续预演三步，
  并在旁边逐格显示同源 3D 变体棋盘；2D 的根和层标题从 FEN 显示真实已走手数/回合/行棋方，
  “未来第几步”与内部相对层号明确分开；手机竖屏/短横屏、刘海和底部手势区均已适配。
- 性能基线：缩略窗只建 L3、静置零 rAF/零 WebGL 新帧；L4 只在明确放大时计算，完成后每层一个
  geometry，收起立即释放；2D 完全不加载 L4、重绘或扩容隐藏 canvas；默认巡航关闭，
  手机全屏 DPR 封顶 1.25。
- 本轮最终本地输出：`node verify.mjs` **8/8**、`node live-check.mjs` **83/83**。
- 本轮最终线上输出：`node live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/`
  **83/83**；三个运行文件 SHA-256 已用第 8 节流程确认与本地逐字节一致。
- `main` 已推送，GitHub Pages 已更新；交接时 `main`、`origin/main` 与工作树保持同步。
