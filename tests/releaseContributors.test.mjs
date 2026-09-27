import { describe, expect, it } from 'vitest';
import {
  discoverExternalContributors,
  extractMarkdownAcknowledgements,
  resolvePreviousReleaseTag,
  validateContributorAcknowledgements,
} from '../bin/release/validate-release-contributors.mjs';

const tag = 'v1.2.3';
const sourceSha = 'a'.repeat(40);
const mergeShas = ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)];

const makeGit = ({ unresolvedPullMerge = false } = {}) => (args) => {
  if (args[0] === 'tag') return 'v1.2.2\nv1.2.1';
  if (args[0] === 'rev-parse') return sourceSha;
  if (args[0] === 'rev-list') return mergeShas.join('\n');
  if (args[0] === 'show') {
    const mergeSha = args.at(-1);
    if (unresolvedPullMerge && mergeSha === mergeShas[3]) return 'Merge pull request #999 from fork/topic';
    return mergeSha === mergeShas[3] ? 'Merge branch dev-sync' : `Merge pull request #${mergeShas.indexOf(mergeSha) + 1}`;
  }
  throw new Error(`Unexpected git call: ${args.join(' ')}`);
};

const prFor = ({ mergeSha, number, login, type = 'User' }) => ({
  number,
  merged_at: '2026-09-15T00:00:00Z',
  merge_commit_sha: mergeSha,
  base: {
    ref: 'dev',
    repo: { full_name: 'seakee/CPA-Manager-Plus' },
  },
  user: {
    login,
    type,
    html_url: `https://github.com/${login}`,
  },
});

const makeRequest = ({ unresolved = false } = {}) => async (url) => {
  const mergeSha = url.match(/commits\/([0-9a-f]{40})\/pulls/)?.[1];
  let payload = [];
  if (mergeSha === mergeShas[0]) {
    payload = [prFor({ mergeSha, number: 742, login: 'HuiCheng' })];
  } else if (mergeSha === mergeShas[1]) {
    payload = [prFor({ mergeSha, number: 748, login: 'seakee' })];
  } else if (mergeSha === mergeShas[2]) {
    payload = [prFor({ mergeSha, number: 750, login: 'dependabot[bot]', type: 'Bot' })];
  } else if (mergeSha === mergeShas[3] && unresolved) {
    payload = [];
  }
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
};

const chinese = `# CPA Manager Plus ${tag}

## Acknowledgements

- @HuiCheng - 增加套餐剩余时间排序。
- @camy-x - 保留手动模型价格。

---
`;

const english = `# CPA Manager Plus ${tag}

## Acknowledgements

- @HuiCheng - Added plan-remaining sorting.
- @camy-x - Preserved manual model prices.

---
`;

describe('release contributor discovery', () => {
  it('resolves the latest prior valid release tag', () => {
    expect(resolvePreviousReleaseTag({ tag, git: makeGit() })).toBe('v1.2.2');
  });

  it('collects external dev PR authors and excludes the repository owner and bots', async () => {
    const result = await discoverExternalContributors({
      tag,
      sourceSha,
      repository: 'seakee/CPA-Manager-Plus',
      token: 'test-token',
      git: makeGit(),
      request: makeRequest(),
    });

    expect(result.previousTag).toBe('v1.2.2');
    expect(result.integrationMerges).toEqual(mergeShas);
    expect(result.contributors).toEqual([
      {
        login: 'HuiCheng',
        profileUrl: 'https://github.com/HuiCheng',
        pullNumbers: [742],
      },
    ]);
  });

  it('fails closed when a pull-request merge cannot be mapped to PR metadata', async () => {
    await expect(
      discoverExternalContributors({
        tag,
        sourceSha,
        repository: 'seakee/CPA-Manager-Plus',
        token: 'test-token',
        git: makeGit({ unresolvedPullMerge: true }),
        request: makeRequest({ unresolved: true }),
      })
    ).rejects.toThrow('Unable to resolve pull request metadata');
  });
});

describe('release acknowledgement validation', () => {
  const contributors = [{ login: 'HuiCheng' }, { login: 'camy-x' }];

  it('extracts contributor handles from the formal release notes', () => {
    expect(extractMarkdownAcknowledgements(chinese)).toEqual({
      present: true,
      handles: ['HuiCheng', 'camy-x'],
    });
  });

  it('requires the exact external contributor set in both release notes', () => {
    expect(validateContributorAcknowledgements({ contributors, chinese, english })).toMatchObject({
      contributors: ['HuiCheng', 'camy-x'],
    });

    expect(() =>
      validateContributorAcknowledgements({
        contributors,
        chinese,
        english: english.replace('- @camy-x - Preserved manual model prices.\n', ''),
      })
    ).toThrow('English release notes contributor handles do not match');
  });

  it('rejects acknowledgement sections when there are no external contributors', () => {
    expect(() => validateContributorAcknowledgements({ contributors: [], chinese, english })).toThrow(
      'must omit acknowledgements'
    );

    expect(
      validateContributorAcknowledgements({
        contributors: [],
        chinese: '# Release\n',
        english: '# Release\n',
      })
    ).toMatchObject({ contributors: [] });
  });
});
