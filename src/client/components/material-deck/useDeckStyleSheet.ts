import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { numericCss, type MaterialDeckLayout } from './materialDeckLayout.js';

let instanceSequence = 0;

export function useDeckStyleSheet(layout: MaterialDeckLayout): string {
  const [instanceId] = useState(createInstanceId);
  const [nonce] = useState(readNonce);
  const styleElementRef = useRef<HTMLStyleElement | undefined>(undefined);
  const cssText = useMemo(
    () => buildScopedDeckCss(instanceId, layout),
    [instanceId, layout]
  );

  useLayoutEffect(() => {
    const styleElement = document.createElement('style');
    styleElement.nonce = nonce;
    styleElement.dataset.materialDeckStyle = instanceId;
    styleElement.textContent = cssText;
    document.head.append(styleElement);
    styleElementRef.current = styleElement;
    return () => {
      styleElement.remove();
      if (styleElementRef.current === styleElement) styleElementRef.current = undefined;
    };
  }, [instanceId, nonce]);

  useLayoutEffect(() => {
    const styleElement = styleElementRef.current;
    if (styleElement && styleElement.textContent !== cssText) styleElement.textContent = cssText;
  }, [cssText]);

  return instanceId;
}

export function buildScopedDeckCss(
  instanceId: string,
  layout: MaterialDeckLayout
): string {
  if (!/^[A-Za-z0-9]+$/u.test(instanceId)) throw new Error('INVALID_DECK_INSTANCE');
  const root = `[data-deck-instance="${instanceId}"]`;
  const rules = [
    `${root} .material-deck__track{--material-deck-track-width:${numericCss(layout.trackWidth)}px;--material-deck-track-height:${numericCss(layout.trackHeight)}px;}`
  ];

  for (const card of layout.cards) {
    const index = numericIndex(card.index);
    rules.push(
      `${root} [data-card-index="${index}"]{`
      + `--material-deck-left:${numericCss(card.left)}px;`
      + `--material-deck-top:${numericCss(card.top)}px;`
      + `--material-deck-width:${numericCss(card.width)}px;`
      + `--material-deck-height:${numericCss(card.height)}px;`
      + `--material-deck-y:${numericCss(card.y)}px;`
      + `--material-deck-z:${numericCss(card.z)}px;`
      + `--material-deck-rotate-y:${numericCss(card.rotateY)}deg;`
      + `--material-deck-rotate-z:${numericCss(card.rotateZ)}deg;`
      + `--material-deck-scale:${numericCss(card.scale)};`
      + `--material-deck-opacity:${numericCss(card.opacity)};`
      + `--material-deck-layer:${numericCss(card.zIndex)};`
      + '}'
    );
  }
  return rules.join('\n');
}

function createInstanceId(): string {
  instanceSequence += 1;
  const random = new Uint32Array(2);
  globalThis.crypto?.getRandomValues?.(random);
  return `MaterialDeck${instanceSequence.toString(36)}${random[0]!.toString(36)}${random[1]!.toString(36)}`;
}

function readNonce(): string {
  const nonce = document
    .querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
    ?.content.trim();
  if (!nonce) throw new Error('MISSING_CSP_NONCE');
  return nonce;
}

function numericIndex(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_DECK_CARD_INDEX');
  return numericCss(value);
}
