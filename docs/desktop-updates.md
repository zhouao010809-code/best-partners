# 桌面发布资产

发布仓库固定为 `zhouao010809-code/best-partners`，tag 使用 `vX.Y.Z`。此工具只制作本地资产；不修改版本、不构建 App、不签名、公证或上传 GitHub。

## 当前：手动安装预览包

没有 Apple Developer ID 时使用预览模式。先把 `package.json` 更新到本次版本并构建桌面 App，再运行：

```bash
npm run package:mac
npx tsx scripts/package-update.ts --preview
```

输入固定为 `dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app`。工具核对暂存 App 的 `CFBundleShortVersionString`、`CFBundleVersion` 与仓库 `package.json` 完全一致，并核对主程序为 `arm64`。

产物位于 `dist/updates/vX.Y.Z/`：

```text
best-partners-X.Y.Z-arm64.dmg
SHA256SUMS
```

DMG 内包含 `最佳拍档.app` 和指向 `/Applications` 的链接，可拖入“应用程序”手动安装。预览模式不会生成 ZIP 或 `RELEASES.json`，不会让未签名 App 进入自动更新通道；下载到其他 Mac 后仍可能需要用户处理系统对未签名 App 的限制。

`SHA256SUMS` 是可发布的校验文件，在产物目录中用 `shasum -a 256 -c SHA256SUMS` 核对。工具不会覆盖同版本目录，重新制作前应核对并移走旧产物。失败时移除本次暂存目录，不保留半成品。

## 后续：已签名 App 的自动更新资产

先在发布流程中完成 Developer ID Application 签名、Apple 公证并装订票据，再对完成这些步骤的 App 运行默认模式：

```bash
npx tsx scripts/package-update.ts
```

默认模式按顺序执行只读校验：

1. `codesign --verify --deep --strict --verbose=2` 验证签名完整性。
2. `codesign --display --verbose=4` 必须显示 Developer ID Application 和有效 TeamIdentifier，不能是 ad-hoc 签名。
3. `spctl --assess --type execute --verbose=2` 必须成功且报告 `source=Notarized Developer ID`。
4. `xcrun stapler validate` 必须验证已装订的公证票据。

任一步失败就停止，不生成自动更新源。成功后在同一版本目录额外生成 `best-partners-X.Y.Z-arm64.zip`、`RELEASES.json`，并把 ZIP 和 JSON 的 SHA-256 加入校验文件。校验的是 DMG/ZIP 共用的暂存 App；此脚本不会另外对新生成的 DMG 容器签名或公证。

清单遵循 [Electron 官方静态更新格式](https://www.electronjs.org/docs/latest/tutorial/updates#publishing-release-metadata)，对应 `autoUpdater.setFeedURL({ url, serverType: 'json' })`：

```json
{
  "currentRelease": "1.2.3",
  "releases": [{
    "version": "1.2.3",
    "updateTo": {
      "version": "1.2.3",
      "pub_date": "2026-09-26T00:00:00.000Z",
      "name": "最佳拍档 v1.2.3",
      "notes": "",
      "url": "https://github.com/zhouao010809-code/best-partners/releases/download/v1.2.3/best-partners-1.2.3-arm64.zip"
    }
  }]
}
```

发布时，tag、DMG、ZIP、清单内版本必须一致；把正式目录全部资产附到对应 GitHub Release。支持此更新通道的客户端可把 `https://github.com/zhouao010809-code/best-partners/releases/latest/download/RELEASES.json` 作为静态清单地址。不要把无签名预览版标成正式自动更新发布，也不要上传伪造清单。

macOS 内置自动更新要求当前 App 也已签名，详情见 [Electron autoUpdater 文档](https://www.electronjs.org/docs/latest/api/auto-updater#macos)。现有未签名安装需要手动安装首个签名版本；后续保持相同发布身份。完整的签名版本升级、退出安装和重启恢复仍需要用两个真实签名版本进行验收；mock 测试不能证明这条系统链路。

## 开发验证

```bash
npx vitest run --config vitest.config.ts tests/unit/desktop-update-package.test.ts
npx tsx scripts/package-update.ts --help
```

单元测试使用临时合成 App 和命令替身，检查模式、版本、签名/公证阻断、Applications 链接、静态清单、校验值以及失败清理；不会签名、请求模型或访问真实用户资料。
