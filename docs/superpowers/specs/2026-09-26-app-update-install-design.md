# 应用内补丁更新

用户于 2026-09-26 确认升级现有“应用更新”。随后确认没有 Apple Developer 账号；本机 `security find-identity -v -p codesigning` 返回 0 个有效身份。

## 用户流程

检查更新只读取固定 GitHub Releases。发现更新后显示说明与下载动作，点击才下载。当前未签名预览版在应用内下载 DMG、核对 GitHub 提供的 SHA-256 和大小，完成后由用户点击“打开安装包”，在系统安装窗口确认替换。不会把这一步描述为已自动安装。

具备 Developer ID 签名的正式包，且 Release 同时含有 ZIP 和 RELEASES.json 时，使用 Electron 原生 autoUpdater 下载和验证签名，下载后显示“重启完成更新”。通过正常退出流程保存草稿、关闭服务，再交给 Squirrel 安装。当前没有证书，因此真实签名升级必须保持未验证。

两种方式均允许离开设置页再回来查看进度；安装器下载可取消、失败可重试。旧 Release 没有文件摘要时保留浏览器下载入口。不开机静默下载、不从 main 拉取源码、不改动资料、数据库或密钥目录。下载仅写入 userData/updates 下本次创建的临时目录；取消和失败清理临时文件。

## 边界

- 渲染进程不能指定下载地址、磁盘路径或执行命令。主进程保存通过检查的版本，所有 IPC 校验主窗口 sender。
- 初始地址只允许固定仓库 Release；重定向只允许 GitHub 与 release-assets.githubusercontent.com 的 HTTPS，不携带用户令牌；流式下载限时、限大小、核验长度和摘要后才标记可安装。
- 应用版本、标签和包版本一致；每个补丁递增版本号。DMG 与校验文件可供当前预览版发布；只有签名、公证校验通过才生成自动更新 feed。
- 正式自动更新以 Electron / Squirrel 签名校验为信任基础，不实现绕过 macOS 校验的自制替换器。

## 验证

单元测试覆盖下载重定向、取消、失败、完整性校验、重复点击、安装状态；组件测试覆盖两种模式及离页恢复；隔离 Electron 测试验证真实下载文件、主进程状态和用户资料未改变。签名安装使用适配器模拟测试，实际跨版本签名安装待证书具备后验证。

官方依据：https://www.electronjs.org/docs/latest/api/auto-updater 和 https://www.electronjs.org/docs/latest/tutorial/updates 。
