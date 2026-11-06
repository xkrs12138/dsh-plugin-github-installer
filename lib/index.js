/**
 * github_install_plugin — install a DSH plugin directly from a GitHub repository.
 *
 * This tool is a thin, user-facing convenience layer over the profile's
 * `pluginManager` service (the same service the official `plugin_manager`
 * tool drives). It accepts any GitHub reference the profile installer already
 * understands — a full URL, the `github:owner/repo` shorthand, an SSH address,
 * or a codeload/archive tarball — normalizes it into a pnpm install spec,
 * and hands it to `pluginManager.installBundle`, so installation follows the
 * exact shipped pipeline (GitHub connectivity check, transport selection,
 * pnpm install, bundle reconcile, activation).
 *
 * The value it adds over calling `plugin_manager install_bundle` directly is
 * discovery and validation: it probes the target repository via the GitHub API
 * to confirm the plugin exists, reports its description, and checks that it
 * declares a `dsh.bundle` patch (i.e. is actually a DSH plugin and not just any
 * npm package), before installing. Subdirectory installs (`owner/repo` with a
 * `path=` fragment pointing at a monorepo package) are supported.
 *
 * @module @deepseek-ai/dsh-plugin-github-installer
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'plugin-github-installer';
const inject = ['tools', 'pluginManager'];

/** Git hosts we know how to turn into a normalized pnpm install spec. */
const GIT_HOSTS = new Set(['github.com', 'www.github.com', 'gist.github.com']);

/** Fragments we keep while normalizing: a monorepo subdirectory and a ref. */
const FRAGMENT_KEYS = new Set(['path', 'ref', 'branch', 'tag', 'commit']);

/** Fragments whose value contains slashes must stay raw; GitHub shorthand can't express them. */
const SHORTHAND_BLOCKED = new Set(['path']);

/** pnpm's own git shorthand, e.g. `github:owner/repo#ref`. */
const GIT_SHORTHAND = /^(?:github|gist):/i;
/** An scp-like SSH git address, e.g. `git@github.com:owner/repo.git`. */
const GIT_SCP = /^git@([^:]+):(.+)$/i;
/** A URL that is definitely not a git repo or tarball we can install. */
const HTTP_URL = /^https?:\/\//i;

/**
 * Parse a fragment string (`path=packages/foo&ref=main`) into key/value pairs.
 * Duplicate keys keep the last value; keys we don't recognize are dropped so
 * they never leak into the install spec.
 */
function parseFragment(fragment) {
  const result = {};
  for (const pair of fragment.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = decodeURIComponent(pair.slice(eq + 1));
    if (FRAGMENT_KEYS.has(key) && value !== '') result[key] = value;
  }
  return result;
}

/**
 * Build a fragment string from normalized key/value pairs, in stable order.
 *
 * The `path` value keeps its slashes unescaped: pnpm's git-dependency fragment
 * expresses a monorepo subdirectory as `#path=packages/foo`, and percent-encoding
 * the slash would break resolution. Other values are URI-encoded so a branch
 * name or commit never leaks fragment delimiters.
 */
function buildFragment(fragment) {
  const keys = Object.keys(fragment);
  if (keys.length === 0) return '';
  return '#' + keys.map((key) => {
    const value = key === 'path' ? fragment[key] : encodeURIComponent(fragment[key]);
    return `${key}=${value}`;
  }).join('&');
}

/**
 * Normalize a user-pasted GitHub reference into a canonical pnpm install spec.
 *
 * Accepts, and reduces to a single canonical form:
 *   - `https://github.com/owner/repo`          -> `github:owner/repo`
 *   - `https://github.com/owner/repo.git`      -> `github:owner/repo`
 *   - `https://github.com/owner/repo#path=...` -> `github:owner/repo#path=...`
 *   - `github:owner/repo#ref`                  -> `github:owner/repo#ref`
 *   - `git@github.com:owner/repo.git`          -> `github:owner/repo`
 *   - `owner/repo`                             -> `github:owner/repo`
 *   - a `codeload`/archive tarball URL         -> left as a tarball spec
 *
 * @param raw - the reference as typed.
 * @returns {{ spec: string, github: boolean }} the install spec and whether it
 *   targets a GitHub repository (true) or a raw tarball/other form (false).
 * @throws {Error} for input that cannot be a GitHub plugin reference.
 */
