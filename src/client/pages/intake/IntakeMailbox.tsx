import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import '../../styles/intake-tray.css';

export function IntakeMailbox({ open, count, busy, supportsDirectImport = false, onOpen, onClose, children }: {
  open: boolean;
  count: number;
  busy: boolean;
  supportsDirectImport?: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const insideId = useId();
  const finishId = useId().replace(/:/gu, '');
  const handle = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) handle.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return <section className={`intake-mailbox${open ? ' intake-mailbox--open' : ''}`} aria-label="收件箱箱体">
    {!open && <div className="intake-mailbox__stage">
      <div className="intake-mailbox__ground" aria-hidden="true" />
      <button ref={handle} className="intake-mailbox__object" type="button" aria-label="打开收件箱"
        aria-expanded={false} aria-controls={insideId} disabled={busy} onClick={onOpen}>
        <svg className="intake-postbox" viewBox="0 0 520 470" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id={`${finishId}-post`} x1="270" y1="320" x2="300" y2="320" gradientUnits="userSpaceOnUse"><stop stopColor="#151719" /><stop offset=".22" stopColor="#575b5e" /><stop offset=".4" stopColor="#b5b9ba" /><stop offset=".53" stopColor="#55595b" /><stop offset="1" stopColor="#151719" /></linearGradient>
            <linearGradient id={`${finishId}-side`} x1="330" y1="59" x2="363" y2="295" gradientUnits="userSpaceOnUse"><stop stopColor="#babebe" /><stop offset=".08" stopColor="#676d70" /><stop offset=".25" stopColor="#303638" /><stop offset=".57" stopColor="#15191b" /><stop offset=".88" stopColor="#202426" /><stop offset="1" stopColor="#3d4346" /></linearGradient>
            <linearGradient id={`${finishId}-rim`} x1="87" y1="128" x2="274" y2="287" gradientUnits="userSpaceOnUse"><stop stopColor="#b8bcbc" /><stop offset=".18" stopColor="#eceeee" /><stop offset=".36" stopColor="#575c5e" /><stop offset=".71" stopColor="#444a4d" /><stop offset=".9" stopColor="#c9cccb" /><stop offset="1" stopColor="#858a8c" /></linearGradient>
            <linearGradient id={`${finishId}-door`} x1="123" y1="99" x2="236" y2="302" gradientUnits="userSpaceOnUse"><stop stopColor="#3e4447" /><stop offset=".37" stopColor="#272c2f" /><stop offset=".77" stopColor="#15191b" /><stop offset="1" stopColor="#292e31" /></linearGradient>
            <linearGradient id={`${finishId}-metal`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#d0d3d3" /><stop offset=".2" stopColor="#737a7c" /><stop offset=".5" stopColor="#242a2d" /><stop offset=".82" stopColor="#9da4a6" /><stop offset="1" stopColor="#454b4e" /></linearGradient>
            <linearGradient id={`${finishId}-flag`} x1="382" y1="128" x2="404" y2="186" gradientUnits="userSpaceOnUse"><stop stopColor="#ce665c" /><stop offset=".45" stopColor="#963f38" /><stop offset="1" stopColor="#592821" /></linearGradient>
          </defs>
          <ellipse cx="283" cy="439" rx="117" ry="15" fill="#000" opacity=".55" />
          <path d="M261 433 285 424 319 433 295 445Z" fill="#171b1d" stroke="#555b5d" />
          <path d="M270 288H300V432Q286 440 270 432Z" fill={`url(#${finishId}-post)`} stroke="#656b6d" strokeWidth=".7" />
          <path d="M234 301 287 303 315 277 330 280 291 318 234 314Z" fill="#2e3538" stroke="#737b7e" strokeWidth=".8" />
          <path d="M107 294 302 321 447 276 256 255Z" fill="#303739" stroke="#7c8588" />
          <path d="M107 294V303L302 330 447 284V276L302 321Z" fill={`url(#${finishId}-metal)`} stroke="#212729" />
          <path d="M181 83 344 51C393 43 443 80 445 127V274L276 318V174C276 121 234 79 181 83Z" fill={`url(#${finishId}-side)`} stroke="#727b7e" strokeWidth="1.4" />
          <path d="M190 86 345 56C391 49 439 84 441 129" stroke="#dde2e1" strokeOpacity=".45" strokeWidth="1.2" />
          <path d="M281 299 436 261M284 304 436 267" stroke="#080d0f" strokeOpacity=".8" />
          <path d="M431 99Q439 113 439 135V267" stroke="#a2acae" strokeOpacity=".32" />
          <path d="M87 293V180C87 124 125 86 178 83S276 117 276 174V315Z" fill={`url(#${finishId}-rim)`} stroke="#dde2e1" strokeOpacity=".75" />
          <path d="M93 290V180C93 130 127 93 178 89S270 121 270 174V308Z" fill="#090d0f" stroke="#05090a" strokeWidth="2" />
          <g className="intake-postbox__door">
            <path d="M98 287V181C98 133 130 97 178 94S265 125 265 175V302Z" fill={`url(#${finishId}-door)`} stroke="#929b9f" strokeWidth="1.2" />
            <path d="M105 279V181C105 137 134 105 178 102S257 128 257 177V293Z" stroke="#aeb8bc" strokeOpacity=".12" />
            <path d="M145 147 217 151V158L145 154Z" fill="#080b0d" stroke="#6d797f" strokeWidth=".7" />
            <path d="M158 120 196 122V131L158 129Z" fill={`url(#${finishId}-metal)`} stroke="#aab3b7" strokeWidth=".8" />
            <path d="M163 122 191 124V128L163 126Z" fill="#171c20" />
            <text x="180" y="192" fill="#dce1e2" fontSize="17" letterSpacing="3" textAnchor="middle" transform="rotate(4 180 192)">收件箱</text>
            <text x="180" y="212" fill="#8d999e" fontSize="7.5" letterSpacing="2.7" textAnchor="middle" transform="rotate(4 180 212)">PERSONAL MAIL</text>
            <path d="M154 237 210 241V260L154 256Z" fill="#0d1317" stroke="#737f85" strokeWidth=".7" />
            <path d="m169 245 13 8 13-6m-26-2 26 2v9l-26-2Z" stroke="#9ca9af" strokeWidth="1" />
          </g>
          <path d="m115 287 30 3v8l-30-3Zm110 11 28 3v8l-28-3Z" fill={`url(#${finishId}-metal)`} stroke="#7d878c" />
          <g className="intake-postbox__flag">
            <path d="M374 213V117L408 110V139L384 144V210Z" fill={`url(#${finishId}-flag)`} stroke="#ca7970" strokeWidth=".8" />
            <path d="M378 202V120L403 115" stroke="#e2988e" strokeOpacity=".5" />
          </g>
          <circle cx="379" cy="210" r="8" fill={`url(#${finishId}-metal)`} stroke="#919a9e" />
          <circle cx="379" cy="210" r="2.5" fill="#22292d" stroke="#a6afb2" strokeWidth=".5" />
          <text x="332" y="257" fill="#879397" fontSize="8" letterSpacing="3" transform="rotate(-15 332 257)">最佳拍档</text>
        </svg>
        <span className="intake-mailbox__receipt"><i aria-hidden="true" /><span>{count} 份待整理</span></span>
      </button>
      <p className="intake-mailbox__invitation">打开收件箱<span aria-hidden="true">↗</span></p>
      <p className="intake-mailbox__source-note">
        {supportsDirectImport ? '收件箱接收浏览器剪辑插件保存的收藏；文件或粘贴文本请在上方导入。' : '收件箱接收浏览器剪辑插件保存的收藏。'}
      </p>
    </div>}
    <div id={insideId} className="intake-mailbox__inside" hidden={!open}>
      <header className="intake-mailbox__navigation">
        <button type="button" aria-label="合上收件箱" aria-expanded={true} aria-controls={insideId} disabled={busy} onClick={onClose}>
          <ArrowLeft aria-hidden="true" />合上收件箱
        </button>
        <span>收件箱内部<span>{count} 份</span></span>
      </header>
      <div className="intake-mailbox__raised-lid" aria-hidden="true">
        <span>INTAKE / 01</span><i /><i />
      </div>
      {children}
    </div>
  </section>;
}
