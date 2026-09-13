import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { ReadableDocument } from '../../src/client/pages/queue/ingestion/ReviewFields.js';

afterEach(cleanup);

it.each(['', '\uFEFF'])('renders CRLF source properties separately from Markdown with BOM %j', (bom) => {
  const properties = '类型: 原始资料\r\n知识入库状态: 部分入库';
  render(<MemoryRouter><ReadableDocument markdown={`${bom}---\r\n${properties}\r\n---\r\n# 原文正文\r\n\r\n源文件内容保留。\r\n<script>unsafe()</script>`} /></MemoryRouter>);
  expect(screen.getByText('笔记属性')).toBeVisible();
  expect(document.querySelector('.ingestion-document-properties pre')?.textContent).toBe(properties);
  expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['原文正文']);
  expect(screen.getByText('源文件内容保留。')).toBeVisible();
  expect(document.querySelector('script')).toBeNull();
});
