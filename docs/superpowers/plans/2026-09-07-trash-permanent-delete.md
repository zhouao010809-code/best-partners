# Trash Permanent Delete Implementation Plan

> **For agentic workers:** Use subagent-driven-development with separate native and UI ownership. The user explicitly requests permanent deletion in the existing recycle bin; implement directly without another product approval. Preserve the dirty linked worktree and do not commit unrelated changes.

**Goal:** 用户可在回收站对选中 Markdown 预览并确认彻底删除，删除后不能在 App 恢复；其他资料、附件、知识和历史保留。

**Architecture:** 延续现有回收服务和原生私有目录，增加 deleting/deleted 状态与不可变删除确认日志。预览绑定回收编号、令牌、文件身份/字节与引用，只有明确提交才调用受限 native purge；启动和普通核验不自动删除。删除记录保留用于幂等与显示结果，不保留可恢复正文。

**Tech Stack:** React / TypeScript / Fastify / SQLite / macOS N-API / Vitest / Electron Playwright。

## 决策与边界

- 单条“彻底删除”，一次确认，不增加批量清空、定时清理或输入标题门槛。
- 确认框写明“删除后无法从 App 恢复”，展示标题、路径和已有知识引用；只删回收站的指定 Markdown，不清理历史归档/入库前镜像或系统备份，不承诺磁盘取证级擦除。
- 终态 deleted 不再提供恢复/删除操作，可折叠查看删除记录。重新导入同路径新文件正常可见，不被旧 deleted 记录永久遮蔽。
- 原始规则中的“不提供永久删除”由本次用户明确指令替换为“仅允许用户在 App 内对已回收文件单独确认彻底删除”，AI 仍不能自动删除或清空。

## 1. 契约与持久状态（主 Agent）

- [x] 先给 personal-trash-service 增加红灯：previewDelete 不删，delete(id,token) 才删、重复提交不重复写，恢复 deleted 拒绝；迁移 010 旧记录不丢失。
- [x] `src/shared/api/trash.ts` 增加 deleting/deleted 与 deletedAt，`TrashDeletePreview = TrashPreview & {token:string}`；`POST /:id/delete-preview {}`，`POST /:id/delete {token}`，沿用 session/CSRF 和 strict schema。
- [x] `011_personal_trash_delete.sql` 原样复制旧回收数据到扩展表；新增 delete_manifest_json/deleted_at，active path 唯一约束排除 restored/deleted。readMaterialVisibility 同样排除 deleted。
- [x] 删除提交验证当前规则、引用和回收文件身份/内容；写 `{id}.delete.json` 不可变意图，然后标记 deleting，再调用 `port.purge(id, identity, bytes)`，最后 deleted。重复令牌和丢失响应查询同一编号。
- [x] 任何删除意图存在时 restore 禁止，普通 retry/recover 只观察：文件仍在保留 deleting，文件消失且有合法确认意图才完成 deleted；未知或变化保留并报错，绝不自动 unlink。
- [x] 覆盖规则/引用/文件变化、错误令牌、索引更新失败、恢复中禁止删除、删除中禁止恢复、重启无自动删除、同路径新文件与历史保留。运行 service/API/visibility/迁移的相关测试。

## 2. 原生单文件删除（native Agent）

- [x] 先测试 `purge(id, expected, expectedBytes)` 缺失，再在 `trash-native.ts` 与 `native/macos/sandbox-archive.c` 实现，仅能删除持有锁的私有回收目录内 UUID.md。删除前校验身份、字节、类型、单链接及路径链；禁止递归删除、任意路径、符号/硬链接。
- [x] recovery 文件名只扩展允许 UUID.delete.json，原有 UUID.intent.json 不变。不删除日志或其他槽，不触碰大脑原路径。
- [x] native 契约覆盖正确删除、缺失/重复、错误身份/内容、软硬链接、目录、恢复后拒绝、关闭句柄、其他槽/附件/知识不变；构建与 scoped native tests。

## 3. 回收站 UI（UI Agent）

