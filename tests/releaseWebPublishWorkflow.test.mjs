import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const authorization = readFileSync(
  path.join(repoRoot, 'bin', 'release', 'authorize-release-dispatch.mjs'),
  'utf8'
);

const indexOfRequired = (text, value) => {
  const index = text.indexOf(value);
  expect(index, `missing expected release workflow contract: ${value}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('web release publish workflow', () => {
  it('exposes explicit dry-run and publish dispatch inputs', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('mode:');
    expect(workflow).toContain('- dry-run');
    expect(workflow).toContain('- publish');
    expect(workflow).toContain('expected_sha:');
    expect(workflow).toContain('dry_run_id:');
    expect(workflow).toContain('confirm_publish:');
    expect(workflow).toContain("Release dispatch must run from main");
  });

  it('binds publish authorization to the exact main SHA and successful prior dry-run', () => {
    expect(authorization).toContain('Publish dispatch requires expected_sha to match the exact main SHA');
    expect(authorization).toContain('Publish dispatch requires a successful dry_run_id');
    expect(authorization).toContain('The supplied run is not the expected successful dry-run');
    expect(authorization).toContain("run?.head_branch !== 'main'");
    expect(authorization).toContain("run?.path !== releaseWorkflowPath");
    expect(authorization).toContain('confirmPublish !== true');
  });

  it('creates the tag inside the publish run instead of depending on recursive tag events', () => {
    expect(authorization).toContain("mode === 'publish' ? 'create-tag' : 'validate'");
    expect(authorization).toContain("ref: `refs/tags/${releaseTag}`");
    expect(authorization).toContain("method: 'POST'");
    expect(authorization).toContain('validateTagRef({ ref: verifiedTag, releaseTag, releaseSha })');
  });

  it('allows reruns to reuse only the exact tag created by the original publish attempt', () => {
    expect(authorization).toContain('Release workflow attempt must be a positive integer');
    expect(authorization).toContain('Release tag already exists before first publish attempt');
    expect(authorization).toContain('currentAttempt === 1');
    expect(authorization).toContain('tagReused: true');
    expect(authorization).toContain('does not point directly to');
  });

  it('pins OCI provenance to the release SHA and version', () => {
    expect(workflow).toContain('org.opencontainers.image.revision=${{ env.RELEASE_SHA }}');
    expect(workflow).toContain('org.opencontainers.image.version=${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}');
  });

  it('verifies pushed image provenance before publishing the draft GitHub Release', () => {
    const verifyIndex = indexOfRequired(workflow, "import { verifyImage } from './bin/release/publish-update-index.mjs';");
    const publishIndex = indexOfRequired(workflow, 'Publish verified draft GitHub Release');
    expect(verifyIndex).toBeLessThan(publishIndex);
    expect(workflow).toContain('Registry digest mismatch');
  });

  it('keeps Telegram non-idempotent delivery out of release reruns', () => {
    expect(workflow).not.toContain('notify_telegram');
    expect(workflow).not.toContain('send-telegram-release.sh');
  });
});