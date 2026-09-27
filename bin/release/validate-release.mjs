import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReleaseInfo } from './generate-release-info.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryUrl = 'https://github.com/tcatarina/CPA-Manager-Plus';
const prereleaseIdentifier = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const releaseTagPattern = new RegExp(
  String.raw`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*))?$`
);

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

const expectedLanguageLink = (tag, language) =>
  `${repositoryUrl}/blob/${tag}/docs/release-notes/${tag}-${language}.md`;

const fail = (message) => {
  throw new Error(message);
};

export const parseReleaseTag = (tag) => {
  if (typeof tag !== 'string' || !releaseTagPattern.test(tag)) {
    fail(`Release tag must match v<major>.<minor>.<patch>[-<prerelease>]: ${tag || '<empty>'}`);
  }

  return {
    tag,
    prerelease: releaseTagPattern.exec(tag)?.[4] !== undefined,
  };
};

export const validateReleaseNotes = ({ tag, chinese, english }) => {
  parseReleaseTag(tag);
  if (typeof chinese !== 'string' || chinese.trim() === '') fail('Chinese release notes are empty');
  if (typeof english !== 'string' || english.trim() === '') fail('English release notes are empty');

  const englishLink = expectedLanguageLink(tag, 'en');
  const chineseLink = expectedLanguageLink(tag, 'zh');
  if (!chinese.includes(englishLink)) fail(`Chinese release notes must link to ${englishLink}`);
  if (!english.includes(chineseLink)) fail(`English release notes must link to ${chineseLink}`);
  if (/\]\(\.\/?[^)]*release-notes/.test(chinese) || /\]\(\.\/?[^)]*release-notes/.test(english)) {
    fail('Release note language links must be tag-pinned GitHub blob URLs');
  }

  return {
    chineseCharacters: Array.from(chinese).length,
    englishCharacters: Array.from(english).length,
  };
};

export const validateReleaseContent = ({
  tag,
  readFile = (filePath) => readFileSync(filePath, 'utf8'),
  fileExists = (filePath) => existsSync(filePath),
}) => {
  parseReleaseTag(tag);
  const paths = releasePaths(tag);
  const present = Object.fromEntries(
    Object.entries(paths).map(([key, relativePath]) => [
      key,
      fileExists(path.resolve(repoRoot, relativePath)),
    ])
  );

  const chinese = present.chinese ? readFile(path.resolve(repoRoot, paths.chinese)) : undefined;
  const english = present.english ? readFile(path.resolve(repoRoot, paths.english)) : undefined;
  generateReleaseInfo(tag, '0'.repeat(40), chinese);
  return {
    paths,
    notes:
      chinese && english ? validateReleaseNotes({ tag, chinese, english }) : { skipped: true },
  };
};

const normalizeChangedPath = (filePath) =>
  filePath.replace(/\r$/, '').replaceAll('\\', '/').replace(/^\.\//, '');

const releaseTagFromPath = (filePath) => {
  const normalizedPath = normalizeChangedPath(filePath);
  const noteMatch = /^docs\/release-notes\/(.+)-(?:zh|en)\.md$/.exec(normalizedPath);
  if (noteMatch) return noteMatch[1];
  if (normalizedPath.startsWith('docs/release-notes/')) {
    fail(`Unexpected release content path: ${normalizedPath}`);
  }
  return null;
};

export const validateChangedReleaseContent = ({ changedFiles, readFile, fileExists }) => {
  const tags = [
    ...new Set(
      changedFiles
        .map(releaseTagFromPath)
        .filter((tag) => tag !== null)
        .map((tag) => parseReleaseTag(tag).tag)
    ),
  ].sort();

  return {
    tags,
    releases: tags.map((tag) =>
      validateReleaseContent({
        tag,
        ...(readFile ? { readFile } : {}),
        ...(fileExists ? { fileExists } : {}),
      })
    ),
  };
};

const resolveCommit = (git, ref) => git(['rev-parse', '--verify', `${ref}^{commit}`]);
const tryResolveCommit = (git, ref) => {
  try {
    return resolveCommit(git, ref);
  } catch {
    return null;
  }
};
const resolveTree = (git, ref) => git(['rev-parse', '--verify', `${ref}^{tree}`]);

const commitParents = (git, sha) => {
  const values = git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/);
  if (values.shift() !== sha) fail(`Git did not return the expected commit for ${sha}`);
  return values;
};

