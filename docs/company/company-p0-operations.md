# 公司工作区 P0 运行手册

这份手册用于两个人在同一个办公室的 Mac mini 上运行公司版工作区。P0 只覆盖：

- 共享项目工作区与项目文件夹导入；
- 项目档案、导入提案、确认和状态看板；
- 抖音、视频号、小红书官方导出文件的自动发现、校验、去重和指标看板；
- 公司 `skills/` 下的通用 / 行业 Skill 只读目录与正文浏览；
- 两个公司账号（operator、reviewer）；
- Codex / WorkBuddy 通过安全的公司项目工具读取、分析和提交提案；在显式绑定公司会话的 Agent 适配器中，也可以只读读取 Skill。

平台私有接口抓取、私信读取和账号密码托管不在 P0 范围内。第一版的平台数据采用“官方后台点击导出一次 + Mac mini 自动入库”，不是无人授权的实时 API 同步。看板没有真实数据时必须显示“尚未接入”“待导出”或“数据过期”，不能把未知显示为 0。

## 1. 目录边界

公司运行时使用两个彼此分离的绝对路径：

| 路径 | 内容 |
| --- | --- |
| `COMPANY_WORKSPACE_ROOT` | 文件真源：`incoming/`、`projects/`、`skills/`、`system/`、`platform-data/` |
| `COMPANY_DATA_DIR` | SQLite 投影、WAL、`backups/` 和 `recovery/` |

首次启动会创建四个基础工作区子目录；公司数据库初始化后还会创建独立的 `platform-data/` 与 `platform-data/raw/`，目录权限为仅当前用户可读写。工作区不能等于、也不能位于 `COMPANY_DATA_DIR` 内；生产环境也不要把它放进个人“我的大脑”目录。

推荐使用固定的绝对路径，例如：

```text
/Users/Shared/BestPartners/company-workspace
/Users/Shared/BestPartners/company-state
```

Mac mini 上的个人版仍使用自己的 Electron / personal vault；公司版不会加载个人 `VAULT_REAL_ROOT`、Local REST、个人账号或个人密钥。

## 2. 构建和启动

要求 macOS Apple Silicon、Node.js 22.12+。在项目 worktree 中执行：

```sh
npm ci
npm run build:company-server
```

推荐在 Mac mini 上只绑定回环地址，由第二台 Mac 通过 SSH 隧道访问。`COMPANY_HOST` 不能写 `0.0.0.0`、公网 IP 或任意公网域名；`COMPANY_PORT` 必须显式提供：

```sh
mkdir -p /Users/Shared/BestPartners
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > /Users/Shared/BestPartners/company-bootstrap-token
chmod 600 /Users/Shared/BestPartners/company-bootstrap-token

COMPANY_HOST=127.0.0.1 \
COMPANY_PORT=4399 \
COMPANY_BOOTSTRAP_TOKEN="$(tr -d '\n' < /Users/Shared/BestPartners/company-bootstrap-token)" \
COMPANY_WORKSPACE_ROOT="/Users/Shared/BestPartners/company-workspace" \
COMPANY_DATA_DIR="/Users/Shared/BestPartners/company-state" \
npm run company-server
```

启动命令会设置 `RUNTIME_MODE=company`，并在监听前完成工作区和公司数据库初始化。`COMPANY_BOOTSTRAP_TOKEN` 必须符合 43 字符 base64url 形状；部署命令应用 `randomBytes(32)` 生成 256-bit secret，缺失或格式错误时公司服务不会启动。密钥文件只让运行服务的 macOS 用户读取，不要放进 Git 或共享工作区。Mac mini 本机打开：

```text
http://127.0.0.1:4399/
```

第二台 Mac 开启一条 SSH 隧道（需要 Mac mini 已开启“远程登录”）：

```sh
ssh -N -L 4399:127.0.0.1:4399 <Mac-mini-用户>@mac-mini.local
```

隧道保持运行时，第二台 Mac 也打开 `http://127.0.0.1:4399/`。这样登录密码和 session cookie 不会以明文穿过办公室局域网。只有在已隔离且完全受信的内网中，才可改用 `192.168.x.x` / `10.x.x.x` / `.local` 直连；直连 HTTP 本身不提供传输加密。

