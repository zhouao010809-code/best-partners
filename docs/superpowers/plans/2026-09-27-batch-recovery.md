# 批量回收 Implementation Plan

**Goal:** 为已有项目创作与个人 Skill 分类提供可选择、可取消、可撤销、可批量恢复的整理流程。

**Architecture:** 复用单条回收和恢复接口，客户端维护当前列表选择、一次确认快照与逐项执行结果。失败项保留选择，成功项进入已有持久回收站。

**Tech Stack:** React、TypeScript、Vitest、Playwright Electron。

设计来源：[交互与边界](../specs/2026-09-27-batch-recovery-design.md)。用户已经明确要求多选，沿用本会话授权实施、发布和本机更新。

## 项目工作台

- [x] 为 `tests/component/creation-*.test.tsx` 增加当前视图选择、一次确认取消、部分失败、整批撤销、批量恢复和重复点击回归，先确认缺失功能导致失败。
- [x] 在 `src/client/components/projects/ProjectWorkbench.tsx` 及局部新组件实现选择与结果；在 `src/client/styles/project-workbench.css` 布置宽窄工具条和可滚动确认清单。
- [x] 运行新增组件测试及现有创作生命周期、编辑器、候选测试，核对不破坏原有单条路径。

## Skill 分类

- [x] 为 `tests/component/skills-*.test.tsx` 增加多选预览、取消、成功/失败、撤销、恢复、busy 保护回归，先确认失败。
- [x] 修改 `src/client/pages/SkillsPage.tsx`、`src/client/components/SkillFolderTrash.tsx` 及局部组件/CSS，复用原目录预览和恢复 API。
- [x] 修正 `src/server/services/skill-folder-trash.ts` 的预览容量：当前最多支持 1000 个分类，不得在全选时静默淘汰尚未确认的预览；增加对应服务回归。
- [x] 运行 Skill 组件、目录服务与 API 回归。

## 整体交付

- [x] 新增 `tests/electron/*bulk*.test.ts`，在隔离大脑中验证选两条留一条、取消、回收、撤销/重启恢复和内容保真；截图检查 1360 与 720 宽度。
- [x] 运行 `npm run verify:release`，包含完整门禁、fixture、当前包和 Electron 测试；若环境问题或已有失败，保留证据并明确区分。
- [x] 生成 0.1.8 手动安装 DMG，验证镜像、版本与 SHA-256；更新 README 和验收记录。
- [x] 提交并推送实现，核对远端 CI，上传并发布 GitHub Release；使用生产更新检查函数核验公开下载元数据。
- [x] 安装经过验收的本机包，只读核对新入口与原有数据，清理本次临时产物。
