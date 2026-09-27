import { describe, expect, it } from 'vitest';
import {
  authorizeReleaseDispatch,
  validateDryRunRecord,
} from '../bin/release/authorize-release-dispatch.mjs';

const repository = 'tcatarina/CPA-Manager-Plus';
const releaseTag = 'v1.2.3';
const releaseSha = 'a'.repeat(40);

const dryRunRecord = {
  id: 12345,
  path: '.github/workflows/release.yml',
  name: 'Build and Release',
  display_title: `Build and Release · dry-run · ${releaseTag}`,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_sha: releaseSha,
  head_branch: 'main',
  run_attempt: 1,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};

const exactTag = {
  ref: `refs/tags/${releaseTag}`,
  object: { type: 'commit', sha: releaseSha },
};

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const makeFetch = ({ existingTag = null, dryRun = dryRunRecord } = {}) => {
  const calls = [];
  let createdTag = null;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith(`/git/ref/tags/${encodeURIComponent(releaseTag)}`)) {
      if (createdTag) return jsonResponse(200, createdTag);
      return existingTag ? jsonResponse(200, existingTag) : jsonResponse(404, { message: 'Not Found' });
    }
    if (url.endsWith('/actions/runs/12345')) return jsonResponse(200, dryRun);
    if (url.endsWith('/git/refs') && options.method === 'POST') {
      createdTag = {
        ref: `refs/tags/${releaseTag}`,
        object: { type: 'commit', sha: releaseSha },
      };
      return jsonResponse(201, createdTag);
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };
  return { calls, fetchImpl };
};