`npm run build:company-server` 已包含完整的 `npm run build`、company MCP 和运维脚本构建；不要绕过它只运行 `npm run build:server`。按 `Ctrl-C` 停止服务，避免在服务运行时直接复制 SQLite 文件。

## 3. 首次建立两个账号

公司用户只允许初始化一次，固定建立一个 `operator` 和一个 `reviewer`。建议在 Mac mini 本机执行 bootstrap，使用 `umask 077` 的临时文件，并不把令牌和密码放进 curl 进程参数：

```sh
umask 077
bootstrap_file=$(mktemp /tmp/company-bootstrap.XXXXXX)
curl_config=$(mktemp /tmp/company-bootstrap-curl.XXXXXX)
trap 'rm -f "$bootstrap_file" "$curl_config"' EXIT

cat >"$bootstrap_file" <<'JSON'
{
  "operator": { "displayName": "运营", "password": "替换为强密码" },
  "reviewer": { "displayName": "老板", "password": "替换为另一组强密码" }
}
JSON

cat >"$curl_config" <<EOF
url = http://127.0.0.1:4399/api/company/v1/auth/bootstrap
request = POST
header = Content-Type: application/json
header = Origin: http://127.0.0.1:4399
header = X-Company-Bootstrap-Token: $(tr -d '\n' < /Users/Shared/BestPartners/company-bootstrap-token)
data-binary = @$bootstrap_file
EOF
curl --fail-with-body -sS --config "$curl_config"
```

没有正确启动密钥的局域网请求会在创建用户前返回 `COMPANY_BOOTSTRAP_FORBIDDEN`。初始化成功后不要再次调用 bootstrap；再次调用会返回 `COMPANY_ALREADY_BOOTSTRAPPED`。随后在网页中分别登录两个账号。`operator` 可以提交扫描、确认项目；`reviewer` 可以读取提案、项目和看板。P0 尚未提供独立的 reviewer 审批端点，因此不要把 reviewer 账号当作已经具备“确认项目”权限的账号。

## 4. 项目导入闭环

1. 把待导入的项目文件夹复制到公司工作区的 `incoming/` 下。复制过程结束后再开始扫描，不要把个人 vault 路径直接交给服务。
2. 在“项目档案库”提交 `incoming/<项目文件夹>`，或让 Agent 调用 `company.scan_project_folder`。
3. Agent 只生成结构化提案：文件清单、来源 hash、建议项目名、客户名、状态和证据置信度。`inferred` 与 `unknown` 字段必须在确认前复核。
4. 用 `company.get_project_proposal` 或页面打开提案；没有明确确认前，不会发布到正式项目目录。
5. 由有权限的用户明确确认；Agent 调用 `company.confirm_project` 时必须携带 `runId`、`sourceSha256`、名称、状态和 Skill ID。响应中的 `operationId` 和来源 hash 要写入操作记录。
6. 确认完成后，项目文件位于 `projects/<projectId>/`，包含 `项目配置.yaml`、`项目说明.md` 和原始文件副本；原始 `incoming/` 来源不会被静默改写。

### 平台导出自动入库

项目确认后，在平台官方后台导出数据文件，不要把账号密码、Cookie 或后台网页地址交给系统。日常可在项目详情页选择平台并点击“校验并导入”；页面上传与文件夹扫描共用同一套校验、去重、冲突和原始证据链。需要批量投递时，把文件完整复制到 Mac mini 的项目目录（复制完成后服务才会读取）：

```text
platform-data/douyin/<projectId>/导出.csv
platform-data/wechat-channels/<projectId>/导出.xlsx
platform-data/xiaohongshu/<projectId>/导出.xlsx
```

只允许 `.csv`、`.xlsx`、`.xls`。服务会按平台和 `projectId` 绑定归属，不根据标题猜项目；先等待文件大小和修改时间稳定，再解析首个可识别表头。每一行必须有稳定内容 ID、数据日期和至少一个已识别的累计指标。原始文件会按 SHA-256 复制到 `platform-data/raw/<平台>/<projectId>/`，入库记录保存来源相对路径、行号、表头行、工作表名和原始行 hash。