- [x] 组件/API 测试先验证新增按钮与只预览不删；新增红色“彻底删除”按钮和一次确认框，复用暗色左导航与现有焦点管理。
- [x] client.trash 增加 previewDelete(id,signal?) 与 delete(id,token)。pending action 增加 delete/token；未知结果查询同一编号，成功不再给恢复，失败保留上下文可重试，不把查询/恢复混成删除。
- [x] 回收站分组 active/restored/deleted；deleting 可重新打开删除确认，普通“继续核验”只查状态。删除记录折叠；空回收站不残留已删除项。
- [x] 增加 development/packaged Electron 单条取消→确认删除→重启仍已删→不能恢复、知识/附件不变，1440/390 截图。测试只用守卫临时库，无真实删除或模型请求。

## 4. 验收与部署（主 Agent）

- [x] 独立审查实现与规格，再审查质量；修复实际问题。完成与改动相称的集成、组件、native 和真实 HTTP/SQLite 验证及构建。
- [x] 等原生构建结束后统一打包，开发/打包 Electron 验证；测试进程结束后才打开真实 App，GET 检查已有回收/提炼记录，绝不对真实文件调用删除 API。
- [x] README 更新入口与不可恢复范围，清理临时测试根，保存有效证据，更新/清空 vault 99，git diff --check。

## 验证与审查记录

- 单元 660 项、组件 307 项通过；client/server/electron 类型检查通过。
- 全量集成 293 项通过；随后针对独立审查发现的令牌复用、GET 未登记状态两个问题补红灯并修复，最终服务/API 40 项通过。此最终 scoped 运行不冒充再次全量运行。
- 原生回收契约 45 项（其中本轮删除新增 13 项）、原有归档/入库 35 项、sandbox 24 项，共 104 项通过。原生仅删除锁定私有回收目录的 UUID.md，macOS 没有原子 inode 比较删除；该既有同用户非协作竞争边界未被包装为取证擦除或断电保证。
- 真实 native / 磁盘 SQLite / HTTP 流程 3 项通过：取消预览不产生删除日志；确认后槽文件消失，重复确认幂等、重启已删除、恢复拒绝；原路径的新文件可正常显示，知识和附件不变。
- 独立审查修正了一个授权绑定问题：每次删除预览使用新 token，旧请求只能使用自身已确认的规则和引用。第一次确认写 `{id}.delete.json`，后续明确确认写 `{token}.delete.json`，均不可覆盖；DB 只在确认后指向新记录。打开新预览不会为旧请求更新权限。
- 若删除意图已持久化但 DB 更新中断，GET 会先核验并显示 deleting，而非误告知“尚未登记、可取消”；核验不会执行 unlink。独立复核对应 5 项通过，未发现剩余 P1/P2。
- 原生、客户端、服务端和 Electron 构建及重新打包通过。最终资源 `index-DUqPNAQ-.js`、`index-CWbx3h03.css`、`chunk-OXJGGGUZ.js`。
- Electron 选择永久删除、回收恢复、入库闭环的开发/打包 6 项。首轮永久删除 2 项、回收恢复 2 项、开发入库 1 项通过；打包入库在收件箱空态断言后意外停在 queue，尚未归档或入库便超时。保留原 trace，无额外测试导航调用，不能断定导航来源。该唯一失败项未改代码、selector 或 timeout 原样重跑通过（11.6 秒），完成完整入库闭环；不是将首轮记录改成全绿。
- 永久删除两模式均首轮通过，确认预览、回执、重启后记录的 1440/390 截图可用；DOM 断言确认已删除记录没有恢复/删除按钮，文件槽与原路径均不存在，知识与附件原样保留。证据在 `.local/permanent-delete-evidence/`，包含首轮日志、单项重查日志、截图和原失败 trace。
- 测试根与测试进程已清理，更新后的真实 App 已打开，health/vault/index 均 ready。仅 GET 核验，升级前后回收记录、提炼记录、候选 version/state/decision 及已完成批次逐项相同。用户回收项 `81c4c735-2208-46f0-8f9b-c6badd79d437` 仍为 trashed/indexed，正文 SHA-256 保持 `b929fb8d44ea7a58c892735bc65d29f8bdf3f36fc68040dcea55d150306f6b23`；未替用户删除此文件。
- 本次真实窗口证据 `.local/permanent-delete-evidence/real-app.png`，本次服务地址 `127.0.0.1:50245`，端口并非固定。现有 worktree 和未提交变更均保留，`git diff --check` 通过；vault `99` 已核对保持“无进行中交接”。
