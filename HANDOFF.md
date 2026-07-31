# 交接文档 · chess-cloud

写给下一位接手的人（AI 或人类）。这份文档是自足的：**不需要问任何人，也不需要看聊天记录**。
截止 2026-07-31，项目已经从单一国际象棋页变成“双棋种入口 + 两套独立棋核”。

- 线上：https://maxi-max-dev.github.io/chess-cloud/
- 仓库：https://github.com/maxi-max-dev/chess-cloud（`main`，GitHub Pages 从根目录发布）
- 本地：`~/code/chess-cloud`
- 公开署名只写 **Max**

---

## 0. 三十秒看懂

打开根首页先看到两个选择：

1. `chess.html`：国际象棋，人执白、AI 执黑。保留棋子助手、一步威胁、五列分叉、零光点 3D 路径网、
   纯 2D 树、逐格变体棋盘和蓝色用户路线 / 金色 AI 主变。
2. `xiangqi.html`：中国象棋，人执红、AI 执黑。是真正的 9×10 规则核，不是给国际象棋换一套棋子。
   页面会显示当前全部合法分叉、浅层强回应、威胁注释、真实分叉数和搜索 PV；木盘、象牙棋子、
   金色上一着轨迹与“攻→危”攻击流只是这些事实的可读视觉层。

根 `index.html` 只做棋种选择，不包含任一棋种的规则。

**项目的灵魂仍然是“数字必须是真的”。** 页面说有多少棋子、多少合法走法、多少分叉、多少路径，
就必须能从当前 DOM / geometry 现读，并由独立 Node 或真 Chrome 裁判从局面重新计算。不能自己记一本
数字账，不能少画后仍报告全量，也不能把浅层引擎排序说成概率或职业棋力。

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
- 双棋种入口 / 路由 / 运行代码红线：**16/16**

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

- 国际象棋：**90/90**
- 中国象棋：**43/43**

两条脚本都会自己起本地静态服务和无头 Chrome。国际象棋脚本的本地目标已经改为
`chess.html`；中国象棋脚本会从根首页实际点击两张卡，验证路由后再进入 `xiangqi.html`。
它们都覆盖手机尺寸、真实触控、Worker 应手、合法重放和页面零 JS 错误。

### 1.3 固定 10 局稳定性审计

```bash
node self-play.mjs
node xiangqi-self-play.mjs
```

这两条是正确性 / 稳定性冒烟，**不是棋力基准**。最新国际象棋真实输出为 10 局 / 631 plies，
`abnormalGames / illegalMoves / fenMismatches / pvFailures / annotationFailures` 全为 0。
最新中国象棋真实输出：

- 10 局、844 plies；
- 4 局到真实终局，6 局达到 100 plies 测试上限并如实记作 `capped`；
- `illegalMoves=0`
- `fenMismatches=0`
- `pvFailures=0`
- `branchFailures=0`
- `threatFailures=0`
- 单次搜索最大 23.0ms

> `npm test` 不包含两套真 Chrome 和两套自对弈。发布前不能只跑 `npm test`。

---

## 2. 文件职责与数据流

### 2.1 路由与文件

| 文件 | 职责 |
|---|---|
| `index.html` | 根首页；恰好两张卡，分别去 `chess.html` / `xiangqi.html` |
| `portal-check.mjs` | 入口、独立页面连线和运行代码硬编码红线的静态裁判 |
| `package.json` | `npm test` 与两套棋种验收快捷命令 |
| `chess.html` | 国际象棋完整 UI；原单页从 `index.html` 原样迁入 |
| `engine.js` | 国际象棋唯一评估函数、排序、威胁、搜索、PV 和路径展开 |
| `worker.js` | 国际象棋 AI search Worker / cloud Worker 的共同入口 |
| `verify.mjs` | 国际象棋 perft / 棋核裁判 |
| `live-check.mjs` | 国际象棋 90 项真 Chrome 裁判 |
| `self-play.mjs` | 国际象棋固定 10 局稳定性审计 |
| `xiangqi.html` | 中国象棋 9×10 现代木盘 UI、纯 2D 路径、预演、真实攻击线与 PV |
| `xiangqi-engine.js` | 中国象棋规则、唯一评估函数、排序、威胁、搜索与 PV |
| `xiangqi-worker.js` | 中国象棋搜索 / 分叉 / 分析 Worker 入口 |
| `xiangqi-verify.mjs` | 中国象棋 19 项棋核 / 搜索裁判 |
| `xiangqi-live-check.mjs` | 中国象棋 43 项真 Chrome / 路由 / 上一步 / 威胁可视化 / 手机裁判 |
| `xiangqi-self-play.mjs` | 中国象棋固定 10 局稳定性审计 |
| `README.md` / `BLOCKED.md` / `PROGRESS.md` | 对外说明 / 决策边界 / 历史记录 |

