import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyAccountPinnedOrder,
  readAccountPinnedKeys,
  toggleAccountPinnedKey,
  writeAccountPinnedKeys,
} from './accountPinnedRows';

const createMemoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

const originalWindow = (globalThis as { window?: unknown }).window;
const rows = (...keys: string[]) => keys.map((selectionKey) => ({ selectionKey }));
const keysOf = (items: { selectionKey: string }[]) => items.map((item) => item.selectionKey);

describe('applyAccountPinnedOrder', () => {
  it('puts pinned rows first in pin order and keeps the rest in sorted order', () => {
    const ordered = applyAccountPinnedOrder(rows('a', 'b', 'c', 'd', 'e'), ['d', 'b']);
    expect(keysOf(ordered)).toEqual(['d', 'b', 'a', 'c', 'e']);
  });

  it('never adds pinned rows that the filters removed', () => {
    const ordered = applyAccountPinnedOrder(rows('a', 'c'), ['b', 'c']);
    expect(keysOf(ordered)).toEqual(['c', 'a']);
  });

  it('appends new pins after existing pins and removes them on second toggle', () => {
    const pinned = toggleAccountPinnedKey(toggleAccountPinnedKey([], 'x'), 'y');
    expect(pinned).toEqual(['x', 'y']);
    expect(toggleAccountPinnedKey(pinned, 'x')).toEqual(['y']);
  });
});

describe('account pinned keys storage', () => {
  let storage = createMemoryStorage();

  beforeEach(() => {
    storage = createMemoryStorage();
    (globalThis as { window?: unknown }).window = { localStorage: storage };
  });

  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('round-trips pin order', () => {
    writeAccountPinnedKeys(['b', 'a']);
    expect(readAccountPinnedKeys()).toEqual(['b', 'a']);
  });

  it('drops invalid and duplicate entries from stored data', () => {
    storage.setItem('cpa_manager_accounts_pinned_v1', JSON.stringify(['a', 1, '', 'a', 'b']));
    expect(readAccountPinnedKeys()).toEqual(['a', 'b']);
    storage.setItem('cpa_manager_accounts_pinned_v1', '{broken');
    expect(readAccountPinnedKeys()).toEqual([]);
  });
});
