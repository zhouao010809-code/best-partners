# 公司工作区 P0 运行手册

这份手册用于两个人在同一个办公室的 Mac mini 上运行公司版工作区。P0 只覆盖：

- 共享项目工作区与项目文件夹导入；
- 项目档案、导入提案、确认和状态看板；
- 两个公司账号（operator、reviewer）；
- Codex / WorkBuddy 通过安全的公司项目工具读取、分析和提交提案。

平台后台抓取、视频号/抖音/小红书的实时指标、私信读取和账号密码托管不在 P0 范围内。看板没有真实数据时必须显示“尚未接入”或“待建立基线”，不能把未知显示为 0。

## 1. 目录边界

公司运行时使用两个彼此分离的绝对路径：

| 路径 | 内容 |
| --- | --- |
| `COMPANY_WORKSPACE_ROOT` | 文件真源：`incoming/`、`projects/`、`skills/`、`system/` |
| `COMPANY_DATA_DIR` | SQLite 投影、WAL、`backups/` 和 `recovery/` |

首次启动会创建四个工作区子目录，目录权限为仅当前用户可读写。工作区不能等于、也不能位于 `COMPANY_DATA_DIR` 内；生产环境也不要把它放进个人“我的大脑”目录。

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
npm run build
```

在 Mac mini 上用固定的局域网地址启动。`COMPANY_HOST` 必须是明确的非 wildcard 地址，不能写 `0.0.0.0`；`COMPANY_PORT` 必须显式提供：

```sh
COMPANY_HOST=192.168.1.20 \
COMPANY_PORT=4399 \
COMPANY_WORKSPACE_ROOT="/Users/Shared/BestPartners/company-workspace" \
COMPANY_DATA_DIR="/Users/Shared/BestPartners/company-state" \
npm run company-server
```

启动命令会设置 `RUNTIME_MODE=company`，并在监听前完成工作区和公司数据库初始化。两台电脑用浏览器打开：

```text
http://192.168.1.20:4399/
```

如果只运行了 `npm run build:company-server` 而没有 `npm run build`，公司前端静态文件可能不存在；发布前应始终执行完整的 `npm run build`。按 `Ctrl-C` 停止服务，避免在服务运行时直接复制 SQLite 文件。

## 3. 首次建立两个账号

公司用户只允许初始化一次，固定建立一个 `operator` 和一个 `reviewer`。建议在 Mac mini 本机执行 bootstrap，并为请求体使用临时文件，避免密码出现在 shell 历史中：

```sh
cat > /tmp/company-bootstrap.json <<'JSON'
{
  "operator": { "displayName": "运营", "password": "替换为强密码" },
  "reviewer": { "displayName": "老板", "password": "替换为另一组强密码" }
}
JSON

curl --fail-with-body -sS \
  -X POST "http://192.168.1.20:4399/api/company/v1/auth/bootstrap" \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://192.168.1.20:4399' \
  --data-binary @/tmp/company-bootstrap.json

rm /tmp/company-bootstrap.json
```

初始化成功后不要再次调用 bootstrap；再次调用会返回 `COMPANY_ALREADY_BOOTSTRAPPED`。随后在网页中分别登录两个账号。`operator` 可以提交扫描、确认项目；`reviewer` 可以读取提案、项目和看板。P0 尚未提供独立的 reviewer 审批端点，因此不要把 reviewer 账号当作已经具备“确认项目”权限的账号。

## 4. 项目导入闭环

1. 把待导入的项目文件夹复制到公司工作区的 `incoming/` 下。复制过程结束后再开始扫描，不要把个人 vault 路径直接交给服务。
2. 在“项目档案库”提交 `incoming/<项目文件夹>`，或让 Agent 调用 `company.scan_project_folder`。
3. Agent 只生成结构化提案：文件清单、来源 hash、建议项目名、客户名、状态和证据置信度。`inferred` 与 `unknown` 字段必须在确认前复核。
4. 用 `company.get_project_proposal` 或页面打开提案；没有明确确认前，不会发布到正式项目目录。
5. 由有权限的用户明确确认；Agent 调用 `company.confirm_project` 时必须携带 `runId`、`sourceSha256`、名称、状态和 Skill ID。响应中的 `operationId` 和来源 hash 要写入操作记录。
6. 确认完成后，项目文件位于 `projects/<projectId>/`，包含 `项目配置.yaml`、`项目说明.md` 和原始文件副本；原始 `incoming/` 来源不会被静默改写。

公司 Agent 工具只有以下五个：

```text
company.scan_project_folder
company.get_project_proposal
company.confirm_project
company.list_projects
company.get_project
```

它们返回结构化 JSON，不接受绝对路径、`..`、符号链接逃逸或模型生成的 shell/file-write 指令。个人版工具不会自动获得这五个公司工具。

## 5. 中断和恢复

导入扫描或确认中断时，不要手动删除 `incoming/<runId>`，也不要直接改 SQLite。重新启动服务后：

1. 在项目档案库打开待处理提案，或调用 `company.get_project_proposal({"runId":"..."})`；
2. 核对来源 hash 和文件夹内容；
3. 内容未变化时再次明确确认；
4. 如果来源 hash 变化，放弃旧提案并重新扫描。

确认过程是幂等的：重复确认会返回已有项目和操作编号，不应再创建第二份项目。若工作区或数据库损坏，先停止服务并保留 `recovery/` 原样，进入人工恢复流程；不要用新建空数据库覆盖旧状态。

## 6. 备份边界

当前版本有 `backups/` 和数据库恢复目录，但还没有对外的一键备份命令或自动备份调度。正式投入使用前，先制定人工备份制度：停止服务后，将完整的 `COMPANY_DATA_DIR` 和 `COMPANY_WORKSPACE_ROOT` 复制到独立磁盘或受控备份位置，再启动服务验证项目列表和 hash。

备份必须同时覆盖：

- `state.sqlite3` 及其 `-wal` / `-shm` 文件；
- `backups/`、`recovery/`；
- `incoming/`、`projects/`、`skills/`、`system/`。

不要只备份 SQLite，也不要把 `incoming` 当作临时缓存清空。P0 不提供自动平台数据同步，因此备份不会产生视频号、抖音或小红书的后台历史数据。

## 7. 双机验收清单

在同一办公室完成一次真实演练：

- 电脑 A 用 `operator` 登录，导入一个教育培训项目文件夹，检查提案中的来源 hash 和 unknown 字段，确认项目；
- 电脑 B 用 `reviewer` 登录，打开看板和项目详情，核对相同的 `projectId`、来源 hash、状态、更新时间和活动记录；
- 两台电脑都不能看到个人 vault 路径、个人账号、模型密钥或平台 cookie；
- 访问未知 Host、错误 Origin、公司工作区外路径时应被拒绝；
- 个人版仍只能访问个人 `/api/v1` 路由，公司 `/api/company/v1` 路由不应出现在个人运行时；
- 看板对于尚未接入的平台数据显示缺口状态，不显示伪造的 0。