没有构建工具、框架或后端。国际象棋从 CDN 载入钉死版本的 chess.js / three.js；中国象棋棋核为
仓库内纯 ES module。两个棋种分开是刻意的：规则与评估不能混成一个充满条件分支的全局状态。

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
- 国际象棋蓝线是用户选择；金线是从 AI 搜索源 FEN 逐手重放验证后的 `pv.slice(1)`，两者不能互相覆盖。

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

点分叉卡只做两步预演：蓝色“1”是用户候选，金色“2”是浅层强回应；FEN 不变。
真正点蓝色合法落点才落子。分叉排序会看对方最强回应，并额外检查一步合法同格回吃；
它仍然只是浅层局面排序，**不是胜率、概率或职业级分析**。

`getThreats()` 表示几何攻击线，并列出攻击者 / 保护者。它不保证攻击者下一手有合法吃法，
也不代表被瞄准的棋一定会丢。

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

`live-check.mjs` 用 `EXPECTED_RESULTS = 90` 锁定 90 项，覆盖：

- L0–L4 真实 geometry、DOM 分叉数和 Node 独立 perft 对撞；
- 零 `THREE.Points`、无预分配 / drawRange / 隐藏孤儿对象；
- 3D / 2D 路径、真实变体棋盘、FEN 回合、蓝 / 金两条路线；
- 棋子 SVG 几何与真实像素，避免白棋因 Unicode / 字体回退变黑；
- 棋子助手、几何攻击、合法一步吃子、回吃和亏交换；
- 390×844、短横屏、平板、安全区、44px 触控；
- AI deadline、watchdog、reset / fallback / PV 和空闲零持续帧。

数量钩子在 `chess.html` 的 `window.__test`；数量类只能从 DOM / geometry 返回。

### 4.2 中国象棋

`xiangqi-verify.mjs` 固定 19 项，覆盖：

- FEN 无损往返；
- 起始 perft 1–4；
- 马腿、象眼 / 不过河、炮架、兵过河、将帅照面；
- 将军、将死、困毙和非法着拒绝；
- 攻击者 / 保护者、唯一评估方向；
- search 合法 PV、真实根分叉、时限与 `depth=0,pv=[]`；
- 候选会看对方强回应与一步合法回吃，不把开局送炮换马排第一。

`xiangqi-live-check.mjs` 用 `EXPECTED_RESULTS = 43` 锁定 43 项，覆盖：

- 根首页两张卡可实际点击；
- 起始 32 枚棋、红 16 / 黑 16、90 个交互点；
- 起始 44 张分叉卡及每卡 FEN / 后续分叉与 Node 重放一致；
- 选棋 / 预演不改 FEN，真实落子后 Worker AI ≤3 秒且 PV 可重放；
- 连续两回合后路径 ply / FEN / 分叉继续前进，不会卡在第一步；
- 威胁固定局面、真实攻击者 / 保护者 / “攻→危”攻击流逐项同源；
- 上一步空起点 / 金色轨迹 / 落点 / 行棋文字与 Worker 真应手逐项同源；
- 双攻击者仍保留全部真线，只强调当前一条并可手动切换；
- 棋子位移、落点与威胁动效有限次停止，减少动态时仍保留全部静态语义；
- 390px 字盘比例、667×375 紧凑双栏、缩放、reset 竞态、强杀 Worker 合法 fallback；
- 1440×900、390×844、667×375 无根横向溢出，非棋盘控件 ≥44px；
- 页面静止 `requestAnimationFrame` 请求 / 回调均不增长，零 JS 错误。

数量钩子是 `window.__xiangqiTest`，公开 getters 和只读 snapshot；裁判不能信任一份页面自报总数，
必须从 DOM 和 `xiangqi-engine.js` 两边独立对撞。

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
- **分叉卡预演不是落子。** 蓝 1 / 金 2 只是候选与浅层回应；只有棋盘合法落点改变 FEN。
- **CDP 新标签可能 `document.hidden=true`。** 真 WebGL 验收要 bring-to-front 并启用 focus emulation。
- **无头 Chrome 测 WebGL 不要直接 `--disable-gpu`。** 使用 ANGLE / SwiftShader 参数。
- **`Runtime.evaluate` 的裸 `await` 会报错。** 包进 async IIFE 并设置 `awaitPromise: true`。
- **本机验收环境是 Node 22。** `/opt/homebrew/bin/node` 当前为 v22.23.1。

---

## 6. 已确认本地基线

