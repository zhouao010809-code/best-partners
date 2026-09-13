import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Archive, LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import '../../styles/archive-vault.css';

type Phase = 'closed' | 'opening' | 'open' | 'closing';
const ControlsTarget = createContext<HTMLDivElement | null>(null);
const ArchiveState = createContext({ activated: true, open: () => {} });
export const useArchiveVault = () => useContext(ArchiveState);

export function ArchiveControls({ children }: { children: ReactNode }) {
  const target = useContext(ControlsTarget);
  return target ? createPortal(children, target) : null;
}

export function ArchiveVault({ children, onSeal, initialOpen = false, revealKey = '', onOpenChange }: { children: ReactNode; onSeal: () => void; initialOpen?: boolean; revealKey?: string; onOpenChange?: (open: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>(initialOpen ? 'open' : 'closed');
  const [activated, setActivated] = useState(initialOpen);
  const focusOpening = useRef(false);
  const open = useCallback(() => { setActivated(true); setPhase(current => current === 'closed' || current === 'closing' ? 'opening' : current); }, []);
  useEffect(() => { if (revealKey) { setActivated(true); setPhase('open'); } }, [revealKey]);
  const [controlsTarget, setControlsTarget] = useState<HTMLDivElement | null>(null);
  const lockRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const visited = useRef(false);
  useEffect(() => {
    if (phase === 'opening' || phase === 'closing') {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const timer = window.setTimeout(() => setPhase(phase === 'opening' ? 'open' : 'closed'), reduced ? 0 : 380);
      return () => window.clearTimeout(timer);
    }
    if (phase === 'open') { visited.current = true; if (focusOpening.current) headingRef.current?.focus({ preventScroll: true }); focusOpening.current = false; }
    else if (visited.current) lockRef.current?.focus({ preventScroll: true });
    return undefined;
  }, [phase]);
  useEffect(() => { if (phase === 'open' || phase === 'closed') onOpenChange?.(phase === 'open'); }, [phase, onOpenChange]);
  return <ArchiveState.Provider value={{ activated, open }}><section className="archive-vault" data-state={phase} aria-label="档案柜">
    <header className="archive-vault__toolbar">
      <h2 ref={headingRef} tabIndex={-1}><LockKeyholeOpen aria-hidden="true" />档案调阅</h2>
      <button type="button" disabled={phase !== 'open'} aria-hidden={phase !== 'open'} onClick={() => { onSeal(); setPhase('closing'); }}><LockKeyhole aria-hidden="true" />封存并合柜</button>
    </header>
    <div className="archive-vault__control-space">
      <div ref={setControlsTarget} className="archive-vault__controls library-collections" />
    </div>
    <div className="archive-vault__body">
      <div className="archive-vault__contents" inert={phase !== 'open'} aria-hidden={phase !== 'open'}>
        <ControlsTarget.Provider value={controlsTarget}>{children}</ControlsTarget.Provider>
      </div>
      <div className="archive-vault__doors" aria-hidden="true">
        <div className="archive-vault__door archive-vault__door--left">
          <span className="archive-vault__plaque"><Archive /><strong>原始档案</strong><small>收藏 · 留存 · 追溯</small></span>
          <span className="archive-vault__hinge archive-vault__hinge--top" /><span className="archive-vault__hinge archive-vault__hinge--bottom" />
        </div>
        <div className="archive-vault__door archive-vault__door--right"><span className="archive-vault__door-line" /></div>
      </div>
      {phase !== 'open' && <div className="archive-vault__entry">
        <button type="button" ref={lockRef} className="archive-vault__lock" aria-label="打开档案柜" disabled={phase !== 'closed'} aria-expanded={false} onClick={() => { focusOpening.current = true; open(); }}>
          <span className="archive-vault__lock-ring"><span className="archive-vault__lock-core"><LockKeyhole aria-hidden="true" /></span></span>
        </button>
        <span className="archive-vault__entry-label" role="status">{phase === 'closed' ? '点击锁扣，调阅档案' : phase === 'opening' ? '正在开柜' : '正在合柜'}</span>
      </div>}
    </div>
    <footer className="archive-vault__foot"><span><span />{phase === 'closed' ? '柜门已合拢' : phase === 'open' ? '正在调阅' : '柜门调整中'}</span><span>原文与附件完整保留</span></footer>
  </section></ArchiveState.Provider>;
}