export function normalizeGithubReference(raw) {
  const input = raw.trim();
  if (input === '') throw new Error('the GitHub reference must not be empty');

  // GitHub shorthand already canonical.
  if (GIT_SHORTHAND.test(input)) return { spec: input, github: true };

  // Full GitHub URL.
  if (HTTP_URL.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error(`not a valid URL: ${input}`);
    }
    const host = url.hostname.toLowerCase();
    if (GIT_HOSTS.has(host)) {
      const parts = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
      if (parts.length < 2 || parts[0] === '' || parts[1] === '') {
        throw new Error(`a GitHub URL must point at a repository, like https://github.com/owner/repo (got ${input})`);
      }
      const owner = parts[0];
      const repo = parts[1];
      const fragment = url.hash ? parseFragment(url.hash.slice(1)) : {};
      // A GitHub browse URL like /owner/repo/tree/<ref>/<subdir> or /owner/repo/blob/<ref>/<file>
      // pins a ref and, for tree URLs with a subdirectory, a monorepo path.
      if (parts[2] === 'tree' && parts[3] !== undefined) {
        const ref = parts[3];
        const subdir = parts.slice(4).join('/');
        if (fragment.ref === undefined && fragment.branch === undefined && fragment.tag === undefined && fragment.commit === undefined) {
          fragment.ref = ref;
        }
        if (subdir !== '' && fragment.path === undefined) {
          fragment.path = subdir;
        }
        return { spec: `github:${owner}/${repo}${buildFragment(fragment)}`, github: true };
      }
      if (parts[2] === 'blob' && parts[3] !== undefined && fragment.ref === undefined && fragment.branch === undefined && fragment.tag === undefined && fragment.commit === undefined) {
        fragment.ref = parts[3];
        return { spec: `github:${owner}/${repo}${buildFragment(fragment)}`, github: true };
      }
      if (Object.keys(fragment).some((key) => SHORTHAND_BLOCKED.has(key)) && url.hash) {
        // `github:` shorthand cannot express a `path=` fragment with slashes
        // cleanly; keep the original URL as a hosted-repository spec instead.
        return { spec: input, github: true };
      }
      return { spec: `github:${owner}/${repo}${buildFragment(fragment)}`, github: true };
    }
    // Any other http(s) URL: only a tarball is installable.
    if (/\.(?:tgz|tar\.gz)$/i.test(url.pathname)) {
      return { spec: input, github: false };
    }
    throw new Error('only github.com and gist.github.com repositories, or a .tgz/.tar.gz tarball URL, can be installed');
  }

  // SSH scp-like address.
  const scp = GIT_SCP.exec(input);
  if (scp !== null) {
    const host = scp[1].toLowerCase();
    if (!GIT_HOSTS.has(host)) {
      throw new Error(`only github.com SSH addresses are supported (got ${input})`);
    }
    const path = scp[2].replace(/\.git$/, '');
    const hash = path.indexOf('#');
    if (hash === -1) return { spec: `github:${path}`, github: true };
    return { spec: `github:${path.slice(0, hash)}#${path.slice(hash + 1)}`, github: true };
  }

  // Bare `owner/repo` shorthand.
  if (/^[^/\s]+\/[^/\s]+$/.test(input)) {
    return { spec: `github:${input}`, github: true };
  }

  throw new Error(`cannot interpret "${input}" as a GitHub plugin reference; use a full URL, owner/repo, github:owner/repo, or git@github.com:owner/repo`);
}

/**
 * Fetch repository metadata from the GitHub REST API to confirm the target
 * exists and surface its description to the user.
 *
 * @param owner - repository owner.
 * @param repo - repository name.
 * @param signal - cancellation signal from the tool execution.
 * @returns {{ description: string, homepage: string|null, stargazers: number, htmlUrl: string }} metadata.
 */
