# 第十阶段：安全写回与中断恢复

用户确认先完成原定安全写回，实时工作台、Agent 扩展和 3D 互动安排下次开发。基线为 main 的 `0925c31`；在 `feat/safe-writeback` 实现，沿用现有预览和独立原生确认。

## 交付与约束

- 仅已全部验收的当前委托可写回其导入原目录。预览绑定需求修订、已接受产物版本、工作副本清单和原基线；确认后重新核查。新建项目仍导出到新目录。
- 当前发布/复核协议不包含删除成果，运行时也拒绝整合未复核删除。因此本阶段写回新增、修改文件；预览仍列出删除，但含删除或其他未受检差异时阻止写回，不能以原生确认替代证据。
- 写回使用独立 Windows C# helper，限本机 NTFS 普通文件。固定目录句柄与独占文件句柄、锁内哈希重检、CREATE_NEW、备份和逐文件持久日志。最多 512 个文件，单文件 32 MiB，总量 256 MiB；拒绝重解析路径、硬链接、UNC、设备路径和路径别名。
- 原项目 Git 元数据不进入候选或写回。用户导入时的未提交内容就是基线，不把 Git HEAD 当作可覆盖版本。
- 备份在修改前持久化。多文件写回不宣称事务原子性；进程中断后的未知或部分结果先核查，旧调用不自动重放。
- 恢复仅还原身份和哈希仍符合本操作记录的文件；外部后续修改/替换和无法判定的部分字节保留并显示冲突。备份继续可用于人工核查。回滚自己的新增文件使用持有的文件句柄，创建的空目录可保留。
- SQLite 先记录 applying，再启动 helper；未核清操作阻止同工作区的新写委托。重启仍可查看操作和核查/恢复。应用退出等待已受理写回，不把关闭窗口当作回滚。

## 实现选择

采用现有 .NET Framework C# 编译方式，不增加依赖；Node 负责版本绑定和用户流程，原生程序负责最终文件访问条件。单纯 hash 后 writeFile 无法关闭竞争窗口；跨文件整体原子替换也不能准确承诺。

原生协议：apply 输入版本、操作目录、原目录和 create/modify 文件清单（beforeHash/afterHash/candidatePath）；inspect 接收操作目录，依据自身持久记录核查。rollback 必须携带 inspect 生成的状态凭证，在最终锁内绑定所有文件身份、哈希、状态和恢复范围。标准输出返回状态、逐文件核查和可恢复标记，并由调用方核对与计划的一致性。测试故障点只在独立 TEST_HOOKS 构建存在。

## 界面

成果面板显示写回历史和待核查记录；预览显示原目录、变更路径、文本前后内容/截断或二进制说明。应用和恢复均经独立原生确认。失败明确区分冲突、不可用和结果未知；恢复前展示逐文件状态。

参考：[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)、[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)。目录固定需要 FILE_LIST_DIRECTORY；只请求 FILE_READ_ATTRIBUTES 的句柄不能可靠阻止重命名，已用实际 NTFS 探针核实。