网页上传单文件上限为 20 MiB，只允许当前项目的三种平台和上述扩展名；服务端以内容哈希前缀写入项目 drop 目录并使用 0600 权限，再调用同一个 `importFile` 管线。上传成功后页面会重新读取项目指标；部分导入、重复、冲突和失败会保留在“最近导入”中，不会被界面伪装成成功。reviewer 账号只读，不能上传。

重复文件会显示“重复”而不新增快照；缺少内容 ID、未知列、负数或不支持的表头会显示“部分导入/失败”；同一项目、平台、内容和日期出现不同数值时标记“需处理”，绝不覆盖旧历史。看板累计指标按每个内容的最新快照汇总，粉丝数按账号最新值处理，不把所有历史快照直接相加。

服务启动后立即扫描，默认每 30 秒扫描一次；`COMPANY_METRICS_POLL_MS` 可设置 5000–86400000 的整数毫秒。网页的“刷新数据”会立即触发一次扫描；也可以让 Codex / WorkBuddy 调用显式导入工具。没有真实导出时显示状态，不显示 0。

公司 MCP 暴露以下十一个有界工具：

```text
company.scan_project_folder
company.get_project_proposal
company.confirm_project
company.list_projects
company.get_project
company.list_skills
company.get_skill
company.list_data_sources
company.get_project_metrics
company.get_sync_status
company.import_platform_export
```

它们返回结构化 JSON，不接受绝对路径、`..`、符号链接逃逸或模型生成的 shell/file-write 指令。`company.import_platform_export` 只接受 `platform-data/` 下的相对路径，并且与项目扫描一样需要显式打开 MCP 写入开关；个人版工具不会自动获得这些公司工具。

### Skill 目录

`skills/` 是公司工作区的文件真源。第一层可以按 `通用`、`教育`、`餐饮` 等分类，分类目录下每个 Skill 文件夹必须包含 `SKILL.md`；没有分类的 Skill 也可以直接放在 `skills/` 下。网页的“Skill 库”只读展示名称、描述、版本、正文和同目录 Markdown 参考文件，不提供网页执行、移动或编辑按钮。

Skill 正文中的命令只是不可信的参考内容，MCP 不执行它们；新增或修改 Skill 仍通过工作区文件和后续受控流程完成。网页上的“Agent 控制台”只是连接说明，不是内置聊天窗口。

### 连接 Codex / WorkBuddy

桥接使用公司账号登录 HTTP API，然后在本机通过 STDIO 向 Agent 提供工具。先验证协议和构建：

```sh
npm run test:company-mcp
npm run build:company-mcp
```

所需环境变量：

| 变量 | 用途 |
| --- | --- |
| `COMPANY_API_ORIGIN` | 公司服务完整 origin；HTTP 只允许回环，使用 `http://127.0.0.1:4399` |
| `COMPANY_DISPLAY_NAME` | 专用于 Agent 的现有公司用户显示名 |
| `COMPANY_PASSWORD` | 该用户密码；只保留在 Agent 所在的本机配置 |
| `COMPANY_MCP_WRITE_ENABLED` | 可选；只有精确为 `true` 时才放行项目扫描和官方导出入库 |
| `COMPANY_MCP_CONFIRM_ENABLED` | 可选；最终确认还要额外精确为 `true` |
| `COMPANY_MCP_CONFIRM_INTENT` | 确认时必填的精确 JSON 意图，与已核对提案一致 |

默认两个开关都不设。需要扫描项目时只开写入开关；需要确认时，在核对提案后再对当次 Agent 会话设置：

```sh
export COMPANY_MCP_WRITE_ENABLED=true
export COMPANY_MCP_CONFIRM_ENABLED=true
export COMPANY_MCP_CONFIRM_INTENT='{"runId":"run-1","sourceSha256":"<64位-hash>","name":"明德培训代运营","status":"active","selectedSkillIds":[]}'
```

桥接会逐字段比对工具输入和宿主意图，不匹配就拒绝；意图在发起 HTTP 确认前就会消耗，不能在同一进程中重复利用。确认完成或网络中断后，先读取同一 `runId` 判断结果，不自动重试。任务完成后关闭开关、删除意图并重启 Agent。Codex CLI 的注册示例见 README；WorkBuddy 生产注册使用构建后的 `node /absolute/path/dist/company-mcp-server/index.js`，开发调试才使用 `npx tsx company-mcp-server/index.ts`。

## 5. 中断和恢复

