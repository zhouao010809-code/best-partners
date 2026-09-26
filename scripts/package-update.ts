import { packageDesktopUpdate, parseUpdatePackageArgs } from './lib/desktop-update-package.js';

if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
  process.stdout.write('用法：tsx scripts/package-update.ts [--preview]\n--preview：仅生成手动安装 DMG 与 SHA256SUMS，可用于尚未签名的预览包。\n默认：要求 Developer ID 签名、公证和已装订票据，额外生成 ZIP 与 RELEASES.json。\n输入：dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app\n输出：dist/updates/vX.Y.Z；不覆盖已有版本，不签名、不公证、不上传。\n');
} else {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此发布工具需要在 arm64 macOS 上运行。');
    const options = parseUpdatePackageArgs(process.argv.slice(2));
    const result = await packageDesktopUpdate({ root: process.cwd(), ...options });
    process.stdout.write(`${result.mode === 'preview' ? '手动安装预览包' : '正式更新资产'}已生成：${result.directory}\n${result.assets.map(asset => `  ${asset}`).join('\n')}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : '更新包生成失败。'}\n`);
    process.exitCode = 1;
  }
}
