export function RecycleBinLid({ className = '' }: { readonly className?: string }) {
  return <span className={`recycle-bin-lid ${className}`} aria-hidden="true">
    <i className="recycle-bin-lid__handle" />
    <i className="recycle-bin-lid__panel" />
    <i className="recycle-bin-lid__edge" />
  </span>;
}

export function RecycleBinArtwork({ hasPapers, count }: { readonly hasPapers: boolean; readonly count: number | undefined }) {
  return <span className="sidebar-trash-icon" aria-hidden="true">
    {hasPapers && <i className="sidebar-trash-icon__paper" />}
    <i className="sidebar-trash-icon__body" />
    <RecycleBinLid className="sidebar-trash-icon__lid" />
    {count !== undefined && count > 0 && <span className="sidebar-trash-count">{count > 99 ? '99+' : count}</span>}
  </span>;
}
