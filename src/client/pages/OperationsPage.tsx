import { useEffect, useState } from 'react';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { PageState } from '../components/PageState.js';
import type { OperationPage } from '../api/client.js';
import { isCancelled, stableFailure, validationState, type PageResource } from './pageSupport.js';

export function OperationsPage() {
  const runtime = useConsoleRuntime();
  const [resource, setResource] = useState<PageResource<OperationPage>>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setResource((current) => {
      const data = current.status === 'ready' || current.status === 'refreshing' || current.status === 'failed'
        ? current.data
        : undefined;
      return data === undefined ? { status: 'loading' } : { status: 'refreshing', data };
    });
    void runtime.api.listOperations(controller.signal).then((result) => {
      if (controller.signal.aborted || isCancelled(result)) return;
      if (!result.ok) {
        setResource({ status: 'failed', state: stableFailure(result.state.status, '读取操作') });
        return;
      }
      if (result.value.nextCursor !== undefined) {
        setResource({ status: 'failed', state: validationState('操作记录响应不符合只读契约') });
        return;
      }
      setResource({ status: 'ready', data: result.value });
    });
    return () => controller.abort();
  }, [runtime.api, runtime.dataRevision]);

  return (
    <section className="instrument-panel workspace-panel empty-ledger" aria-labelledby="operations-ledger-title">
      <div className="ledger-ruler" aria-hidden="true"><span>TIME</span><span>OPERATION</span><span>STATUS</span><span>TRACE</span></div>
      <h2 id="operations-ledger-title" className="visually-hidden">只读操作记录</h2>
      {resource.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取本地操作记录' }} />}
      {resource.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在刷新操作记录' }} />}
      {resource.status === 'failed' && <PageState state={resource.state} />}
      {resource.status === 'ready' && (
        <PageState state={{ status: 'empty', message: '当前尚无提炼/写入工作流操作' }} />
      )}
    </section>
  );
}