const changedNames = (git, base, commit) =>
  git(['diff', '--name-status', '--no-renames', base, commit])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...fileParts] = line.split('\t');
      return { status, path: fileParts.join('\t') };
    });

export const validateReleaseTopology = ({
  tag,
  sha,
  mainRef = 'origin/main',
  devRef = 'origin/dev',
  requireTagRef = true,
  git = runGit,
}) => {
  parseReleaseTag(tag);
  const candidateSha = sha || resolveCommit(git, 'HEAD');
  const mainSha = resolveCommit(git, mainRef);
  const devSha = tryResolveCommit(git, devRef);

  if (requireTagRef && resolveCommit(git, `refs/tags/${tag}`) !== candidateSha) {
    fail(`Tag ${tag} does not point to the candidate release commit ${candidateSha}`);
  }
  if (candidateSha !== mainSha)
    fail(`Candidate ${candidateSha} is not the current ${mainRef} ${mainSha}`);

  const mainParents = commitParents(git, mainSha);
  const mainTree = resolveTree(git, mainSha);

  if (!devSha) {
    return { tag, candidateSha, mainSha, devSha, mainTree, mainParents, changes: [] };
  }

  if (mainParents.length !== 2 || mainParents[1] !== devSha) {
    fail(`Current main must be a promotion merge whose second parent is ${devRef}`);
  }

  const devTree = resolveTree(git, devSha);
  if (mainTree !== devTree) {
    fail(`Current main tree must exactly match the promoted ${devRef} tree`);
  }

  const devParents = commitParents(git, devSha);
  if (devParents.length !== 2) fail(`Current dev ${devSha} must be the release PR merge commit`);

  const expected = releasePaths(tag);
  const expectedFiles = new Set(Object.values(expected));
  const changes = changedNames(git, devParents[0], devSha);
  const changedFiles = new Set(changes.map(({ path: filePath }) => filePath));
  const invalidChanges = changes.filter(
    ({ status, path: filePath }) => status !== 'A' || !expectedFiles.has(filePath)
  );
  const missingChanges = [...expectedFiles].filter((filePath) => !changedFiles.has(filePath));
  if (
    invalidChanges.length > 0 ||
    missingChanges.length > 0 ||
    changes.length !== expectedFiles.size
  ) {
    fail('The current dev tip is not the exact release PR merge for this tag');
  }

  return {
    tag,
    candidateSha,
    mainSha,
    devSha,
    mainTree,
    devTree,
    mainParents,
    devParents,
    changes,
  };
};

const parseArguments = (argv) => {
  const options = { contentOnly: false, dryRun: false, changedContent: false, null: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--content-only') options.contentOnly = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--changed-content') options.changedContent = true;
    else if (argument === '--null') options.null = true;
    else if (argument.startsWith('--')) {
      const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      options[key] = argv[++index];
    } else fail(`Unknown release validation argument: ${argument}`);
  }
  return options;
};

const runCli = () => {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.changedContent) {
      const input = readFileSync(0, 'utf8');
      const changedFiles = input.split(options.null ? '\0' : /\r?\n/).filter(Boolean);
      const content = validateChangedReleaseContent({ changedFiles });
      console.log(JSON.stringify({ ok: true, mode: 'changed-content', ...content }, null, 2));
      return;
    }
    if (options.null) fail('--null requires --changed-content');
    if (!options.tag) fail('--tag is required');
    const content = validateReleaseContent({ tag: options.tag });
    const topology = options.contentOnly
      ? null
      : validateReleaseTopology({
          tag: options.tag,
          sha: options.sha,
          mainRef: options.mainRef || 'origin/main',
          devRef: options.devRef || 'origin/dev',
          requireTagRef: !options.dryRun,
        });
    console.log(
      JSON.stringify(
        {
          ok: true,
          tag: options.tag,
          prerelease: parseReleaseTag(options.tag).prerelease,
          content,
          topology,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      `Release validation failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
};

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) runCli();
