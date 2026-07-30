# chess-cloud 进度

## 我理解的目标（开工前写，≤10 行）
1. 目标：网页版国际象棋，人执白落子后，把「这步之后所有可能未来」炸成三维星云；星色=局面评估（白优暖/黑优冷）；AI 执黑陪下。
2. 让步顺序：算得对 > 看得震撼 > 功能全 > 加载快。数字对不上就是失败，宁可少画也不许假数。
3. 顺序：任务 0 环境核对 → 1 棋核+verify.mjs（冻结）→ 2 星云+__cloudStats → 3 上线 Pages 并在线上重跑验收。
4. 最大风险：__cloudStats().nodes 必须等于 count(fen,depth)，且必须读 three.js 几何体真实顶点数。
   对策：每批星云用「精确大小」的独立 BufferGeometry，nodes = 所有几何体 position.count 求和，绝不自记计数器；
   预分配+drawRange 一律不用（那等于自记计数器）。
5. 次风险：4 层 197,281 节点同步算会卡死 8 秒 → 必须真 Worker 分批流回；AI 用迭代加深+2.0s 预算保证 ≤3s 应手。
6. 第三风险：评估函数只允许一份 → 抽成 engine.js，主线程（星色）和 Worker（minimax 叶子）都 import 同一个 evaluate()。

## 任务 0 环境核对（2026-07-30，实测）
- `node -v` → v22.23.1（/opt/homebrew/bin/node，符合铁律 node@22）
- `npm i chess.js@1.4.0` → added 1 package；node_modules/chess.js package.json version = 1.4.0
- `node -e "new Chess().moves().length"` → **20** ✅ 与任务书一致
- `gh auth status` → ✓ maxi-max-dev 已登录，scopes 含 repo ✅
- 结论：环境与任务书完全对得上，无需停工，BLOCKED.md 顶部无异常。

## 任务进度
- [x] 任务 0 环境核对
- [ ] 任务 1 棋核 + verify.mjs
- [ ] 任务 2 可能性星云
- [ ] 任务 3 上线
