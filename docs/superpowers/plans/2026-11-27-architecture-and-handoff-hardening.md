# Astrisle 协作交接、存储扩展、打包安全与前端减负实施计划

日期：2026-11-27 ｜ 基线：`main@084571f` ｜ 工作分支：`feat/stage20-handoff-and-hardening`  
关联文档：[第 20–22 阶段建议路线图](2026-11-27-v01-candidate-roadmap.md) · [DeepSeek Flash 实测记录](../../validation/2026-11-24-deepseek-flash.md) · [仓库协作指南](../../../AGENTS.md)

---

## 1. 背景与目标

围绕 v0.1 Windows 试用候选的质量、性能与独立安装落地要求，本计划集中解决当前架构评估中识别出的 **4 组高收益、低震荡改进项**，并将需要大范围拆表的结构性重构明确后置到 v0.2：

1. **多输入原子交接与复核范围自愈（P0，对应第 20 阶段核心缺陷）**：消除上游多文件任务发布首个文件即唤醒下游渲染任务的抢跑竞态；收敛复核任务上下文暴露范围，并在复核者误传额外版本 ID 时返回可恢复的结构化错误与应审版本列表，允许在原步数预算内自行纠正。
2. **SQLite 增量事件写入与轻量委托摘要索引（P1，运行期与启动减负）**：消除每次状态推进全量重扫 `snapshot.events` 写入 `outbox` 的 $O(N^2)$ 写放大，并为 `projects` 表增加 `summary_data` 摘要列，使 `bootstrap()` 无需反序列化历史委托的完整证据与事件大 JSON。
3. **打包态外部资源解耦、渲染层 CSP 与私网解析拦截（P0 / P2，面向第 22 阶段安装包与安全纵深）**：分离开发态 `projectRoot` 与 Electron 打包态 `process.resourcesPath` 下的辅助程序（`process-supervisor.exe`、`safe-apply.exe`）及 Office Python 路径；为桌面窗口注入严格 CSP 响应头；在 `web_read` / `web_search` 中使用 `net.BlockList` + `dns.lookup` 拦截公网域名解析至环回、链路本地与私网网段的 DNS Rebinding 行为。
4. **前端快照同步减负、3D 静态图元复用池与主舞台卡点直达（P1 / P3，面向第 21–22 阶段帧率与首次上手体验）**：消除每次快照推送触发冗余 `host.bootstrap()` IPC 往返；在主舞台底部 `.commission-dock` 提供待答请求、待验收成果和暂停原因的一键直达入口；对主岛高频静态基础几何与标准材质做模块级单例池化复用。

---

## 2. 必须保留的系统不变量

实施过程中严格保持以下既有行为不变：

- **身份与分工隔离**：角色以稳定 `CharacterId` 关联任务、成果与复核证据；用户化身 `'user'` 不承担生产或复核；同一成果的生产者与复核者必须为不同伙伴。
- **不可变成果与真实回执核验**：成果按 SHA-256 内容寻址只读存储；`submit_review` 通过结论仍必须具备对全部应审输入版本的真实文件检查证据（`workspace_read` / `inspect_delivery` 哈希一致）及已绑定的网页原文独立读取回执；缺乏有效检查证据（如仅列目录 `weak` 用例）仍降级为 `unable_to_verify` 并暂停。
- **中断恢复与幂等性**：保留 `runtime_generation` 世代隔离与 `outcome_unknown` 人工核对机制，重启绝不自动重放副作用工具调用；保留请求 `requestId` 回执幂等。
- **空间与无障碍约束**：3D 场景单向消费 `ProjectSnapshot`，不反向驱动业务命令；保留自由视角、固定镜头、减少动效、2D 模式，以及 `390×844` 窄视口下 `.camera-hint` 与 `.commission-dock` 不重叠、无横向滚动条的布局约束。

---

## 3. 并行工作流与独占文件边界

4 个实施子智能体共享工作树，按**完全不重叠的文件集合**并行开发；跨包串联与全量构建验证统一放在阶段五由主控智能体完成，避免 Windows 下辅助 `.exe` 编译锁与并发全量测试争用磁盘。

