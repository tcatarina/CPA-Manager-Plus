import { describe, expect, it } from 'vitest';
import { validateDryRunRecord } from '../bin/release/authorize-release-dispatch.mjs';

const repository = 'tcatarina/CPA-Manager-Plus';
const releaseTag = 'v1.12.14';
const releaseSha = 'a'.repeat(40);
const expectedTitle = `Build and Release · dry-run · ${releaseTag}`;

const githubRunNameRecord = {
  id: 35101156961,
  path: '.github/workflows/release.yml',
  name: expectedTitle,
  display_title: expectedTitle,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_sha: releaseSha,
  head_branch: 'main',
  run_attempt: 1,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};

describe('release dispatch GitHub run-name compatibility', () => {
  it('accepts the dynamic run-name shape returned by the workflow-runs API', () => {
    expect(
      validateDryRunRecord({
        run: githubRunNameRecord,
        releaseTag,
        releaseSha,
        repository,
      })
    ).toEqual({ runId: 35101156961, runAttempt: 1 });
  });

  it('still rejects unrelated workflow run names', () => {
    expect(() =>
      validateDryRunRecord({
        run: { ...githubRunNameRecord, name: 'Unrelated workflow run' },
        releaseTag,
        releaseSha,
        repository,
      })
    ).toThrow('expected successful dry-run');
  });
});
