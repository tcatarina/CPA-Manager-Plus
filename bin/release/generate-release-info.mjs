import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repository, parseVersion, nativeAssets, validateInfo } from './update-contract.mjs';

const defaultMetadata = (tag) => ({
  summary: { zh: '发布版本。', en: 'Release build.' },
  update: {
    breaking: false,
    migration_required: false,
    minimum_direct_upgrade_version: null,
    upgrade_guide_url: `${repository}/releases/tag/${tag}`,
  },
  compatibility: { minimum_cpa_version: null },
});

export function generateReleaseInfo(tag, sha, chineseNotes) {
  // One reviewed block in the existing release PR; no second notes source.
  let metadata = defaultMetadata(tag);
  if (chineseNotes) {
    const matches = [...chineseNotes.matchAll(/<!--\s*cpamp-update\s*\n([\s\S]*?)-->/g)];
    if (matches.length !== 1)
      throw new Error('Release notes require exactly one cpamp-update JSON comment');
    metadata = JSON.parse(matches[0][1]);
  }
  return validateInfo(
    {
      schema_version: 1,
      release: { version: tag, stage: parseVersion(tag).stage, source_commit: sha },
      content: {
        summary: metadata.summary,
        notes: Object.fromEntries(
          ['zh', 'en'].map((lang) => [
            lang,
            `${repository}/blob/${tag}/docs/release-notes/${tag}-${lang}.md`,
          ])
        ),
      },
      update: metadata.update,
      distribution: {
        docker: { image: 'tcatarina/cpa-manager-plus', version_tag: tag },
        native: { assets: nativeAssets(tag) },
      },
      compatibility: metadata.compatibility,
    },
    tag
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, out, sourceCommit] = process.argv.slice(2);
  const sha =
    sourceCommit || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const notesPath = `docs/release-notes/${tag}-zh.md`;
  const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : undefined;
  const info = generateReleaseInfo(tag, sha, notes);
  if (out) writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
}