| 编号 | 子智能体角色 | 独占修改 / 新增文件 | 禁止触碰范围 |
| --- | --- | --- | --- |
| **A** | Runtime & Domain Handoff Engineer | `packages/domain/src/index.ts`<br>`packages/runtime/src/index.ts`<br>`tests/integration/runtime-domain.test.ts`<br>`tests/integration/runtime-handoff-scope.test.ts`（新增） | `packages/persistence`、`packages/executor`、`apps/*` |
| **B** | Persistence Scalability Engineer | `packages/persistence/src/index.ts`<br>`tests/integration/persistence-scalability.test.ts`（新增） | `packages/runtime`、`packages/domain`、`apps/*` |
| **C** | Desktop Packaging & Security Engineer | `apps/desktop/src/paths.ts`（新增）<br>`apps/desktop/src/security.ts`<br>`apps/desktop/src/main.ts`<br>`apps/desktop/src/runtime-process.ts`<br>`packages/executor/src/index.ts`<br>`packages/executor/src/web.ts`<br>`tests/integration/security-and-paths.test.ts`（新增） | `packages/contracts`、`packages/runtime`、`apps/client` |
| **D** | Client Performance & Stage UI Engineer | `apps/client/src/dock-status.ts`（新增）<br>`apps/client/src/dock-status.test.ts`（新增）<br>`apps/client/src/App.tsx`<br>`apps/client/src/Scene.tsx`<br>`apps/client/src/styles.css` | `apps/desktop`、`packages/*`、`tests/e2e` |

---

## 4. 分步详细设计

### 步骤一（子智能体 A）：多输入交接与复核自愈语义

1. **`packages/domain/src/index.ts` —— 统一 `artifact_available` 交接边界**
   - 修改 `ready(task, snapshot)`：移除 `task.kind !== 'review' ||` 特例，使所有使用 `artifact_available` 的下游任务（包括 `implement`、`integrate` 与 `review`）均要求上游依赖满足：
     `(dep?.kind === 'review' || ['awaiting_review', 'passed'].includes(dep?.status ?? '')) && dep?.outputArtifactIds.some((outId) => snapshot.artifacts.some((a) => a.id === outId && a.validity === 'current'))`。
   - 保持 `.some(...)` 而非 `.every(...)`：若作者在同一任务内重复修订同一路径，旧版 `artifact.id` 会变为 `stale` 并留在 `outputArtifactIds` 中，而 `complete_task` 已保证工作区全部变更文件均以 `current` 状态发布并完成集成后才进入 `awaiting_review` / `passed`。

