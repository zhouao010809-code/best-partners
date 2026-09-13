import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import type { ExtractionRun } from '../../shared/api/extraction.js';

const labels = { generating: '正在提炼', ready: '候选待审阅', failed: '未完成', cancelled: '已停止' } as const;
export function ExtractionHistory() {
  const { api } = useConsoleRuntime();
  const service = api.extraction;
  const [items, setItems] = useState<ExtractionRun[]>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (service) void service.list(undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) { setItems(result.value.items); setFailed(false); }
      else if ('state' in result) setFailed(true);
    });
    return () => controller.abort();
  }, [service, revision]);
  if (!service) return null;
  return <details className="extraction-history extraction-saved" open={items !== undefined && items.length > 0}>
    <summary>最近提炼记录{items === undefined ? '' : ` · ${items.length} 条`}</summary>
    {failed ? <div><p role="status">提炼记录暂时不可用，已保存的候选不会删除。</p><button className="quiet-button" type="button" onClick={() => setRevision((v) => v + 1)}>重读提炼记录</button></div>
      : items === undefined ? <p role="status">正在读取提炼记录…</p>
        : items.length === 0 ? <p className="extraction-muted">还没有提炼记录。从下面选择一份已归档资料即可开始。</p>
          : <div className="extraction-history">{items.map((item) => <Link key={item.id} to={`/extractions/${item.id}`}>{item.title} · {labels[item.status]} · {new Date(item.createdAt).toLocaleString('zh-CN')}</Link>)}<span className="extraction-muted">最近 50 次提炼记录 · 入库进度请打开查看</span></div>}
  </details>;
}
