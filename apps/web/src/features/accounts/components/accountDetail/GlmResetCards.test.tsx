import type { TFunction } from 'i18next';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), confirm: vi.fn() }));
vi.mock('@/services/api/apiCall', () => ({ apiCallApi: { request: mocks.request } }));
vi.mock('@/services/api/codexQuota', () => ({ createCodexRedeemRequestId: () => 'ui-request-id' }));
const t = ((key: string) => key) as TFunction;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'en' } }) }));
import { GlmResetCards } from './GlmResetCards';
const scope = { apiBase: 'http://local-reset.example', managementKey: 'management' };
const list = (entries: unknown[] = []) => ({
  statusCode: 200,
  body: { success: true, code: 200, data: { fiveHourResets: entries, weekResets: [] } },
});
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
let sequence = 0;
beforeEach(() => {
  mocks.request.mockReset();
  mocks.confirm.mockReset();
  mocks.confirm.mockReturnValue(true);
  vi.stubGlobal('window', { confirm: mocks.confirm });
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  });
});
async function render(onReset = vi.fn(), disabled = false) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <GlmResetCards
        authIndex={`ui-${++sequence}`}
        scope={scope}
        disabled={disabled}
        onReset={onReset}
        onBusyChange={() => {}}
      />
    );
  });
  return renderer;
}
const useButton = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByType('button').find((node) => text(node) === 'glm_reset.use')!;
describe('GLM reset card controls', () => {
  it('shows real empty inventory rather than an active reset action', async () => {
    mocks.request.mockResolvedValue(list());
    const renderer = await render();
    expect(text(renderer.root)).toContain('glm_reset.empty');
    expect(useButton(renderer)).toBeUndefined();
    act(() => renderer.unmount());
  });
  it('does not consume a card if confirmation is cancelled', async () => {
    mocks.request.mockResolvedValue(list([{ recordId: 123 }]));
    mocks.confirm.mockReturnValue(false);
    const renderer = await render();
    await act(async () => useButton(renderer).props.onClick());
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
    act(() => renderer.unmount());
  });
  it('keeps committed reset success even when subsequent card refresh fails', async () => {
    mocks.request
      .mockResolvedValueOnce(list([{ recordId: 123 }]))
      .mockResolvedValueOnce(list([{ recordId: 123 }]))
      .mockResolvedValueOnce({ statusCode: 200, body: { success: true, code: 200 } })
      .mockRejectedValueOnce(new Error('list unavailable'));
    const reset = vi.fn();
    const renderer = await render(reset);
    await act(async () => useButton(renderer).props.onClick());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(text(renderer.root)).toContain('glm_reset.success');
    expect(useButton(renderer)).toBeUndefined();
    act(() => renderer.unmount());
  });
  it('offers retry of pending card after lost response', async () => {
    mocks.request
      .mockResolvedValueOnce(list([{ recordId: 123 }]))
      .mockResolvedValueOnce(list([{ recordId: 123 }]))
      .mockRejectedValueOnce(new Error('timeout'));
    const renderer = await render();
    await act(async () => useButton(renderer).props.onClick());
    expect(text(renderer.root)).toContain('glm_reset.error_uncertain');
    expect(text(renderer.root)).toContain('glm_reset.retry');
    act(() => renderer.unmount());
  });
  it('disables redemption when editing controls are unavailable', async () => {
    mocks.request.mockResolvedValue(list([{ recordId: 123 }]));
    const renderer = await render(vi.fn(), true);
    expect(useButton(renderer).props.disabled).toBe(true);
    act(() => renderer.unmount());
  });
});
