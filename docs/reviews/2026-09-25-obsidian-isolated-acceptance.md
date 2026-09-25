# Obsidian 独立测试库验收 · 2026-09-25

## 当前状态

独立测试库的真实接口探针与实际重启验收已完成。读取、条件替换/恢复、COPY 防覆盖创建、外部变化观测和重启持久化通过；PUT 防覆盖未通过，条件删除仍未证明，因此正式 REST 写入门保持阻断。

本轮仅验证保留的 Local REST 集成。当前个人桌面版入口 `src/electron/main.ts` 创建 `FileSystemVaultGateway` 并使用 `adapter: 'filesystem'`；归档、知识入库和回收由 `runtime/archive-composition.ts` 装配原生能力。REST 的 `formalWriteGate` 阻断不等于个人桌面版这些入口不可用，设置页也将其标为“旧版通用写入门”。

## 已准备及核对

- 本机验收目录：`~/Library/Application Support/xiaozhao-contract-20260925-q5Yzny/`。
- 测试库 `小兆隔离验收库/` 与 `app-data/` 为独立同级目录；与正式大脑、当前源码工作树经 realpath 核验互不包含。
- 从现有安装复制 Local REST API 5.1.0 的 `main.js`、`manifest.json`、`styles.css`，哈希一致；未复制正式库密钥。
- 独立随机密钥保存在测试库插件配置中；HTTPS 监听配置为 `127.0.0.1:27134`，HTTP 关闭。
- 已写入测试库哨兵及合法 ULID 下的中文/特殊字符/BOM/CRLF 精确字节 fixture；不包含正式资料。
- 本机 `run-contract.cjs` 显式传递隔离环境，使用插件的独立证书作为进程 CA，不关闭 TLS 校验。项目现有 `.env` 未改动。
- 已验证运行器 JavaScript 语法；磁盘根目录隔离、插件文件哈希、独立密钥和哨兵检查通过。HTTPS 证书验证、REST 哨兵和 fixture 索引预检均通过。

## 真实执行结果

执行时间为 2026-09-25，使用 Local REST API 5.1.0、Obsidian 1.13.7。在本机验收目录实际依次执行：

```sh
node run-contract.cjs preflight
node run-contract.cjs read
node run-contract.cjs write
node run-contract.cjs prepare
# 已确认 Obsidian 主进程退出后重新启动，并打开同一隔离库。
node run-contract.cjs verify
node run-contract.cjs gate
```

preflight 通过；read、write、prepare、verify 四个探针各 1 项通过，均退出 0。最终 gate 退出 1，输出 `BLOCKED safeDelete formalWriteGate`。测试退出 0 只代表探针及证据持久化成功，不代表所有被测能力通过。

| 能力 | 结果 | 本次证据 |
| --- | --- | --- |
| 精确读取 | 通过 | 中文及 `#%` 文件名、BOM/CRLF 原始字节和版本均匹配。 |
| 条件替换 | 通过 | 过期版本返回 412；同版本并发请求返回 200/412；回读符合唯一胜出写入。 |
| 条件恢复 | 通过 | 恢复返回 200，回读精确匹配原始字节。 |
| COPY 防覆盖创建 | 通过 | 首次 204，重名碰撞 409，目标内容保持不变。 |
| PUT 防覆盖创建 | 未通过 | 带 `Reject-If-Content-Preexists` 的两次请求均返回 204；记录 `PUT_SAFE_CREATE_UNPROVEN`。整体 safeCreate 通过仅来自 COPY。 |
| 修改后回读 | 通过 | 每次成功修改都有原始字节/哈希回读。 |
| 外部变化观测 | 通过 | 同一隔离沙箱中的创建、修改、重命名、删除均被目录与版本观测识别。 |
| 重启持久化 | 通过 | Obsidian PID 883 完整退出后以 PID 86415 启动；测试文件哈希及版本保留。 |
| 条件删除 | 未证明 | 当前探针记录 `SAFE_DELETE_CAS_UNPROVEN`，没有发出 DELETE；不能描述为“实测 DELETE 失败”。 |
| 自动清理 | 未验证 | 安全删除尚未证明，测试沙箱和重启定位记录保留作复核。 |
| 正式 REST 写入门 | 阻断 | 门禁按现有规则拒绝开放，未改断言或绕过检查。 |

本机证据保存在上述验收目录的 `logs/`、`restart-process-evidence.json` 和 `app-data/contract-profiles/`。最终 profile key 为 `25f91c858f1cf7fead011d48e557794d136e0241c7c5a2885710761d1d35d881`，revision 为 `be5c4c437b878e324535f36557030eb1c30c564c42b6e493b5f8b41bad2c8ced`。OpenAPI SHA-256 为 `73e3f12252068c493a1748b3bd25abf5c07079d8b7c5c03cf7a1998c5d7e1664`。

read/write 会将重启状态重置为未验证，故复核现有结果应直接读取最终报告，不要在重启验证后再次运行 probe 覆盖证据。测试数据为保留的复现材料，不是正式资料；自动清理未通过，不手工修改证据为成功。

这些结果无需通过修改当前桌面版来“变绿”。未来若要开放旧 REST 通用写入口，需要选用已验证的创建原语，并独立证明非永久条件删除。当前个人桌面版仍按自己的原生能力与恢复门禁运行。

## 最新安装包的本地操作验收

已逐字节比对安装包内与当前 dist 的 client/server/Electron 文件，共 72 个文件一致。本轮未改产品代码；仅给 `tests/electron/ingestion-flow.test.ts` 增加正式入库后的最终进程重启验证，无需重建安装包。

实际执行：

```sh
npx playwright test --config playwright.electron.config.ts \
  tests/electron/ingestion-flow.test.ts tests/electron/intake-trash-flow.test.ts \
  --grep 'packaged:' --workers=1 \
  --output='/Users/ao/Library/Application Support/xiaozhao-contract-20260925-q5Yzny/desktop-test-results'
```

结果：2 项通过，23.2 秒，退出 0。

- 收件至知识：安装包发现新增资料包、预览并确认归档、审阅并编辑候选、重启恢复草稿、确认知识入库、重复提交不产生重复写入、搜索和回看来源。
- 最终入库后的重启：新进程能搜索和打开知识，两个确认批次与重启前完全一致，知识/最终来源/附件字节保持一致，仅一份知识，零模型调用、零页面错误。
- 收件回收与恢复：整包回收、重启、按原字节与 inode 恢复，再次回收恢复、正常归档和再次重启后的历史记录通过。

以上使用真实安装包、SQLite、原生读写模块与本地隔离文件；每项结束后清理其临时库和用户目录。收件包由脚本模拟插件落盘，提炼使用模型响应替身并禁止其他网络，故不代表真实网站剪藏、真实模型质量或付费调用通过。此处为自动化操作验收，不是首次使用的真人理解度测试。截图与运行结果保存在本机验收目录的 `desktop-test-results/`。

本目录中的配置、证书和运行日志均为本机验收材料，不提交密钥。正式模型调用、真实账号授权、真人体验及签名分发不属于本次接口探针的通过范围。
