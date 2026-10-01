# 个人备份与健康检查

本工具管理个人 App 的本地持久数据。规则和原文不自动修改，快照不轮转删除。当前提供冷备份、完整快照核对和离线 SQLite 校验；迁移到新 vault 身份后的应用恢复仍需通过[迁移合同](personal-restore-contract.md)中的验收。

## 健康检查

在应用项目根目录使用锁定的依赖运行：

```sh
npm run brain:doctor -- --vault /absolute/path/to/vault
npm run brain:doctor -- --vault /absolute/path/to/vault --user-data /absolute/path/to/user-data
```

默认只输出 JSON，不写报告。要保存结果，显式指定一个不存在的文件：

```sh
npm run brain:doctor -- --vault /absolute/path/to/vault --output /absolute/path/to/new-report.json
```

检查项包括核心目录、规则散列、Node/应用版本、严格或历史兼容的元数据、来源双链、门禁发现目录、当前构建清单及可选的状态存储对应关系。`SOURCE_LINK_MISSING` 为缺失，`SOURCE_LINK_AMBIGUOUS` 为同名歧义，`SOURCE_LINK_NOT_LIBRARY` 为链接确实存在但未指向原始图书馆资料。完整路径优先精确匹配，否则采用唯一后缀；不按同名文件猜测。

旧格式和无类型原始 Markdown 保留为警告。目录缺失、规则缺失和不可解析的已类型笔记是硬错误；硬错误或调用失败退出 `2`，只有警告退出 `0`。本工具不会调用模型、打开 Keychain、安装插件或更新知识库。来源链治理需要依据具体文件清单处理，不因为健康检查告警自动移动或重写资料。

## 项目确认写入恢复

项目输出的确认意图与 `running` 状态在同一 SQLite 事务保存。正常文件系统模式启动时，只有健康检查就绪、完整规则可读后，才核验已确认的 `running`；不自动执行 `pending`、`failed` 或已取消计划。旧计划缺少确认身份或生产规则指纹时停止，不能推断旧授权。

恢复只接受原确认编号。目标字节与确认内容一致时补齐原操作回执及索引，不重写文件、不重复产出；目标尚未发布且根身份、项目版本、读集和规则均符合原确认时，才能继续该次写入。已持久化 `publication: linked` 的目标如果消失，转为过期并保留证据，禁止重新生成。规则或健康暂时不可读时保留 `running` 等待核验；确定的规则、根身份、版本、内容冲突或不安全路径使计划过期，不覆盖其他文件。

发布后发生 I/O 故障时保留待核验意图，不给成功回执。发布前后都复查父路径、文件身份与内容，但 Node 路径式 `link`/读取没有原子的 descriptor-relative 目录身份合同。同用户在系统调用内部恶意替换父目录，仍可能在项目根外留下本轮输出；该结果不会被标为完成或索引，后续原确认核验遇不安全路径会停止。这里证明的是恢复状态与不重复写入边界，不能宣称消除了同用户恶意目录竞争。

## 冷备份

先正常退出最佳拍档，并停止会修改这些目录的其他程序。工具要求明确确认冷备份，不会代替用户关闭应用。`userData` 需选当前 App 的实际数据目录；不能用项目源码或只有 SQLite 的子目录替代。

三个路径必须是现存的绝对目录，无符号链接，互不重叠。目标可以是独立备份盘上的目录。

```sh
npm run personal:backup -- \
  --vault /absolute/path/to/vault \
  --user-data /absolute/path/to/user-data \
  --destination /absolute/path/to/backups \
  --cold
```

成功输出独立的 `personal-backup-<time>-<uuid>/snapshot` 路径，包含 `manifest.json`、`vault/` 和 `user-data/`。不覆盖已存在快照。复制前后检查源文件内容及身份，逐项记录相对路径、字节数和 SHA-256；完整快照发布前核对整个树。识别到运行锁、源变化、目录替换、不安全对象或重叠即失败。清理只处理本轮仍持有身份的临时对象；未知或被替换的对象保留，避免删除其他资料。

范围：

