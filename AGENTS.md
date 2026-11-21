# Astrisle 仓库协作指南

Astrisle 是 Windows 上的多智能体桌面工作台。一座岛屿对应一个项目工作空间，一份委托有自己的目标、验收条件、权限和预算。运行时负责执行，3D 场景呈现真实工作状态。

## 从哪里开始

先用 `git status --short --branch` 确认当前分支和已有改动。Windows 若报 `dubious ownership`，核对工作树归属后，可向单次 Git 命令传入 `-c safe.directory=仓库绝对路径`，路径使用正斜杠。用户操作见 README，后续功能清单链接到各阶段的开发记录。[README](README.md) · [后续功能清单](docs/development/modern-features-backlog.md)

| 改动内容 | 代码入口 |
| --- | --- |
| 工作面板、角色设置、3D 场景 | `apps/client/src/`。`App.tsx` 连接面板与桌面 API，`Scene.tsx` 和 `director.ts` 根据快照安排角色活动。 |
| 桌面 API、凭据和本地模型 | `packages/contracts/src/index.ts` 定义 `HostAPI`。`apps/desktop/src/preload.ts` 暴露接口，`main.ts` 校验 IPC 调用，`characters.ts` 保存角色档案。 |
| 规划、调度、复核和恢复 | `packages/domain/` 校验任务图，`packages/runtime/` 执行委托，`packages/persistence/` 保存 SQLite 快照、事件和回执。 |
| 工具、成果和工作副本 | `packages/executor/` 提供工具，`packages/artifacts/` 管理不可变成果版本，`packages/workspace/` 管理副本、导出和写回。 |
| 文档转换与 Windows 辅助程序 | `workers/office/` 转换并回读办公文件，`workers/process/` 监督 Windows 子进程，`workers/winfs/` 执行原项目写回。 |

## 修改时保留的行为

- 角色以稳定 ID 关联任务、成果与复核证据，姓名和模型可更换。新委托保存提交时的伙伴名单，旧委托按保存的名单恢复。用户化身只参与岛上活动，同一成果的生产和复核须由不同伙伴承担。
- 伙伴对话按委托 ID 和伙伴 ID 隔离。从当前委托快照选取相关摘要，按本次发给模型的资料校验引用。点击文件引用时，打开所引版本。对话通过只读运行时方法接入，执行工具和变更委托仍走各自的命令入口。
- 角色依据真实任务和交接事件工作，空闲时自动散步和休闲。保留自由视角、2D 模式和减少动效。展示用户当前的蓝发女仆时，用 `pnpm.cmd demo` 加载已配置的模型。自动化测试使用合成模型。
- 渲染进程通过 preload 的 `HostAPI` 访问桌面能力。文件选择、可信模型检查和凭据处理在桌面端完成。新增接口时同步核对共享类型、preload 暴露项及主进程的调用者和参数校验。[模型导入流程](docs/development/character-model-import.md)
- 委托在独立工作副本中运行，原项目写回沿用预览、确认和恢复流程。有副作用的调用保留请求标识和回执，重启后先核查未知结果，避免重复执行。[写回与恢复](docs/development/stage-10.md)

## 开发与验证

命令在仓库根目录的 PowerShell 中执行，使用 `pnpm.cmd`。Node.js 最低版本为 22.13。首次安装按 README 准备 Electron、esbuild 和项目 `.venv`。`pnpm.cmd dev` 启动开发桌面，改动主进程、preload 或运行时后需重启。[本地启动](README.md#本地启动)

先运行与改动直接相关的测试。完整 Windows 验证按下列顺序执行，Electron 用例会加载 `dist/` 中的桌面构建。[CI 配置](.github/workflows/ci.yml)

```powershell
pnpm.cmd typecheck
pnpm.cmd format:check
pnpm.cmd test --maxWorkers=2
pnpm.cmd test:publishing
pnpm.cmd build
pnpm.cmd test:ui
```

`tests/integration/` 覆盖运行时、持久化和桌面服务，`tests/e2e/` 覆盖 Edge 与真实 Electron。桌面测试复用 `tests/fixtures/electron.ts`，传入独立的临时数据目录。报告模型验收时注明使用本地脚本服务还是真实提供方。

Windows CI 的 `tmpdir()` 可能包含 `RUNNER~1` 这样的短路径。测试创建临时目录并将其交给工作区路径校验时，用 `await realpath(await mkdtemp(...))` 取得规范路径。

## 本地数据与交付

- `.astrisle-dev/` 保存用户模型、工作副本、凭据配置和 SQLite 状态。`.astrisle-acceptance/` 保存本地验收产物。两者都保留在 Git 之外。遇到运行时占用，先检查托盘和持有进程，通过托盘退出应用，保留 `runtime-owner.sqlite`。
- 阶段开发使用功能分支，用户可见的操作变化同步更新 README。提交 PR 时列出实际运行的验证和待核实项，由用户决定合并。
- 需要并行开发时，按独立文件或模块分工。Codex 并行开发采用项目约定的 `gpt-6.2-sol` 和 `xhigh` 推理档位。
