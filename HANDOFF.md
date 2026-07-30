# 交接文档 · chess-cloud

写给下一个接手的人（AI 或人类）。这份文档是自足的：**不需要问任何人，也不需要看聊天记录**，
照着做就能接着干。截止 2026-07-30，三次迭代都已上线并验收通过。

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

**棋核验收**（约 7 秒）：

```bash
node verify.mjs
```

期望：`全绿：8/8 项通过，零跳过`，退出码 0。
断言的是 perft 标准值：起始局面 20 / 400 / 8902 / 197281，Kiwipete 局面 48 / 2039 / 97862，
外加 `count(fen, 0) === 1` 的约定。

**真机验收**（无头 Chrome + CDP，本地约 60–100 秒）：

```bash
node live-check.mjs
```

期望：`全绿：33/33 项通过`。它会自己起静态服务器、拉起无头 Chrome、走棋、截图、对数，
并切到 390×844 / 667×375 / 844×390 / 1024×768 验手机与平板布局、
真实触摸/滑动、背景和星云全屏。

**打线上**：

```bash
node live-check.mjs --url https://maxi-max-dev.github.io/chess-cloud/
```

参数：`--url`（不给就打本地）、`--port`（CDP 端口，默认 9333，多开要换）、`--shot`（截图落盘路径）。

> 如果这三条有任何一条是红的，**先把它弄绿再动新功能**。绿是基线。

---

## 2. 文件与数据流

| 文件 | 行数 | 干什么 |
|---|---|---|
| `index.html` | 1056 | 整个页面：SVG 棋盘、three.js 星云、分叉图、响应式布局、所有交互 |
| `engine.js` | 295 | **唯一的评估函数** + 搜索 + 逐层展开 + 走法排序 |
| `worker.js` | 58 | Web Worker：AI 应手 / 第 4 层星云。页面开两个实例，互不排队 |
| `verify.mjs` | 94 | Node 端棋核验收，导出 `count(fen, depth)` 给别人对数用 |
| `live-check.mjs` | 729 | 无头 Chrome 真机验收（含零依赖 PNG 解码、桌面/手机像素与触控检查） |
| `README.md` / `BLOCKED.md` / `PROGRESS.md` | | 对外说明 / 待裁决清单 / 三次迭代的过程记录 |

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

因为「评估函数只准有一份」。主线程要用它给星上色和给分叉排序，Worker 要用它做 minimax 叶子打分。
只有 import 同一个 ES module 才可能是同一份。要塞进单文件，就得把评估函数源码字符串化再拼
Blob URL 造 Worker，那才是真的坑。

### 一次落子发生了什么

```
玩家点棋盘 → tryMove(from, to)
   ├─ chess.js 判合法（非法就直接 return false，这就是「被拒」）
   ├─ requestAi()        → 派给 searchWorker（先派，让它和主线程并行）
   ├─ rebuildCloud()     → 主线程同步铺前 3 层（约 150–250ms）
   │                       然后把第 3 层的 8,902 个局面整批发给 cloudWorker
   │                       cloudWorker 按 400 个父节点一批，把第 4 层流回来
   └─ renderFork()       → 重算 5 列分叉，重画 SVG
AI 应手回来 → onAiMove() → 走棋 → 再来一遍 rebuildCloud + renderFork
```

### 分叉图（主舞台）怎么算的

- `buildColumns()`：从当前局面出发，连续 `COLS`(=5) 列。每列调 `rankMoves(fen, {depth: RANK_DEPTH})`
  拿到**全部**走法（已按对行棋方好坏排序），选中的那条决定下一列的局面。
- `branchPath[i]` = 第 i 列选中的是排序后的第几条（默认 0，也就是最靠谱那条）。
- `expanded[i]` = 这一列有没有被点开「还有 N 条」。
- 渲染是**纯 SVG 字符串拼接**后 `innerHTML` 一次性塞进去，事件用委托。列一律**顶对齐**——
  这一点是踩过坑才改的，见第 5 节。

### 星云怎么算的

- 第 0 层 = 根局面自己（1 颗）。第 1–3 层主线程同步。第 4 层 Worker 分批。
- 展开走的是 chess.js 的 verbose 走法：**走法对象自带 `after`（子局面 FEN）和 `san`**，
  一次走法生成就同时拿到子局面和分数，不用 make/undo。实测三层 159ms vs 349ms。
- 每一批星单独开一个「刚好这么大」的 `BufferGeometry`。**不预分配、不用 drawRange。**

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