async function fetchRepoMeta(owner, repo, signal) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-plugin-github-installer',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 404) {
    throw new Error(`repository ${owner}/${repo} was not found on GitHub (it may be private, or the name is misspelled)`);
  }
  if (response.status === 403) {
    throw new Error(`GitHub API rate limit reached while checking ${owner}/${repo}; wait a moment and retry, or install directly by passing install:false`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} while checking ${owner}/${repo}`);
  }
  const data = await response.json();
  return {
    description: typeof data.description === 'string' ? data.description : '',
    homepage: typeof data.homepage === 'string' ? data.homepage : null,
    stargazers: typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
    htmlUrl: data.html_url,
  };
}

/** Read a repository's package.json from the GitHub API and return its manifest. */
async function fetchPackageManifest(owner, repo, ref, signal) {
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/package.json${refQuery}`;
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'dsh-plugin-github-installer',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Whether a package manifest declares itself a DSH plugin bundle. A bundle is
 * a package whose `dsh.bundle.patch` points at a cordis patch file; without it
 * the profile plugin manager refuses to manage it as a plugin.
 */
function declaresBundle(manifest) {
  return manifest?.dsh?.bundle?.patch !== undefined;
}

/**
 * Split a `github:owner/repo#...` spec into its owner, repo, and fragment pairs.
 * @returns {{ owner: string, repo: string, fragment: Record<string,string> }}.
 */
function splitGithubSpec(spec) {
  const body = spec.replace(/^github:/i, '');
  const hash = body.indexOf('#');
  const path = hash === -1 ? body : body.slice(0, hash);
  const [owner, repo] = path.split('/');
  const fragment = hash === -1 ? {} : parseFragment(body.slice(hash + 1));
  return { owner, repo: repo.replace(/\.git$/, ''), fragment };
}

export function apply(ctx) {
  ctx.inject(['pluginManager'], (scope) => {
    registerTool(scope);
  });
}

function registerTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'github_install_plugin',
    description:
      'Install a DSH plugin directly from a GitHub repository. Accept a full GitHub URL (https://github.com/owner/repo), the github:owner/repo shorthand, an SSH address (git@github.com:owner/repo), a bare owner/repo, or a .tgz/.tar.gz tarball URL. A #path=packages/foo fragment installs a monorepo subdirectory and #ref=.../#commit=... pins a branch, tag, or commit. By default the tool verifies the repository exists, reads its description, and confirms it declares a DSH bundle before installing; pass inspect:false to skip the API checks and install immediately. Installation requires the same danger-full-access permission as plugin_manager install_bundle, and runs any allowed build scripts the package declares. Live profiles apply changes immediately; a result that is not applied carries nextStep telling what to do next.',
    parameters: {
      repo: { type: 'string', required: true, description: 'The GitHub repository reference: full URL, github:owner/repo, git@github.com:owner/repo, owner/repo, or a tarball URL. Add #path=subdir for a monorepo package or #ref=branch/tag/commit to pin a version.' },
      inspect: { type: 'boolean', description: 'Whether to query the GitHub API first to verify the repo exists, show its description, and check it declares a DSH bundle. Defaults to true; set false to skip checks and install directly.' },
      enabled: { type: 'boolean', description: 'Whether to activate the installed bundle in the profile. Defaults to true.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const { spec, github } = normalizeGithubReference(args.repo);

      // Inspect the target before installing, unless the caller opted out.
      let inspection;
      if (args.inspect !== false && github) {
        const { owner, repo, fragment } = splitGithubSpec(spec);
        const meta = await fetchRepoMeta(owner, repo, exec.signal);
        const manifest = await fetchPackageManifest(owner, repo, fragment.ref ?? fragment.branch ?? fragment.tag ?? fragment.commit, exec.signal);
        const isBundle = manifest === null ? null : declaresBundle(manifest);
        inspection = {
          owner,
          repo,
          description: meta.description,
          homepage: meta.homepage,
          stargazers: meta.stargazers,
          htmlUrl: meta.htmlUrl,
          declaresBundle: isBundle,
        };
        if (isBundle === false) {
          return JSON.stringify({
            installed: false,
            reason: 'not-a-dsh-plugin',
            message: `${owner}/${repo} exists but its package.json declares no dsh.bundle.patch, so it is not a DSH plugin and cannot be managed by the plugin manager. If you are sure it is a plugin, retry with inspect:false to install it anyway.`,
            inspection,
          });
        }
      }

      // Hand the normalized spec to the shared profile plugin manager. This is
      // the exact pipeline the official plugin_manager tool uses, so a git URL,
      // shorthand, or tarball is parsed, connectivity-checked, and installed
      // identically.
      const manager = ctx.pluginManager;
      const result = await manager.installBundle(spec, {
        ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      });

      const summary = {
        spec,
        github,
        ...(inspection === undefined ? {} : { inspection }),
        ...result,
      };
      return JSON.stringify(summary);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Install plugin from GitHub',
      kind: 'other',
      rawInput: { repo: args.repo },
    }),
  }));
}

export { name, inject };
