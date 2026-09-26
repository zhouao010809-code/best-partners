# 个人项目界面易读化实施计划

**Goal:** 让用户直接找到项目资料、项目问问和已保存结果。
**Architecture:** 保留个人项目 API、相对路径与确认写入契约，只调整客户端呈现；文件工作面拆出自身样式。完整暂存树构建，安装包验收后发布补丁版本。
**Tech Stack:** React、TypeScript、CSS、Vitest、Playwright Electron。

- [x] 壳层与工作区：AppShell 在个人项目路由不渲染重复标题；ProjectsPage/ProjectWorkspacePage 提供 h1；ProjectStatusCard 正常态改紧凑状态，异常仍能重连；清理重复上下文卡与英语标签。
- [x] 文件工作面：ProjectFilesPanel 与 project-files.css 实现目录展开、隐藏文件开关、搜索/截断提示、source/output独立错误和迟到正文取消；新增专用组件测试。
- [x] 项目问问：AssistantPanel 仅改项目分支标题/范围/建议/输入提示，增加建议不自动发送的回归；普通模式保持不变。
- [x] 校验：运行项目、问问、壳层组件，架构与全部类型检查；更新 personal-project-workspace 桌面验收及截图，运行首次使用与问问恢复。
- [x] 交付准备：0.1.3 完整暂存树构建、验包，核对产物与源码；安装后可见页面复查。
- 发布步骤：提交完整改动并发布 GitHub DMG，核对远端摘要和旧版更新发现结果；发布证据保留在 `.local/project-clarity-evidence/`。
