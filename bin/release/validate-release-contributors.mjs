import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseTag } from './validate-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const githubApiVersion = '2022-11-28';
const githubLoginPattern = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';

const fail = (message) => {
  throw new Error(message);
};

const runGit = (args) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const releasePaths = (tag) => ({
  chinese: `docs/release-notes/${tag}-zh.md`,
  english: `docs/release-notes/${tag}-en.md`,
});

const parseArguments = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail(`Unknown argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    options[key] = argv[++index];
  }
  return options;
};

const validReleaseTags = (git) =>
  git(['tag', '--list', 'v*', '--sort=-v:refname'])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((tag) => {
      try {
        parseReleaseTag(tag);
        return true;
      } catch {
        return false;
      }
    });

export const resolvePreviousReleaseTag = ({ tag, git = runGit }) => {
  parseReleaseTag(tag);
  const previousTag = validReleaseTags(git).find((candidate) => candidate !== tag);
  if (!previousTag) fail(`No previous release tag is available before ${tag}`);
  return previousTag;
};

const githubRequest = async ({ url, token, request = fetch }) => {
  const response = await request(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': githubApiVersion,
    },
  });
  if (!response.ok) {
    fail(`GitHub API request failed with HTTP ${response.status}: ${url}`);
  }
  return response.json();
};

export const discoverExternalContributors = async ({
  tag,
  sourceSha,
  repository,
  token,
  git = runGit,
  request = fetch,
}) => {
  parseReleaseTag(tag);
  if (!/^[0-9a-f]{40}$/i.test(sourceSha || '')) fail('sourceSha must be a full commit SHA');
  if (!/^[^/]+\/[^/]+$/.test(repository || '')) fail('repository must be owner/name');
  if (!token) fail('A GitHub token is required to resolve release contributors');

  const resolvedSourceSha = git(['rev-parse', '--verify', `${sourceSha}^{commit}`]);
  if (resolvedSourceSha !== sourceSha) {
    fail(`Release source SHA changed while resolving contributors: ${sourceSha} -> ${resolvedSourceSha}`);
  }

  const previousTag = resolvePreviousReleaseTag({ tag, git });
  const mergeOutput = git([
    'rev-list',
    '--reverse',
    '--first-parent',
    '--merges',
    `${previousTag}..${sourceSha}`,
  ]);
  const integrationMerges = mergeOutput ? mergeOutput.split(/\r?\n/).filter(Boolean) : [];
  const owner = repository.split('/')[0].toLowerCase();
  const contributors = new Map();

  for (const mergeSha of integrationMerges) {
    const subject = git(['show', '-s', '--format=%s', mergeSha]);
    const pulls = await githubRequest({
      url: `https://api.github.com/repos/${repository}/commits/${mergeSha}/pulls?per_page=100`,
      token,
      request,
    });
    if (!Array.isArray(pulls)) fail(`GitHub returned invalid PR metadata for merge ${mergeSha}`);

    const matches = pulls.filter(
      (pull) =>
        pull?.merged_at &&
        pull?.merge_commit_sha === mergeSha &&
        pull?.base?.ref === 'dev' &&
        pull?.base?.repo?.full_name === repository
    );

    if (matches.length > 1) {
      fail(`Merge ${mergeSha} maps to multiple dev pull requests`);
    }
    if (matches.length === 0) {
      if (/^Merge pull request #\d+\b/.test(subject)) {
        fail(`Unable to resolve pull request metadata for integration merge ${mergeSha}`);
      }
      continue;
    }

    const pull = matches[0];
    const login = pull?.user?.login;
    const userType = pull?.user?.type;
    if (!login) fail(`Pull request #${pull.number} has no author login`);
    if (login.toLowerCase() === owner || userType === 'Bot' || login.endsWith('[bot]')) continue;

    if (!contributors.has(login)) {
      contributors.set(login, {
        login,
        profileUrl: pull?.user?.html_url || `https://github.com/${login}`,
        pullNumbers: [],
      });
    }
    contributors.get(login).pullNumbers.push(pull.number);
  }

  return {
    previousTag,
    integrationMerges,
    contributors: [...contributors.values()],
  };
};

export const extractMarkdownAcknowledgements = (body) => {
  const lines = String(body || '').split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === '## Acknowledgements');
  if (headingIndex === -1) return { present: false, handles: [] };

  const sectionLines = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line) || /^---\s*$/.test(line)) break;
    sectionLines.push(line);
  }
  const handles = [
    ...sectionLines.join('\n').matchAll(new RegExp(`@(${githubLoginPattern})`, 'g')),
  ].map((match) => match[1]);
  return { present: true, handles };
};

const validateHandleSet = ({ context, expected, actual, present }) => {
  if (actual.length !== new Set(actual).size) fail(`${context} contains duplicate contributor handles`);
  if (expected.length === 0) {
    if (present || actual.length > 0) fail(`${context} must omit acknowledgements when there are no external contributors`);
    return;
  }
  if (!present) fail(`${context} is missing the acknowledgements section`);

  const missing = expected.filter((login) => !actual.includes(login));
  const extra = actual.filter((login) => !expected.includes(login));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${context} contributor handles do not match the release: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`
    );
  }
};

export const validateContributorAcknowledgements = ({
  contributors,
  chinese,
  english,
}) => {
  const expected = contributors.map(({ login }) => login);
  if (expected.length !== new Set(expected).size) fail('Contributor discovery returned duplicate logins');

  const chineseAcknowledgements = extractMarkdownAcknowledgements(chinese);
  const englishAcknowledgements = extractMarkdownAcknowledgements(english);

  validateHandleSet({
    context: 'Chinese release notes',
    expected,
    actual: chineseAcknowledgements.handles,
    present: chineseAcknowledgements.present,
  });
  validateHandleSet({
    context: 'English release notes',
    expected,
    actual: englishAcknowledgements.handles,
    present: englishAcknowledgements.present,
  });

  return {
    contributors: expected,
    chinese: chineseAcknowledgements,
    english: englishAcknowledgements,
  };
};

const runCli = async () => {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options.tag) fail('--tag is required');
    if (!options.sourceSha) fail('--source-sha is required');

    const repository = process.env.GITHUB_REPOSITORY || '';
    const token = process.env.GITHUB_TOKEN || '';
    const discovery = await discoverExternalContributors({
      tag: options.tag,
      sourceSha: options.sourceSha,
      repository,
      token,
    });
    const paths = releasePaths(options.tag);
    const acknowledgement = validateContributorAcknowledgements({
      contributors: discovery.contributors,
      chinese: readFileSync(path.resolve(repoRoot, paths.chinese), 'utf8'),
      english: readFileSync(path.resolve(repoRoot, paths.english), 'utf8'),
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          tag: options.tag,
          sourceSha: options.sourceSha,
          previousTag: discovery.previousTag,
          integrationMerges: discovery.integrationMerges,
          contributors: discovery.contributors,
          acknowledgement,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      `Release contributor validation failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
};

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) await runCli();
