import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AssistantPanel, AssistantToggle } from '../../../src/client/components/assistant/AssistantPanel.js';
import type { ReadConsoleApi } from '../../../src/client/api/client.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';

// Visual-only fixture. No filesystem access, provider request or save operation.
const api = { assistant: {
  providers: async () => ({ ok: true, value: { providers: [] } }),
  history: async () => ({ ok: true, value: { conversations: [] } })
} } as unknown as ReadConsoleApi;
function Fixture() {
  const [open, setOpen] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [running, setRunning] = useState(false);
  const [width, setWidth] = useState(430);
  return <MemoryRouter><div className="app-frame" style={{padding:32, minHeight:'100dvh', background:'#141617'}}>
    <h1 style={{fontSize:22}}>边框流光验证</h1><p>全部为内存示例。操作按钮检查问问入口与面板的独立边框。</p>
    <div className="queue-workspace" data-ai-active={extracting || undefined} style={{margin:'24px 0'}}><button onClick={() => setExtracting(value => !value)}>{extracting ? '结束示例提炼' : '开始示例提炼'}</button></div>
    <AssistantToggle open={open} running={running} onClick={() => setOpen(value => !value)} />
    <AssistantPanel api={api} open={open} onClose={() => setOpen(false)} width={width} onWidthChange={setWidth} onRunningChange={setRunning} />
  </div></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
