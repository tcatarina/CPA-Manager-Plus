export type DashboardVersionReleaseTarget = 'manager' | 'core';

const RELEASE_REPOSITORIES: Record<DashboardVersionReleaseTarget, string> = {
  manager: 'tcatarina/CPA-Manager-Plus',
  core: 'router-for-me/CLIProxyAPI',
};

const prereleaseIdentifier = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const releaseVersionPattern = new RegExp(
  String.raw`^[vV]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*)?$`
);
const gitDescribeVersionPattern = /-\d+-g[0-9a-f]+(?:-dirty)?$/i;

export const normalizeDashboardReleaseTag = (version?: string | null): string => {
  const trimmed = version?.trim() || '';
  if (gitDescribeVersionPattern.test(trimmed) || !releaseVersionPattern.test(trimmed)) return '';
  return `v${trimmed.replace(/^[vV]/, '')}`;
};

export const buildDashboardVersionReleaseURL = (
  target: DashboardVersionReleaseTarget,
  version?: string | null
): string => {
  const tag = normalizeDashboardReleaseTag(version);
  if (!tag) return '';
  return `https://github.com/${RELEASE_REPOSITORIES[target]}/releases/tag/${encodeURIComponent(tag)}`;
};
