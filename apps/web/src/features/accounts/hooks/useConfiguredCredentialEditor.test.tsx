import type { TFunction } from 'i18next';
import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenAIProviderConfig } from '@/types';
const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/services/api/client', () => ({
  apiClient: { get: mocks.get },
  createScopedApiRequestConfig: (scope: unknown) => scope,
}));
vi.mock('@/services/api/providers', () => ({
  providersApi: { patchOpenAICredential: mocks.patch },
}));
const t = ((key: string) => key) as TFunction;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
import { useConfiguredCredentialEditor } from './useConfiguredCredentialEditor';
const provider: OpenAIProviderConfig = {
  name: 'glm',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  prefix: 'old',
  apiKeyEntries: [{ apiKey: 'test-secret', authIndex: 'a', weight: 2 }],
};
const scope = { apiBase: 'http://localhost', managementKey: 'test' };
const onSaved = vi.fn();
let editor: ReturnType<typeof useConfiguredCredentialEditor>;
function Harness() {
  const value = useConfiguredCredentialEditor(provider, provider.apiKeyEntries[0], scope, onSaved);
  useEffect(() => { editor = value; }, [value]);
  return null;
}
const response = {
  'openai-compatibility': [
    {
      name: 'glm',
      'base-url': provider.baseUrl,
      prefix: 'team',
      'api-key-entries': [{ 'api-key': 'test-secret', 'auth-index': 'b', weight: 0 }],
    },
  ],
};
beforeEach(() => {
  mocks.get.mockReset();
  mocks.patch.mockReset();
  onSaved.mockReset();
});
function render() {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  return renderer;
}
describe('configuration-backed credential editor', () => {
  it('writes selected-key and shared settings through provider endpoint and reloads', async () => {
    mocks.patch.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(response);
    const renderer = render();
    act(() => {
      editor.editor.updateField('prefix', 'team');
      editor.editor.updateField('weight', '0');
    });
    expect(editor.editor.canSave).toBe(true);
    expect(editor.editor.rawDataText).not.toContain('test-secret');
    await act(async () => editor.editor.save());
    expect(mocks.patch).toHaveBeenCalledWith(
      provider,
      provider.apiKeyEntries[0],
      { prefix: 'team' },
      { weight: 0 },
      scope
    );
    expect(editor.editor.dirty).toBe(false);
    expect(editor.editor.draft?.prefix).toBe('team');
    expect(editor.entry.authIndex).toBe('b');
    act(() => renderer.unmount());
  });
  it('keeps draft and reports failed persistence', async () => {
    mocks.patch.mockRejectedValue(new Error('write failed'));
    const renderer = render();
    act(() => editor.editor.updateField('weight', '3'));
    await act(async () => editor.editor.save());
    expect(editor.error).toBe('write failed');
    expect(editor.editor.dirty).toBe(true);
    expect(editor.editor.draft?.weight).toBe('3');
    act(() => renderer.unmount());
  });
  it('refuses invalid priority, weight, headers and URL before writing', async () => {
    const renderer = render();
    act(() => {
      editor.editor.updateField('priority', '0.5');
      editor.editor.updateField('weight', '-1');
      editor.editor.updateField('headersText', '{bad');
      editor.editor.updateField('baseUrl', 'file:///secret');
    });
    expect(editor.editor.canSave).toBe(false);
    await act(async () => editor.editor.save());
    expect(mocks.patch).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