5. **第 4 层必须真在 Worker 里算。** 不许主线程算完再假装分批送进来。
   （主线程同步算 197,281 个节点要 8 秒，页面会卡死。）

6. **AI 应手有硬上限 ≤3 秒。** 现在靠 `search()` 的迭代加深 + `AI_BUDGET_MS = 1500` 预算保证，
   时间到就交上一层搜完的最好走法。桌面预算 1.5 秒，手机/矮视口预算 1.2 秒；
   加任何耗时功能前，先想清楚会不会挤掉这 3 秒。

7. **不新增构建工具 / 框架 / 后端。** 想加就先写进 BLOCKED.md 等人拍板。

8. **改完必须自己跑验收并贴出真实输出。** 「我觉得应该没问题」不算。
   改了行为就要有对应的新验收项，并且做一次**反向验证**（故意改坏 → 看它变红 → 改回 → 看它变绿）。

---

## 4. 验收脚本怎么用、怎么扩

`live-check.mjs` 现在验这些（33 项）：

| 组 | 验什么 |
|---|---|
| ① | `__cloudStats().nodes` 与 `count(同 fen, 同 depth)` 逐层相等。起始局面 1/20/400/8902/197281，**AI 应手后的局中局面 1/30/654/20144/475842 也对**（这个数字哪里都没写死，只能是真算的） |
| ② | 截图里星云确实成形 + 暖冷两色都看得出来（解 PNG 数真实像素） |
| ③ | 分叉图每列「共 N 种走法」== `count(该列局面, 1)`；卡片数从 SVG 真数出来；排序方向对；点另一条后面几列真的跟着改；点开「还有 N 条」整列摊开；走满两回合后重算仍然对 |
| ④ | 390×844 竖屏、667/844 横屏与 1024 平板无裁切/重叠；根页面真实可滑且不横溢出；分叉可真实横滑并触摸末列；触控目标 ≥44px；背景首尾截图无露底；星云可真实触摸开关且四角层级正确；真实 touch 走 e4 后 AI 仍 ≤3 秒 |
| 其他 | 非法走子被拒；e4 后 AI ≤3 秒应手；AI 那步在 node 端用 chess.js 独立重放合法；页面零 JS 报错 |

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
- **分叉图的列必须顶对齐**。曾经让每列在整块高度里垂直居中，结果点开某一列的 38 条之后，
  其他列的卡片被推到屏幕外面去了。
- **不要只把带 `backdrop-filter` 面板里的子元素设成 fixed 来做全屏。**
  这个父层会建立 fixed containing block 和 stacking context，子元素会偏移、露暗边、还可能被后面的面板盖住。
  现在是 `body.cloud-full #cloudPanel` 自己接管 viewport，`#skyBox` 只在里面绝对铺满。
- **`Runtime.evaluate` 里裸 `await` 会报错**，要包成 `(async()=>{...})()` 并传 `awaitPromise: true`。
- **本机铁律**：`/opt/homebrew/bin/node` 必须指向 node@22（全栈只在 v22 上验过）。

---

## 6. 现在的实测数字（改动后拿这些当基线比对）

| 指标 | 实测值 |
|---|---|
| 起始局面 perft 1/2/3/4 | 20 / 400 / 8,902 / 197,281 |
| 1.e4 Nc6 后 perft 1/2/3/4 | 30 / 654 / 20,144 / 475,842 |
| 星云前 3 层同步铺开 | 约 150–250 ms |
| 星云第 4 层（起始局面，Worker） | 约 3.5 s；局中复杂局面可到 8–15 s |
| e4 后 AI 应手（外部秒表） | 桌面约 2.0–2.4 s；手机约 2.0–2.7 s，常见搜到 3–4 层 |
| `node verify.mjs` | 约 7 s，8/8 绿 |
| `node live-check.mjs` | 约 60–100 s，33/33 绿 |
| 环境 | node v22.23.1、chess.js 1.4.0、three 0.160.0 |

---

## 7. 接下来可以做什么

**BLOCKED.md 里 18 条是完整的待裁决清单，先读那个。** 下面是我认为最值得做的几件，按优先级：

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

- `main` 分支干净：零未提交改动、零未推送 commit。
- 当前功能基线：主视图是平面分叉图，星云为可全屏小窗，手机竖屏/短横屏均已适配。
- 本地 33/33 绿，线上 33/33 绿，`node verify.mjs` 8/8 绿。
- 线上三个静态文件（index.html / engine.js / worker.js）与本地逐字节一致。
