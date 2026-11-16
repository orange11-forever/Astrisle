# 第九阶段：真实模型验收与多格式角色导入

2026-11-16，基线 `09943b3`，功能分支 `feat/live-model-acceptance`。本轮继续总体计划 Task 15，用户随后提供 DeepSeek 测试凭据，并追加 GLB、3MF、STL、OBJ、FBX 等建模文件的角色导入。

## 模型任务验收

增加 `pnpm.cmd acceptance`：复用真实 Runtime、SQLite、文件工作副本、Windows Job 监督与 Office worker。四组场景覆盖从零编程、已有代码修改、Office 三格式创建及修改、同一工作空间连续委托；支持同结构的外部 JSON 场景和独立重复样本。

只有当前不可变产物与导出哈希一致、独立 Node/文本/JSON/Office 检查通过、源输入保持不变，才接受合成工作区的成果。报告保留任务图、事件、工具证据、输入与导出哈希、人工请求和局限。无配置、失败、阻塞、取消均有独立状态。代码场景需显式授权可信宿主进程；网络工具默认关闭。

真实 DeepSeek 调用暴露并修复了：Chat Completions 未回传 `reasoning_content`、`tool_calls: null` 被误判、计划 schema 未枚举合法任务种类/伙伴、无效计划缺少有限纠错、任务上下文缺少真实 OS/Node 路径，以及进程工具缺少 stdin。计划纠错最多两次且计入已有预算；没有按验收场景改生产逻辑。未获授权的进程/网络工具不再出现在模型可用列表。

响应 JSON 或工具参数 JSON 解析失败时，尚未向执行器返回任何调用，因此可以在现有适配器重试上限内重新请求，最多两次；持续返回无效 JSON 仍会失败。任务图现在要求每位作者（包括准备任务）都有直接独立复核，并在受理前检查隐式复核等待死锁。作者需发布完整文件后交接，复核再固定输入版本；没有把“间接依赖”当成准备笔记已经受检的证据。

DeepSeek 默认思考模式拒绝强制 `tool_choice`；最终实现继续使用自动工具选择、完整 schema 与有限纠错，不强行关闭思考。

## 角色文件

设置入口支持 GLB、自包含 glTF、3MF、STL、OBJ、FBX。先收集模型及伴随资源，再由主进程创建的隔离沙箱窗口使用真实加载器检查几何、材质、贴图和动画；可信结果绑定到一次性 token，界面伪造计数不能授权提交。成功后原子替换，失败保留旧角色。资源副本可跨岛屿使用，原始文件可以移动。格式支持矩阵、路径限制及边界详见 [模型导入记录](character-model-import.md)。

## 验证记录

本轮完整本地检查：31 个 JS 测试文件、242 项通过；Office 10 项通过；Electron/Edge 35 项通过；构建（含类型检查）与格式检查通过，共 287 项自动化测试。已有大 chunk 与 Node SQLite experimental 提示保留。

最终同一验收器构建的 DeepSeek `deepseek-flash` 实测 **9/9 通过**，均由真实模型动态规划、使用工具和独立伙伴复核，验收器再运行自己的检查。没有自动回答输入或审批请求。

| 场景 | 次数 | 结果 |
|---|---:|---|
| 从零创建统计 CLI | 2 | 通过；实际 Node 运行验证空数组、负数和统计值 |
| 修改已有标签 CLI | 2 | 通过；实际执行并核对原 README 保持不变 |
| DOCX/XLSX/PPTX 创建及后续修改 | 2 | 每次两段委托均通过；修改后原文件结构保留、源单元格数值独立核对 |
| 同一工作空间连续委托 | 2 | 每次两段委托均通过，第二段读取并保留先前数据 |
| 实现后追加的括号校验 CLI | 1 | 通过；包含嵌套、交叉、孤立闭括号和空字符串 |

可复查摘要含输入哈希、步骤数、版本与导出哈希、检查结果和本地原始报告路径，见 [真实验收摘要](../validation/stage-9-live-model-summary.json)。[追加任务](../validation/stage-9-unseen-brackets.json)可通过 `--scenario-file` 重跑。9 个样本的验收器 SHA-256 均为 `4f78eeb6ccd49be6258b222b1d670e369b4483ca3d7b701e57edb3970f0711b7`，共覆盖 13 段委托。

此前同构建一轮曾为 5/8：两次模型工具参数出现非法 JSON，另一次 Office 准备笔记未被最终复核直接覆盖。这些失败保留在 `.astrisle-acceptance/`，推动了有限 JSON 重试和直接复核/死锁校验修复；本表是修复后的完整新一轮结果，没有把旧失败改写成成功。

使用当前 `.astrisle-dev/` 配置和蓝发模型的独立副本核对最新 Electron 构建全景与角色特写，三位角色模型/朝向正确，页面异常为零，源配置和资产前后哈希一致。验证窗口明确标为当前模型验证，测试夹具窗口与正式展示分开；临时应用数据在关闭后清理，截图保留在本地忽略目录。

独立代码审查提出三项 Important：缺少进程监督能力仍放行预检、对象键未脱敏、导入提交信任 renderer 计数。三项均以失败回归复现后修复；另补了 3MF warning/error 前缀识别和部分资源丢失拒绝测试。

早期 8 个真实样本在规划阶段停止，另一个强制工具探针返回 400。早期输出曾放在 Playwright 的 `test-results/` 下，被浏览器测试清理；仅保留本轮工具输出中的摘要，不能作为完整可复查证据。现改为独立的 `.astrisle-acceptance/`，后续成功和失败样本均保留。

## 使用

```powershell
$env:ASTRISLE_PROVIDER_KIND = 'openai-compatible'
$env:ASTRISLE_PROVIDER_URL = 'https://api.deepseek.com'
$env:ASTRISLE_PROVIDER_MODEL = 'deepseek-flash'
pnpm.cmd acceptance --list
pnpm.cmd acceptance --scenario all --repeat 2 --allow-process --key-stdin
```

终端出现 `API key input ready (hidden)` 后输入密钥。也可使用当前进程的 `ASTRISLE_PROVIDER_API_KEY` 环境变量。`--check` 只做预检查，不请求模型。`--scenario-file` 接收自定义 JSON 场景；格式以 `tests/acceptance/scenarios.ts` 为例。默认每委托 40 步、5 分钟活动时间、2 次返工和 5 分钟墙钟上限。单个模型步骤内部可能因传输或 JSON 错误重试最多两次，步骤数不是计费请求数或 token 用量。退出码 0 表示所选任务通过，1 表示失败/阻塞，2 表示参数或配置缺失，130 表示取消。预检查的 0 仅表示配置就绪。

`.astrisle-acceptance/` 保存报告和独立运行数据，不进入 Git，也不属于可随意清理的浏览器截图缓存。密钥没有写入此目录或桌面配置。

## 保留范围

真实模型样例不代表任意开放式任务都能成功。Office 仍只核验结构和数值，未做原生应用打开、版式与公式引擎重算。安全写回、发行包、完整异常恢复、长期资源及低配置硬件验收继续保留。静态网格不自动变成专业绑骨角色，复杂材质/扩展和缺失贴图会明确报错。