| 保存内容 | 位置 |
| --- | --- |
| 原文、附件、知识、输出、规则、脚本与锁文件 | 完整 vault |
| 每个 vault 的 SQLite、备份和恢复对象 | `userData/vaults/` |
| 上传原件、解析文本、附件回执、归档、入库和回收记录 | 各 vault 私有状态目录 |
| 对话、草稿、候选、项目历史和 Local Storage | SQLite 与 `userData` 持久树 |
| App 配置、现有加密密钥字节、桥接配置 | `userData` 相应目录 |

排除表固定且写入清单：`node_modules` 和 userData 根的 `Cache`、`Code Cache`、`GPUCache`、`DawnGraphiteCache`、`DawnWebGPUCache`、`ShaderCache`、`GrShaderCache`。Session Storage、Local Storage、更新文件和故障记录保留。密钥只复制已有字节，不解密、不打印。

未覆盖：外置项目原件、浏览器扩展尚未发送的队列、系统 Keychain。跨机器恢复加密字节后，是否能解密仍依赖当前系统。快照可保存外置项目引用和历史，不能替代项目目录自身的备份。

工具不会验证应用完全停机，只能结合用户的冷备份确认、已知运行锁和前后变化检测。Node 文件接口不提供本工具所需的整树原子 `openat` 合同；不承诺抵御同用户恶意持续替换目录。快照可通过散列检测修改，未包含独立签名，不能证明来源真实性。

## 离线恢复检查

```sh
npm run personal:restore-check -- --snapshot /absolute/path/to/snapshot
npm run brain:doctor -- --vault /absolute/path/to/vault --snapshot /absolute/path/to/snapshot
```

核对严格的版本化清单、必需对象、全部文件和空目录、额外成员、来源配置及旧 cacheKey。然后在自身临时目录复制完整树，仅打开副本中的 SQLite，执行 `integrity_check` 与 `foreign_key_check`，结束清理自己的对象。原快照和真实 vault/userData 不修改。

| 输出 | 当前成功含义 |
| --- | --- |
| `snapshotIntegrity: passed` | 文件清单、字节、目录和配置对应关系正确 |
| `sqliteIntegrity: passed` | 副本中的 SQLite 结构及外键检查通过 |
| `applicationRestore: unverified` | 尚未证明新目录中的 App 状态和操作恢复 |
| `requiresIdentityRebind: true` | 新路径/设备/inode 会改变 cacheKey，旧恢复日志仍绑定原身份 |

Doctor 在失败时也区分层次：完整文件树已核验而 SQLite 结构失败，分别输出 `snapshotIntegrity: passed` 与 `sqliteIntegrity: failed`；快照结构或字节失败时，SQLite 保持 `unverified`，不会冒称已检查。`applicationRestore` 均为 `unverified`。

不能直接把快照目录选为 App 大脑后用“窗口能打开”证明恢复；新 key 可能创建一个空数据库。工具暂未提供覆盖恢复命令。已确认但未完成的归档、入库、回收及项目输出必须按迁移合同重新核验，不能用文本替换日志身份绕过守卫。

两个备份 CLI 的参数错误退出 `2`，执行或完整性失败退出 `1`，成功退出 `0`。输出安全错误码和计数；详细文件证据在私有 manifest 中。合成夹具是默认验收，不会因运行测试建立真实用户备份。

## 构建与发布追溯

`build` 在重新生成客户端和服务端前记录源码会话；桌面构建完成后生成 `dist/build-manifest.json`。清单记录应用版本、Git commit/dirty、Node/Electron、源码散列和发布资源散列。打包前核验原清单，扩展 ZIP 只更新其独立产物记录，不为旧 dist 重盖当前源码身份。

```sh
npm run verify:full
npm run package:mac:built
./node_modules/.bin/tsx scripts/build-provenance.ts --verify
```

App 内嵌同一清单，并核对当前运行时和模板、扩展、原生 helper 资源。源码或产物变化后先重新构建。该证据用于判断本次源码与产物对应关系；Electron 框架、原生依赖 ABI 和签名/公证仍按现有单独构建与验收合同处理，不能将资源清单当作整个 `.app` 的签名。
