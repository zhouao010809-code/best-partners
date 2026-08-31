import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MaterialDeck } from '../../../src/client/components/material-deck/MaterialDeck.js';
import type { MaterialDeckCard } from '../../../src/client/components/material-deck/materialDeckLayout.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';

const cards: MaterialDeckCard[] = Array.from({ length: 9 }, (_, index) => ({
  key: `fixture-${index + 1}`,
  path: `01图书馆/来自演示/知识材料-${index + 1}.md`,
  title: [
    '个人知识系统如何形成复利',
    '让原始材料真正变成可调用知识',
    '写作系统中的事实与判断',
    '不要用搜藏代替理解',
    '从问题到结论的最短路径',
    '可复用案例的结构化方法',
    '建立可追溯的内容证据链',
    '何时应该把经验升级为定论',
    '一个本地大脑的边界与规则'
  ][index]!,
  sourcePlatform: ['B站', 'YouTube', '公众号'][index % 3]!,
  collectedAt: `2026-08-${String(31 - index).padStart(2, '0')}`,
  knowledgeStatus: index % 3 === 0 ? '部分入库' : '未提炼',
  nextAction: index % 5 === 0 ? 'recover' : index % 3 === 0 ? 'resume' : 'start'
}));

const root = document.querySelector('[data-material-deck-fixture-root]');
if (!root) throw new Error('MISSING_MATERIAL_DECK_FIXTURE_ROOT');
createRoot(root).render(
  <StrictMode>
    <main className="material-deck-fixture">
      <MaterialDeck cards={cards} onPrimaryAction={() => undefined} />
    </main>
  </StrictMode>
);