2. **`packages/runtime/src/index.ts` —— 消除半途唤醒、收敛复核视野与范围错误自愈**
   - `submit_artifact`：移除末尾提前触发的 `this.kick(id)`，避免作者尚未发布第 2 份文件或未完成工作区集成时触发无意义的调度尝试；在 `complete_task` 成功集成并更新状态后调用 `this.kick(id)` 立即唤醒下游伙伴。
   - `runTask` 用户消息构造：当 `task.kind === 'review'` 时，`availableArtifacts` 仅包含本任务固定的待审输入（`inputs.map(artifactWithoutWebSources)`），并显式提供 `expectedReviewVersionIds: inputs.map((a) => a.versionId)`，防止模型把其他下游渲染任务的成果版本混入本次复核。
   - `review()` 范围校验：当 `unchanged && expected.length > 0` 时，计算 `outOfScopeVersions = versions.filter((v) => !expected.includes(v))` 与 `missingExpectedVersions = expected.filter((v) => !versions.includes(v))`。若存在越界版本（`outOfScopeVersions.length > 0`），或 `verdict === 'pass' && validEvidence && missingExpectedVersions.length > 0`，返回可纠正的工具结果：
     ```ts
     {
       ok: false,
       code: 'REVIEW_VERSION_SCOPE_MISMATCH',
       expectedVersionIds: expected,
       output: `Submit review only for this task's pinned current input versions (${expected.join(', ')}). Remove unrelated versions and include every pinned input version.`,
     }
     ```
     当 `!validEvidence`（未读取待审文件）且无越界版本时，维持原有降级为 `unable_to_verify` 并暂停委托的行为。

3. **回归与集成测试**
   - 更新 `tests/integration/runtime-domain.test.ts`：覆盖多输出作者处于 `running` 且仅发布首份文件时下游 `implement`（`artifact_available`）保持等待，进入 `awaiting_review` 后立即就绪。
   - 新增 `tests/integration/runtime-handoff-scope.test.ts`：
     - 双输入源稿（`brief.md` + 晚到的 `budget.csv`）自动交接给下游渲染任务，核对渲染任务启动时机与 `inputVersions` 完整性；
     - 两份源稿发布之间重启运行时，恢复后继续发布第二份文件并交接，无重复发布；
     - 源稿复核者首次提交夹带下游版本 ID，收到 `REVIEW_VERSION_SCOPE_MISMATCH` 与 `expectedVersionIds` 后在原预算内纠正并通过复核。

---

### 步骤二（子智能体 B）：SQLite 增量事件写入与摘要索引

1. **`packages/persistence/src/index.ts` —— Migration v7 与轻量读取**
   - 核查 `daily-news.ts` 已使用迁移版本 `5`、`6`，因此在 `initialize()` 事务内新增版本 `7`：检查 `PRAGMA table_info(projects)` 是否含 `summary_data` 列；若无则 `ALTER TABLE projects ADD COLUMN summary_data TEXT`，遍历现有 `projects` 行将 `JSON.stringify(JSON.parse(data).commission)` 回填至 `summary_data`，并写入 `INSERT OR IGNORE INTO migrations VALUES(7)`。
   - 新增 `commissions(): Commission[]`：按 `ORDER BY rowid` 查询 `SELECT summary_data, CASE WHEN summary_data IS NULL THEN data END AS data FROM projects`，优先解析 `summary_data` 以避免从磁盘溢出页读取大体积 `data`（若为空则回退解析 `data` 的 `.commission`）。
   - 优化 `save(snapshot)`：
     - 同步写入 `summary_data = JSON.stringify(snapshot.commission)`；
     - 查询 `SELECT count(*) AS cnt, min(sequence) AS min_seq, coalesce(max(sequence), 0) AS max_seq FROM outbox WHERE project_id=?`：当 `cnt > 0 && min_seq === 1 && cnt === max_seq`（已连续持久化 `1..max_seq`）时，仅对 `event.sequence > max_seq` 的新事件执行 `INSERT OR IGNORE INTO outbox`；若存在历史跳号则安全回退全量检查，兼顾 $O(1)$ 常态性能与极端数据完备性。

2. **集成测试**
   - 新增 `tests/integration/persistence-scalability.test.ts`：验证 v4 旧表结构升级回填、`commissions()` 与 `projects().map(p => p.commission)` 严格一致，以及 50 次连续事件推进时 `outbox` 仅写入新增事件且不重复触发已有行写入。

---

### 步骤三（子智能体 C）：打包资源解耦、CSP 与私网解析防护

1. **打包态与开发态外部资源路径解耦**
   - 新增 `apps/desktop/src/paths.ts`：导出 `DesktopResourcePaths` 与 `resolveDesktopPaths({ projectRoot, resourcesPath, packaged, platform })`：
     - 开发态（`!packaged`）：解析到 `dist/helpers/*.exe`、`.venv/.../python` 与 `workers/office/worker.py`；
     - 打包态（`packaged`）：解析到 `process.resourcesPath` 下的 `helpers/*.exe`、`office-python/...` 与 `workers/office/worker.py`。
   - `packages/executor/src/index.ts`：`createExecutor` 新增可选参数 `supervisorPath`、`safeApplyPath`、`workerPath`（未传时完全沿用基于 `projectRoot` 的默认值，保证现有全部测试零改动兼容）。
   - `apps/desktop/src/main.ts` 与 `apps/desktop/src/runtime-process.ts`：在初始化阶段传入 `resolveDesktopPaths(...)` 结果。

2. **渲染进程严格 CSP 注入**
   - `apps/desktop/src/security.ts`：新增 `contentSecurityPolicy(devOrigin?: string)`：
     - 打包/本地文件模式：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`；
     - 开发模式（`http://127.0.0.1:5173`）：仅在开发态额外允许 Vite HMR 所需的本机 `http/ws` 与内联模块引导脚本。
   - `apps/desktop/src/main.ts`：通过 `window.webContents.session.webRequest.onHeadersReceived` 对应用文档响应注入 `Content-Security-Policy` 头，确认不影响隐藏角色校验页 `character-validator.html` 的本地脚本与 Blob 模型加载。

3. **`packages/executor/src/web.ts` —— 防 DNS Rebinding 私网访问**
   - 构建 `node:net` `BlockList`，覆盖 IPv4/IPv6 未指定地址、环回（`127.0.0.0/8`、`::1`）、链路本地（`169.254.0.0/16`、`fe80::/10`）、RFC1918 私网（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、CGNAT（`100.64.0.0/10`）、唯一本地地址（`fc00::/7`）及 `::ffff:` IPv4 映射地址。
   - 当请求目标主机名不是 `'localhost'` 且不是用户在授权列表中显式指定的字面量 IP（`net.isIP(hostname) === 0`）时，在每跳请求前执行可注入的 `lookup(hostname, { all: true, verbatim: true })`，任一解析结果落入受限地址段即抛出 `ToolError('SCOPE_DENIED', ...)`。

4. **集成测试**
   - 新增 `tests/integration/security-and-paths.test.ts`：覆盖开发/打包路径解析、双模式 CSP 策略串、私网/环回/映射 IPv6 判定、DNS Rebinding 拦截及显式 `127.0.0.1` 测试源放行。

---

### 步骤四（子智能体 D）：前端快照减负、3D 图元复用池与底栏直达

1. **`apps/client/src/App.tsx` —— 消除冗余 `bootstrap()` IPC 风暴**
   - 在 `host.onSnapshot` 订阅中：若当前 `bootstrap.commissions` 已存在同一 `commission.id`，则用函数式 `setBootstrap` 原地更新该条 `Commission` 摘要（字段未变则直接返回原引用避免重渲染）；仅在 `bootstrap` 尚未加载或出现未知新委托 ID 时才触发 `refresh()`。

2. **`apps/client/src/dock-status.ts` + `App.tsx` + `styles.css` —— 主舞台卡点直达**
   - 新增纯函数 `deriveDockAction(snapshot)`：
     - 存在 `openRequests`：区分 `git_delivery`（「查看 Git 交付」→ `artifacts`）与常规输入/审批（「去处理（N）」→ `requests`）；
     - `status === 'awaiting_acceptance'`：「去验收成果」→ `artifacts`；
     - `status === 'paused'`：显示 `commission.summary`（单行省略）+「查看原因」→ `goal`；
     - 其余状态返回 `null`。
   - 在 `.commission-dock` 内紧凑渲染该直达动作，保留原有任务计数与「新委托」按钮语义，确保 `390×844` 窄屏下不增高侵入 `.camera-hint`、不产生横向溢出。
   - 新增 `apps/client/src/dock-status.test.ts` 覆盖全部状态优先级分支。

3. **`apps/client/src/Scene.tsx` —— 静态几何体与标准材质单例池**
   - 为 `<Box>`、`<Sphere>`、`<Cylinder>`、`<Ring>` 提取模块级共享 `BufferGeometry` 缓存与按 `(color, roughness, metalness)` 索引的 `MeshStandardMaterial` 缓存，直接通过 `<mesh geometry={...} material={...}>` 挂载，避免主岛百余个静态摆件重复创建 GPU 缓冲与材质对象，且卸载单个组件时不误销毁共享单例。

---

### 步骤五（主控智能体）：跨模块串联与完整 Windows 验证

1. **跨模块串联与代码复查**
   - 在 `packages/runtime/src/index.ts` 的 `bootstrap()` 中将 `this.store.projects().map((s) => s.commission)` 切换为 `this.store.commissions()`；
   - 审查 `git status` 与全部改动文件 diff，核查用户可见文案是否需要同步说明至 `README.md`。
2. **按 `AGENTS.md` 顺序执行完整 Windows 验证**
   ```powershell
   pnpm.cmd typecheck
   pnpm.cmd format:check
   pnpm.cmd test --maxWorkers=2
   pnpm.cmd test:publishing
   pnpm.cmd build
   pnpm.cmd test:ui
   ```
3. **回填本计划的验证结果章节**，汇总通过用例数与改动范围。

---

## 5. 本地验证结果（2026-11-27）

在 Windows 工作树分支 `feat/stage20-handoff-and-hardening` 上按仓库约定顺序跑完完整验证链路（模型相关集成与桌面验收用例均使用本地回环脚本服务；真实模型提供方如 DeepSeek Flash 的两阶段原始办公实测留待第 20 阶段在线回归执行）：

- `pnpm.cmd typecheck`：通过（0 错误）
- `pnpm.cmd format:check`：通过（`All matched files use Prettier code style!`）
- `pnpm.cmd test --maxWorkers=2`：通过（59 个测试文件，**555 项单元与集成测试全部通过**，含新增双输入交接/复核范围自愈、SQLite 迁移 v7 与增量 `outbox`、打包路径/CSP/私网 DNS Rebinding 拦截及底栏状态推导用例）
- `pnpm.cmd test:publishing`：通过（**17 项 Office 转换与回读测试全部通过**）
- `pnpm.cmd build`：通过（客户端与桌面端 `dist/` 构建完成）
- `pnpm.cmd test:ui`：通过（**71 项 Edge 与真实 Electron 端到端测试通过**，1 项原生系统时钟唤醒按默认开关跳过）

---

## 6. 延后至 v0.2 的结构性演进项（不在本轮候选期展开）

- `@astrisle/contracts` 引入 Zod 作为 IPC Schema 与 TypeScript 类型的唯一真源，自动生成 `preload` 与 `main` 校验绑定；
- 将 `packages/runtime/src/index.ts` 拆分为调度内核与可插拔 `CapabilityPolicy`（Office / WebResearch / GitHubSkills）；
- `runTask` 远期工具长输出滑动折叠与四协议 `usage` Token 计量账本；
- 多模型配置档案（Provider Profiles）与按伙伴/职责绑定异构模型交叉复核；
- 受审文件删除（Tombstone Artifact）全链路支持。
