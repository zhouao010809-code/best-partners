import { ArrowUpRight, LibraryBig } from 'lucide-react';
import type { LibraryPage } from '../../../shared/api/library.js';

export function CollectionFolder({ folder, onOpen }: {
  folder: LibraryPage['folders'][number]; onOpen: () => void;
}) {
  return <button type="button" className="library-collection" onClick={onOpen} aria-label={`打开 ${folder.label}`}>
    <span className="library-object-space" aria-hidden="true">
      <span className="library-case">
        <span className="library-backplate" /><span className="library-tab" />
        <span className="library-sheet library-sheet--one" />
        <span className="library-sheet library-sheet--two"><span className="library-sheet-lines" /></span>
        <span className="library-sheet library-sheet--three"><span className="library-sheet-lines" /></span>
        <span className="library-cover"><span className="library-cover-label"><LibraryBig />{folder.label}</span></span>
      </span>
    </span>
    <span className="library-folder-label"><strong>{folder.label}</strong><span className="library-folder-arrow"><ArrowUpRight aria-hidden="true" /></span></span>
    <span className="library-folder-count"><b>{folder.count}</b> 份资料{folder.folderCount > 0 && <><span aria-hidden="true">/</span>{folder.folderCount} 个目录</>}</span>
  </button>;
}
