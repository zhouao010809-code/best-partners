# 设置页：单栏偏好设置

状态：设置页已实施、验证，并同步到当前桌面 App。

## 视觉依据

- Linear 的 [Account preferences](https://linear.app/docs/account-preferences)：实际查看官方设置截图，采用清晰的分组、克制的色彩、细分隔线和稳定对齐。
- Raycast 的 [Settings](https://manual.raycast.com/settings)：实际查看官方设置截图，参考桌面表单的控件密度与文字层级。
- 页面内容最大宽度 828px，居中单栏排列；每组采用左侧标题、右侧控件。使用中性深灰背景、16px 分组标题、13px 控件文字和少量真实状态色，保留清晰对齐与分隔线。
- 运行状态置于常用设置下方；待确认资料和高级诊断默认折叠。外壳调整限定在设置路由，其他页面不受影响。

## 页面与交互

- 从上到下为大脑文件夹、AI 模型、运行状态、资料检查、高级诊断与 App 版本。移除不可调整的收件归档分组，归档规则继续在收件流程中呈现。保存按钮位于移除按钮右侧，视觉和键盘顺序一致。
- 文件夹展示真实显示名、当前绝对路径和连接状态；支持 Finder 打开。缺少桌面 bridge 时说明能力范围，位置读取失败可重试。
- 选择无效目录后可真正重新选择；选中当前目录不重启。有效新目录在一次原生确认后才保存并重启，说明提炼中断及资料仍保留原位置；取消保留原设置。
- DeepSeek 状态区分未配置、读取异常、待验证、验证中、成功和失败。密钥存储损坏原因从存储层传至 UI，不误标为从未配置。失败后保留本次输入并隐藏，成功后才清空；移除需明确确认。
- 验证只由用户点击触发，使用已保存的密钥发送固定短消息，不读取用户资料、不生成提炼记录。编辑了未保存密钥时禁止误测旧配置；保存/移除/验证互斥。
- 后端验证限 20 秒、16 KB 响应、16 tokens 输出且禁止重定向。认证失败、余额不足、限流、网络和超时分别提供中文反馈。参数依据 [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [官方错误码](https://api-docs.deepseek.com/quick_start/error_codes/)。
- 最近结果仅在服务生命周期内保存，绑定密钥版本；改/清密钥及关闭会取消验证，迟到结果不得覆盖当前状态。重新验证开始即清除旧绿色结果，前端与后端 GET 一致。
- 待确认资料默认折叠，首次展开后才读取列表；原文仍以纯文本呈现。高级诊断收起旧通用写入门等技术信息，不影响个人 App 的归档/入库入口。
- 每条资料提供针对属性区块、类型或字段的核对指引，以及 Finder 定位。主进程按当前大脑和原生目录边界验证 Markdown 文件，拒绝越界、符号链接、缺失文件与被替换的根目录。页面说明保存后需等待扫描再刷新列表，不伪装成立即重建索引。
- 索引时间使用本地月日与时分；刷新/连接失败保留旧快照并说明状态。结构检查不可用时不显示假零。
- 1120px 以下缩小标题列并调整文件夹操作，780px 以下标题与内容堆叠，540px 以下模型字段和状态详情改为单列。长文件名和路径换行，按钮和链接有明确的键盘焦点轮廓。

## 验证

- `npm run build && npm run build:electron` 通过，包含 client/server/electron 类型检查及构建；仍有现存单包体积提示。
- 最终相关测试合计 253 项通过：6 个组件测试文件 104 项、7 个单元测试文件 92 项、3 个集成测试文件 55 项、1 个原生边界测试文件 2 项。新增行为均先复现失败再实现。
- 组件范围：read-pages、personal-extraction、deepseek-settings、settings-location、document-issues-guidance、extraction-api-client。单元范围：deepseek-connection、deepseek-provider、extraction-contract、model-key-store、desktop-vault-selection、desktop-vault-navigation、electron-settings-store。集成范围：deepseek-settings-service、personal-extraction-api、personal-extraction-service。原生范围：desktop-vault-navigation.contract。
- 前轮额外运行 `app-shell.test.tsx`：56 个通过，2 个操作页既有恢复用例失败，见下文。该轮整体为 142 通过、2 失败，不能声称全部回归通过。本轮重做未修改这些恢复逻辑。
- CUA 检查 1440、1024、390px 宽度，确认表单、长路径、展开资料列表无横向溢出；真实 Tab 操作验证焦点轮廓。隔离 fixture 验证成功/失败、损坏密钥提示、保存失败后重试、位置读取失败后重试、Finder 失败后重试与资料定位反馈。
- 桌面 App 已重启、加载最终构建并打开真实 `/settings`；确认真实路径、待验证状态、验证入口与版本；实际打开 Finder 的“我的大脑”，并检查原生文件夹选择取消后仍保留原大脑。未修改真实密钥或资料、未发起真实模型请求。
- 浏览器/桌面旧验收脚本补上了新折叠入口，但未运行完整 E2E。旧 `read-only-console.spec.ts` 中“DeepSeek 设置将在后续阶段启用”断言本就已过时，此次未将它作为验收依据。

## 运行包

更新当前运行包的 `Contents/Resources/app/dist/client`、`server`、`electron`，包括新增 IPC preload；native 与依赖保持。运行包位置：`dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app`。

本轮更新前完整运行目录备份：`~/.Trash/settings-complete-runtime-backup-4flxvq37`（client/server/electron）。更早前端备份仍保留。部署后源构建与运行包逐文件比较一致。当前应用已打开设置页，启动端口按实例分配，不作为稳定契约。

## 独立发现：操作页首次断线/构建后的自动恢复

该问题未在本次设置页工作中修改。两个 `app-shell.test.tsx` 用例单独运行仍失败；本次 `AppShell.tsx` 相对修改前仅改设置页的 eyebrow 与 description。

`OperationsPage.tsx` 的读取 effect 依赖 `api/dataRevision/revision/view`，不依赖 health。首次断线或索引构建中读取失败后，health 变为 ready 时可能没有 dataRevision 变化，列表不会自动重试。旧测试同时仍使用已废弃的错误与空态文案。后续应修复该恢复触发条件，更新真实文案，再保留并跑通“恢复后重新读取”的行为断言；不要仅改字符串或删掉断言来掩盖缺口。
