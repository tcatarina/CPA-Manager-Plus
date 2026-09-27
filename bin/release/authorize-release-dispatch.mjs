import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseReleaseTag } from './validate-release.mjs';

const releaseWorkflowPath = '.github/workflows/release.yml';
const releaseWorkflowName = 'Build and Release';
const githubApiVersion = '2022-11-28';

const fail = (message) => {
  throw new Error(message);
};

const isFullSha = (value) => /^[0-9a-f]{40}$/i.test(value || '');
const isPositiveInteger = (value) => /^[1-9][0-9]*$/.test(String(value || ''));

export const validateDryRunRecord = ({ run, releaseTag, releaseSha, repository }) => {
  const expectedTitle = `Build and Release · dry-run · ${releaseTag}`;
  const runAttempt = String(run?.run_attempt ?? '');
  // GitHub may expose the configured `run-name` as `name` in the workflow-run
  // REST payload. Accept only the exact static workflow name or the exact
  // release-specific run title while keeping the rest of the identity strict.
  const validRunName = run?.name === releaseWorkflowName || run?.name === expectedTitle;
  if (
    run?.path !== releaseWorkflowPath ||
    !validRunName ||
    run?.display_title !== expectedTitle ||
    run?.event !== 'workflow_dispatch' ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    run?.head_sha !== releaseSha ||
    run?.head_branch !== 'main' ||
    !isPositiveInteger(runAttempt) ||
    run?.repository?.full_name !== repository ||
    run?.head_repository?.full_name !== repository
  ) {
    fail('The supplied run is not the expected successful dry-run for this release candidate');
  }
  return { runId: run.id, runAttempt: Number(runAttempt) };
};

const createApi = ({ repository, token, fetchImpl }) => async (apiPath, options = {}) => {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}${apiPath}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': githubApiVersion,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (options.allow404 && response.status === 404) return null;
  if (!response.ok) fail(`GitHub API ${options.method || 'GET'} ${apiPath}: HTTP ${response.status}`);
  return response.json();
};

const validateTagRef = ({ ref, releaseTag, releaseSha }) => {
  if (
    ref?.ref !== `refs/tags/${releaseTag}` ||
    ref?.object?.type !== 'commit' ||
    ref?.object?.sha !== releaseSha
  ) {
    fail(`Release tag ${releaseTag} does not point directly to ${releaseSha}`);
  }
};

export const authorizeReleaseDispatch = async ({
  action = 'validate',
  mode,
  releaseTag,
  releaseSha,
  expectedSha = '',
  dryRunId = '',
  confirmPublish = false,
  runAttempt = 1,
  repository,
  token,
  fetchImpl = fetch,
}) => {
  parseReleaseTag(releaseTag);
  if (!['validate', 'create-tag'].includes(action)) fail(`Unsupported release action: ${action}`);
  if (!['dry-run', 'publish', 'tag'].includes(mode)) fail(`Unsupported release mode: ${mode}`);
  if (!isFullSha(releaseSha)) fail('Release SHA must be a full commit SHA');
  if (!isPositiveInteger(runAttempt)) fail('Release workflow attempt must be a positive integer');
  const currentAttempt = Number(runAttempt);
  if (repository !== 'tcatarina/CPA-Manager-Plus') fail(`Unexpected repository: ${repository || '<empty>'}`);
  if (!token) fail('Missing GitHub token');
  if (action === 'create-tag' && mode !== 'publish') {
    fail('Tag creation is allowed only for publish dispatches');
  }

  if (expectedSha && expectedSha !== releaseSha) {
    fail(`Expected SHA ${expectedSha} does not match release SHA ${releaseSha}`);
  }

  const api = createApi({ repository, token, fetchImpl });
  const tagPath = `/git/ref/tags/${encodeURIComponent(releaseTag)}`;
  const existingTag = await api(tagPath, { allow404: true });

  if (mode === 'dry-run') {
    if (existingTag) fail(`Release tag already exists: ${releaseTag}`);
    return { action, mode, tagCreated: false, tagReused: false, dryRunId: null };
  }

  if (mode === 'tag') {
    if (!existingTag) fail(`Tag-triggered release is missing ${releaseTag}`);
    validateTagRef({ ref: existingTag, releaseTag, releaseSha });
    return { action, mode, tagCreated: false, tagReused: true, dryRunId: null };
  }

  if (confirmPublish !== true) fail('Publish dispatch requires explicit confirmation');
  if (!expectedSha || expectedSha !== releaseSha) {
    fail('Publish dispatch requires expected_sha to match the exact main SHA');
  }
  if (!isPositiveInteger(dryRunId)) fail('Publish dispatch requires a successful dry_run_id');

  const dryRun = await api(`/actions/runs/${dryRunId}`);
  const validatedRun = validateDryRunRecord({
    run: dryRun,
    releaseTag,
    releaseSha,
    repository,
  });

  if (existingTag) {
    validateTagRef({ ref: existingTag, releaseTag, releaseSha });
    if (currentAttempt === 1) {
      fail(`Release tag already exists before first publish attempt: ${releaseTag}`);
    }
    return {
      action,
      mode,
      tagCreated: false,
      tagReused: true,
      dryRunId: validatedRun.runId,
      dryRunAttempt: validatedRun.runAttempt,
    };
  }

  if (action === 'validate') {
    return {
      action,
      mode,
      tagCreated: false,
      tagReused: false,
      dryRunId: validatedRun.runId,
      dryRunAttempt: validatedRun.runAttempt,
    };
  }

  const createdTag = await api('/git/refs', {
    method: 'POST',
    body: {
      ref: `refs/tags/${releaseTag}`,
      sha: releaseSha,
    },
  });
  validateTagRef({ ref: createdTag, releaseTag, releaseSha });

  const verifiedTag = await api(tagPath);
  validateTagRef({ ref: verifiedTag, releaseTag, releaseSha });

  return {
    action,
    mode,
    tagCreated: true,
    tagReused: false,
    dryRunId: validatedRun.runId,
    dryRunAttempt: validatedRun.runAttempt,
  };
};

const runCli = async () => {
  try {
    const mode = process.env.RELEASE_MODE || '';
    const result = await authorizeReleaseDispatch({
      action: process.env.RELEASE_ACTION || (mode === 'publish' ? 'create-tag' : 'validate'),
      mode,
      releaseTag: process.env.RELEASE_TAG || '',
      releaseSha: process.env.RELEASE_SHA || '',
      expectedSha: process.env.EXPECTED_SHA || '',
      dryRunId: process.env.DRY_RUN_ID || '',
      confirmPublish: process.env.CONFIRM_PUBLISH === 'true',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
      repository: process.env.GITHUB_REPOSITORY || '',
      token: process.env.GITHUB_TOKEN || '',
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(
      `Release dispatch authorization failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
};

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) await runCli();