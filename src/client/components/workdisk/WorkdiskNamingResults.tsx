import { Check, X } from 'lucide-react';
import type { WorkdiskNamingReceipt } from '../../../shared/workdisk.js';

export function WorkdiskNamingResults({ receipts, onClose }: { receipts: WorkdiskNamingReceipt[]; onClose(): void }) {
  const renamed = receipts.filter(receipt => receipt.status === 'renamed').length;
  return <section className="workdisk-naming-results" aria-label="本次收纳命名结果">
    <header><strong><Check size={15} />{renamed} 份已根据内容命名<span>{receipts.length - renamed > 0 ? ` · ${receipts.length - renamed} 份沿用原名` : ''}</span></strong><button aria-label="收起命名结果" onClick={onClose}><X size={15} /></button></header>
    <ul>{receipts.map((receipt, index) => <li key={`${index}-${receipt.originalName}`} className={receipt.status === 'kept' ? 'workdisk-naming-kept' : ''}>
      <div><span>{receipt.originalName}</span><span aria-hidden="true">→</span><strong>{receipt.savedName}</strong></div><p>{receipt.reason}</p>
    </li>)}</ul>
  </section>;
}