导入扫描或确认中断时，不要手动删除 `incoming/<runId>`，也不要直接改 SQLite。重新启动服务后：

1. 在项目档案库打开待处理提案，或调用 `company.get_project_proposal({"runId":"..."})`；
2. 核对来源 hash 和文件夹内容；
3. 内容未变化时再次明确确认；
4. 如果来源 hash 变化，放弃旧提案并重新扫描。

确认过程是幂等的：重复确认会返回已有项目和操作编号，不应再创建第二份项目。若工作区或数据库损坏，先停止服务并保留 `recovery/` 原样，进入人工恢复流程；不要用新建空数据库覆盖旧状态。

## 6. 冷备份与恢复演练

公司备份要同时保留文件真源和 SQLite 投影，因此只支持停服后冷备份。正常的 `SIGINT` / `SIGTERM` 会只关闭一次 Fastify 和 SQLite，并移除运行锁。停止公司服务后执行：

```sh
mkdir -p /Volumes/CompanyBackup/best-partners
npm run company:backup -- \
  --workspace /Users/Shared/BestPartners/company-workspace \
  --state /Users/Shared/BestPartners/company-state \
  --destination /Volumes/CompanyBackup/best-partners
```

命令每次创建一个不覆盖的 `company-backup-<时间>-<UUID>` 快照，逐项记录相对路径、大小和 SHA-256。遇到符号链接、特殊文件、备份目标位于源目录内、复制期间源文件变化，或检测到服务运行锁时都会拒绝。备份后立即做只读验证：

```sh
npm run company:restore-check -- \
  --snapshot /Volumes/CompanyBackup/best-partners/company-backup-<实际编号>
```

`verified: true` 只表示快照完整且 hash 匹配，不会改写当前工作区。实际恢复演练时，把快照的 `workspace/` 和 `state/` 复制到两个全新的绝对路径，对新路径再运行校验和公司服务；不要直接覆盖生产目录。

备份必须同时覆盖：

- `state.sqlite3` 及其 `-wal` / `-shm` 文件；
- `backups/`、`recovery/`；
- `incoming/`、`projects/`、`skills/`、`system/`、`platform-data/`（包括 `platform-data/raw/` 原始证据）。

不要只备份 SQLite，也不要把 `incoming` 或 `platform-data` 当作临时缓存清空。如果断电留下 `company-server.lock.json`，先确认对应 Node 进程和 4399 端口都已停止，再把该锁文件移入 `recovery/` 保留后重启；不要在进程存活时删锁。平台历史只来自已经导入的官方导出文件，备份不会替平台后台补抓新的数据。

### launchd 常驻

`scripts/company-launchd.plist.template` 是用户级 LaunchAgent 模板。复制到 `~/Library/LaunchAgents/com.bestpartners.company-console.plist` 后，替换所有 `__...__` 占位符，确保日志目录已存在，然后执行：

```sh
plutil -lint ~/Library/LaunchAgents/com.bestpartners.company-console.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bestpartners.company-console.plist
launchctl kickstart -k "gui/$(id -u)/com.bestpartners.company-console"
```

停服备份前执行 `launchctl bootout "gui/$(id -u)/com.bestpartners.company-console"`。模板从权限为 `0600` 的 token 文件读取初始化密钥，不把密钥本文写入 plist。

## 7. 双机验收清单

在同一办公室完成一次真实演练：

- 电脑 A 用 `operator` 登录，导入一个教育培训项目文件夹，检查提案中的来源 hash 和 unknown 字段，确认项目；
- 电脑 B 用 `reviewer` 登录，打开看板和项目详情，核对相同的 `projectId`、来源 hash、状态、更新时间和活动记录；
- 两台电脑都不能看到个人 vault 路径、个人账号、模型密钥或平台 cookie；
- 电脑 A 放入一份官方平台导出后，Mac mini 自动生成导入记录和 `platform-data/raw/` 证据副本，电脑 B 刷新后看到相同的指标与来源状态；
- 访问未知 Host、错误 Origin、公司工作区外路径时应被拒绝；
- 个人版仍只能访问个人 `/api/v1` 路由，公司 `/api/company/v1` 路由不应出现在个人运行时；
- 看板对于尚未导出、过期或失败的平台数据显示缺口状态，不显示伪造的 0。
