import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchiveVault } from '../../../src/client/components/library/ArchiveVault.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';

function DelayedContents() {
  const [ready, setReady] = useState(false);
  useEffect(() => { const id = setTimeout(() => setReady(true), 900); return () => clearTimeout(id); }, []);
  return <div>{ready ? Array.from({ length: 40 }, (_, i) => <p key={i}>档案内容 {i + 1}</p>) : <p>正在读取档案</p>}</div>;
}
createRoot(document.getElementById('root')!).render(<main><ArchiveVault onSeal={() => {}}><DelayedContents /></ArchiveVault></main>);