| 指标 | 当前基线 |
|---|---|
| 根首页 | 恰好两张选择卡：国际象棋 / 中国象棋 |
| 国际象棋起始 perft 1/2/3/4 | 20 / 400 / 8,902 / 197,281 |
| 中国象棋起始 perft 1/2/3/4 | 44 / 1,920 / 79,666 / 3,290,240 |
| `npm test` | 国际 8/8 + 中国 19/19 + 门户 16/16 |
| `node live-check.mjs` | 90/90 |
| `node xiangqi-live-check.mjs` | 43/43 |
| 国际路径线程 | L1–L4 全在 cloud Worker；主线程只建 geometry |
| 国际路径生命周期 | 缩略 L3 / 明确放大 L4 / 收起释放 / 再放大完整重建 |
| 国际空闲渲染 | 静置 rAF +0、WebGL frame +0 |
| 国际棋子 | 六类分层 SVG 3D 视觉造型；零 Unicode |
| 国际搜索 | 最后完整层单条 PV；蓝=用户，金=引擎；fallback 无伪 PV |
| 中国规则线程 | search / branch 两个 Worker 实例 |
| 中国棋盘初始 | 90 个交互点、32 枚棋、44 条合法分叉 |
| 中国搜索页面预算 / watchdog | 1.1s / 2.8s；实测 AI ≤3s |
| 中国上一步 | 空起点 + 金色实线 + 落点环 + 行棋方 / 记谱 / 坐标；真实 Worker 应手同源 |
| 中国威胁 | 全部真实攻击线保留；单条主强调、“攻→危”端点与手动攻击者切换；仍只是几何攻击线 |
| 中国有限动效 | 棋子位移 / 落点 / 攻击流有限次后停止；减少动态保留静态语义，切回普通不补播；持续 rAF 为 0 |
| 国际 10 局自走 | 631 plies；五类错误汇总全 0；最大搜索 22.5ms |
| 中国 10 局自走 | 844 plies；4 终局 / 6 capped；五类错误全 0；最大搜索 23.0ms |
| 环境 | Node v22.23.1、chess.js 1.4.0、three.js 0.160.0 |

中国象棋上一步 / 攻击流运行版本 `66f5a92` 已发布，以下 SHA-256 已与 GitHub Pages 逐字节核对：

| 运行文件 | SHA-256 |
|---|---|
| `index.html` | `2a31050f7c95e0fbc460ebabe75c5014f4f3a9d432e902b4b444efb169997c09` |
| `chess.html` | `5badac7a9496a7ab2245721a830077cb6e9c3be1d0b569e6a8273ca3e3a4d12e` |
| `engine.js` | `8d20e54fd56e67ca3cd0b29c0d66f586ed5807de8e4781a623f03cf51b7a8959` |
| `worker.js` | `a065d664f7bbbf3e67f9ac5b3ea546e11cc94db4c36a2d00a30d4d4b1b1d9aed` |
| `xiangqi.html` | `4337e955ee30e3e1157a19dd0bc1f382ed5ab9cbd55b22369043b750f7dd4f9e` |
| `xiangqi-engine.js` | `e1e3c2c8862e06a9f75d9a5fedac8c5f0738df6182a9e13b77d90a006d96f290` |
| `xiangqi-worker.js` | `06c9d33c946722bd2e6bfe0d4b13e304a89de61873a06eaace49a5a093459cd4` |

线上行为复验为中国象棋 **43/43**、国际象棋 **90/90**。相邻 `e5→e4` 方向仍为 1.00；
双攻击者实测主线 / 背景不透明度为 `0.94 / 0.22`，减少动态后切回普通的运行中旧动画为 0。

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
6. **正式产品名。** 仓库名固定 `chess-cloud`，页面品牌“棋路”仍可讨论。

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
  index.html chess.html engine.js worker.js \
  xiangqi.html xiangqi-engine.js xiangqi-worker.js
do
  local_hash=$(shasum -a 256 "$f" | awk '{print $1}')
  online_hash=$(curl -fsS \
    "https://maxi-max-dev.github.io/chess-cloud/$f?v=$(date +%s)" \
    | shasum -a 256 | awk '{print $1}')
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

- 根 `index.html` 已改为两个棋种的选择首页。
- 原国际象棋完整应用已迁到 `chess.html`，原 90 项真机回归仍为 **90/90**。
- 中国象棋页面、规则核、Worker、棋核裁判、真 Chrome 裁判和固定 10 局自走均已加入。
- 最新本地：
  - `npm test`：**8/8 + 19/19 + 16/16**
  - `node live-check.mjs`：**90/90**
  - `node xiangqi-live-check.mjs`：**43/43**
  - 国际象棋 10 局：631 plies、五类错误汇总全 0、最大搜索 22.5ms
  - 中国象棋 10 局：844 plies、4 终局 / 6 capped、五类错误全 0、最大搜索 23.0ms
- 中国象棋规则边界已在页面和文档明示：没有历史状态，不判长将 / 长捉 / 复杂循环；
  威胁是几何攻击线；当前不是职业级引擎。
- 中国象棋上一步 / 攻击流运行版本 `66f5a92` 已推到 `main` 并发布；七个运行文件与线上逐字节一致。
- 线上复验：中国象棋 **43/43**，国际象棋 **90/90**。
