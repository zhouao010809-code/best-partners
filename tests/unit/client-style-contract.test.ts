import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const TOKENS_PATH = new URL('../../src/client/styles/tokens.css', import.meta.url);
const GLOBAL_PATH = new URL('../../src/client/styles/global.css', import.meta.url);
const SHELL_PATH = new URL('../../src/client/styles/shell.css', import.meta.url);

function hexChannel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
}

function linearChannel(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return (
    0.2126 * linearChannel(hexChannel(hex, 1))
    + 0.7152 * linearChannel(hexChannel(hex, 3))
    + 0.0722 * linearChannel(hexChannel(hex, 5))
  );
}

function contrastRatio(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

function token(css: string, name: string): string {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'iu'))?.[1];
  if (value === undefined) throw new Error(`Missing CSS token: ${name}`);
  return value;
}

describe('client style accessibility contract', () => {
  it('keeps muted and faint text readable on control surfaces', async () => {
    const css = await readFile(TOKENS_PATH, 'utf8');
    const control = token(css, 'surface-control');

    expect(contrastRatio(token(css, 'text-muted'), control)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token(css, 'text-faint'), control)).toBeGreaterThanOrEqual(4.5);
  });

  it('gives active navigation an outline that cannot be replaced by its active shadow', async () => {
    const css = await readFile(SHELL_PATH, 'utf8');

    expect(css).toMatch(/\.nav-item:focus-visible\s*\{[^}]*outline:\s*2px\s+solid/isu);
    expect(css).toMatch(/\.nav-item:focus-visible\s*\{[^}]*outline-offset:/isu);
  });

  it('lets narrow Markdown code blocks scroll instead of clipping', async () => {
    const [globalCss, shellCss] = await Promise.all([
      readFile(GLOBAL_PATH, 'utf8'),
      readFile(SHELL_PATH, 'utf8')
    ]);

    expect(`${globalCss}\n${shellCss}`).toMatch(
      /\.safe-markdown\s+pre\s*\{[^}]*overflow-x:\s*auto/isu
    );
  });
});
