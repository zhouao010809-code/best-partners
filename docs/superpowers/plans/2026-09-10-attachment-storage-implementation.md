# 附件存储实施计划

> 按已批准的 assistant-product-readiness-design 执行；本子任务不修改问问/前端。使用 test-driven-development 与 verification-before-completion，不创建 Git 提交。

**Goal:** 本地文件接收、文本 PDF/MD/TXT 解析、按页读取、原件回读、幂等归档与重启恢复。

**Architecture:** 附件账本与不可变原件位于当前 Vault 对应 appData。独立 PDF worker 解析，不执行文件指令。受限 native publisher 只发布固定格式 clipper 包，正式归档复用 IntakeService。

**Tech Stack:** TypeScript、Zod、Node worker_threads、pdfjs-dist 5.4.624（支持项目 Node 22.12 下限）、现有 macOS N-API。

- [x] 添加 shared attachments schema、隔离服务/原生发布回归，先确认失败。
- [x] 实现私有原件/账本、幂等上传、批次限制、解析作业、页读取与取消。
- [x] 实现受限资料包 publisher、归档工作流 ID 与恢复。
- [x] 实现独立 octet-stream 路由，并交付 root 工厂/生命周期/打包接线。
- [x] 执行 PDF/扫描/加密/损坏/重启/幂等/哈希/路由安全测试与相关类型检查。

## 实现与验证记录

- `src/shared/api/attachments.ts`：共享状态与上传、列表、页读取、归档结果协议。附件 ID 等于稳定 uploadId；上传响应不明时可用相同 ID 重试核验。
- `src/server/attachments/`：不可变原件、原子账本、串行解析作业与恢复。PDF 在独立 worker 解析；使用本地 `pdfjs-dist` 的 CMap 与标准字体资源，中文 Type0 文本层亦有真实夹具验证。
- `src/server/api/routes/attachments.ts`：独立 octet-stream parser 与 10 MiB 流限额，既有 JSON 限额、Origin、session/CSRF 继续生效。GET 列表返回全部元数据，不含文本；下载强制附件与 nosniff。
- `native/macos/sandbox-archive.c`：受限 `publishAttachmentPackage`。仅允许一个派生 Markdown 与固定路径原件，验证整个持有目录树、原件字节、父目录身份；同卷、无符号链接、无覆盖地发布到 clipper，再由 IntakeService 执行正式归档。
- 归档前持久保存确定计划；提交响应丢失时按 UUID 暂存包与目标匹配已有 intake intent 并恢复同一操作。重复归档须验证已归档原件哈希；同名不同内容采用可区分版本标题。用户明确标题冲突时不发布资料包，提示改名。
- 主 Markdown 每页包含 `<!-- xiaozhao-page:<sha256>:<page> -->`；Markdown/TXT 也有单页标记。原始 Markdown/YAML 与 BOM/CRLF 在 `附件/原件.md` 保持精确字节；派生主文档保留原作者、来源与日期。

验证命令与结果：

```text
npm run build:personal-archive
npx vitest run --config vitest.integration.config.ts tests/integration/attachment-service.test.ts tests/integration/attachment-routes.test.ts
  16/16 通过；/tmp/attachment-final-integration.log
npx vitest run --config vitest.native.config.ts tests/native/attachment-publisher.contract.test.ts tests/native/personal-archive.contract.test.ts tests/native/personal-ingestion.contract.test.ts tests/native/personal-trash.contract.test.ts
  88/88 通过；/tmp/attachment-final-native.log
npx vitest run --config vitest.archive.config.ts tests/archive/intake-service.test.ts tests/archive/intake-archive.test.ts tests/archive/intake-crash.test.ts
  46/46 通过；/tmp/attachment-final-intake.log
npx tsc -p tsconfig.server.json
  退出 0；/tmp/attachment-final-tsc.log
```

回归包含实际英文两页 PDF、中文 CMap PDF、加密 PDF、无文本 PDF、损坏 PDF、Markdown 元数据与字节、取消与重启恢复、流式超限、认证、同内容复用、同名新版本、显式标题冲突、归档回执丢失及停止发生在异步规则校验期间。PDF 由 `tests/helpers/pdf-fixture.ts` 本地生成，不含实际资料；临时库均由测试清理。

本阶段边界：单文件 10 MiB、批次 16 MiB；解析文本最多 2 MiB/PDF 最多 2000 页，worker 60 秒与堆内存限额。页读取单次最多 50 页/120000 字符并显式返回 truncated。扫描件不执行 OCR，加密件不接收密码，原件仍可保留和由明确操作归档。暂存原件当前不自动清理；仅引用移除不删除文件。原生正式归档仍要求暂存与资料库同卷。独立 `.app` 的最终构建、依赖复制及端到端验收由 root 汇总执行，本子任务未宣称实际打包验收完成。
