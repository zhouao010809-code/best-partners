# Native Messaging host 配置

桌面 App 在用户确认安装后生成浏览器所需的 Native Messaging manifest。扩展的公开 `key` 固定在 `manifest.json`，用于保持本地安装的扩展 ID 稳定；此目录不存放真实 manifest、扩展私钥、令牌、用户目录或 API key，私钥永不提交仓库。

扩展连接的 host 名称是 `local.bestpartners.clipper`。Chrome/Edge 会在首次连接时要求用户确认，卸载扩展或在桌面 App 中卸载 host 都必须由用户明确操作。