describe('release dispatch authorization', () => {
  it('accepts only the exact successful dry-run identity', () => {
    expect(
      validateDryRunRecord({ run: dryRunRecord, releaseTag, releaseSha, repository })
    ).toEqual({ runId: 12345, runAttempt: 1 });

    expect(() =>
      validateDryRunRecord({
        run: { ...dryRunRecord, head_sha: 'b'.repeat(40) },
        releaseTag,
        releaseSha,
        repository,
      })
    ).toThrow('expected successful dry-run');
    expect(() =>
      validateDryRunRecord({
        run: { ...dryRunRecord, display_title: 'Build and Release · dry-run · v9.9.9' },
        releaseTag,
        releaseSha,
        repository,
      })
    ).toThrow('expected successful dry-run');
  });

  it('keeps dry-run read-only and requires the target tag to be absent', async () => {
    const { fetchImpl } = makeFetch();
    await expect(
      authorizeReleaseDispatch({
        mode: 'dry-run',
        releaseTag,
        releaseSha,
        expectedSha: releaseSha,
        repository,
        token: 'token',
        fetchImpl,
      })
    ).resolves.toEqual({
      action: 'validate',
      mode: 'dry-run',
      tagCreated: false,
      tagReused: false,
      dryRunId: null,
    });

    await expect(
      authorizeReleaseDispatch({
        mode: 'dry-run',
        releaseTag,
        releaseSha,
        repository,
        token: 'token',
        fetchImpl: makeFetch({ existingTag: exactTag }).fetchImpl,
      })
    ).rejects.toThrow('already exists');
  });

  it('requires explicit publish confirmation, exact SHA, a valid attempt, and a successful prior dry-run', async () => {
    const base = {
      mode: 'publish',
      releaseTag,
      releaseSha,
      expectedSha: releaseSha,
      dryRunId: '12345',
      confirmPublish: true,
      repository,
      token: 'token',
    };

    await expect(
      authorizeReleaseDispatch({ ...base, confirmPublish: false, fetchImpl: makeFetch().fetchImpl })
    ).rejects.toThrow('explicit confirmation');
    await expect(
      authorizeReleaseDispatch({
        ...base,
        expectedSha: 'b'.repeat(40),
        fetchImpl: makeFetch().fetchImpl,
      })
    ).rejects.toThrow('does not match release SHA');
    await expect(
      authorizeReleaseDispatch({
        ...base,
        dryRunId: '',
        fetchImpl: makeFetch().fetchImpl,
      })
    ).rejects.toThrow('successful dry_run_id');
    await expect(
      authorizeReleaseDispatch({ ...base, runAttempt: '0', fetchImpl: makeFetch().fetchImpl })
    ).rejects.toThrow('attempt must be a positive integer');
    await expect(
      authorizeReleaseDispatch({
        ...base,
        fetchImpl: makeFetch({ dryRun: { ...dryRunRecord, conclusion: 'failure' } }).fetchImpl,
      })
    ).rejects.toThrow('expected successful dry-run');
  });

  it('keeps explicit validate action read-only before tag creation', async () => {
    const { calls, fetchImpl } = makeFetch();
    const result = await authorizeReleaseDispatch({
      mode: 'publish',
      releaseTag,
      releaseSha,
      expectedSha: releaseSha,
      dryRunId: '12345',
      confirmPublish: true,
      repository,
      token: 'token',
      fetchImpl,
    });

    expect(result).toEqual({
      action: 'validate',
      mode: 'publish',
      tagCreated: false,
      tagReused: false,
      dryRunId: 12345,
      dryRunAttempt: 1,
    });
    expect(calls.some(({ url, options }) => url.endsWith('/git/refs') && options.method === 'POST')).toBe(false);
  });

  it('creates and re-reads the exact lightweight tag in the create-tag action', async () => {
    const { calls, fetchImpl } = makeFetch();
    const result = await authorizeReleaseDispatch({
      action: 'create-tag',
      mode: 'publish',
      releaseTag,
      releaseSha,
      expectedSha: releaseSha,
      dryRunId: '12345',
      confirmPublish: true,
      repository,
      token: 'token',
      fetchImpl,
    });

    expect(result).toEqual({
      action: 'create-tag',
      mode: 'publish',
      tagCreated: true,
      tagReused: false,
      dryRunId: 12345,
      dryRunAttempt: 1,
    });
    const createCall = calls.find(({ url, options }) => url.endsWith('/git/refs') && options.method === 'POST');
    expect(JSON.parse(createCall.options.body)).toEqual({
      ref: `refs/tags/${releaseTag}`,
      sha: releaseSha,
    });
  });

  it('fails closed when a tag already exists before the first publish attempt', async () => {
    await expect(
      authorizeReleaseDispatch({
        action: 'create-tag',
        mode: 'publish',
        releaseTag,
        releaseSha,
        expectedSha: releaseSha,
        dryRunId: '12345',
        confirmPublish: true,
        runAttempt: 1,
        repository,
        token: 'token',
        fetchImpl: makeFetch({ existingTag: exactTag }).fetchImpl,
      })
    ).rejects.toThrow('already exists before first publish attempt');
  });

  it('reuses only the exact existing tag on a publish workflow rerun', async () => {
    const { calls, fetchImpl } = makeFetch({ existingTag: exactTag });
    await expect(
      authorizeReleaseDispatch({
        action: 'create-tag',
        mode: 'publish',
        releaseTag,
        releaseSha,
        expectedSha: releaseSha,
        dryRunId: '12345',
        confirmPublish: true,
        runAttempt: 2,
        repository,
        token: 'token',
        fetchImpl,
      })
    ).resolves.toEqual({
      action: 'create-tag',
      mode: 'publish',
      tagCreated: false,
      tagReused: true,
      dryRunId: 12345,
      dryRunAttempt: 1,
    });
    expect(calls.some(({ url, options }) => url.endsWith('/git/refs') && options.method === 'POST')).toBe(false);

    const wrongTag = {
      ...exactTag,
      object: { type: 'commit', sha: 'b'.repeat(40) },
    };
    await expect(
      authorizeReleaseDispatch({
        action: 'create-tag',
        mode: 'publish',
        releaseTag,
        releaseSha,
        expectedSha: releaseSha,
        dryRunId: '12345',
        confirmPublish: true,
        runAttempt: 2,
        repository,
        token: 'token',
        fetchImpl: makeFetch({ existingTag: wrongTag }).fetchImpl,
      })
    ).rejects.toThrow('does not point directly');
  });

  it('rejects tag creation outside publish mode', async () => {
    await expect(
      authorizeReleaseDispatch({
        action: 'create-tag',
        mode: 'dry-run',
        releaseTag,
        releaseSha,
        repository,
        token: 'token',
        fetchImpl: makeFetch().fetchImpl,
      })
    ).rejects.toThrow('only for publish dispatches');
  });

  it('verifies the existing lightweight tag for tag-triggered releases', async () => {
    await expect(
      authorizeReleaseDispatch({
        mode: 'tag',
        releaseTag,
        releaseSha,
        repository,
        token: 'token',
        fetchImpl: makeFetch({ existingTag: exactTag }).fetchImpl,
      })
    ).resolves.toEqual({
      action: 'validate',
      mode: 'tag',
      tagCreated: false,
      tagReused: true,
      dryRunId: null,
    });
  });
});