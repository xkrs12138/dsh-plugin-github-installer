/**
 * Type declarations for @deepseek-ai/dsh-plugin-github-installer.
 *
 * The plugin registers one model-facing tool, `github_install_plugin`, and
 * exposes a standalone `normalizeGithubReference` helper for reuse.
 */

import type { Context } from '@deepseek-ai/cordis';

/** Result of normalizing a pasted GitHub reference into an install spec. */
export interface NormalizedReference {
  /** The canonical pnpm install spec, e.g. `github:owner/repo#ref`. */
  spec: string;
  /** True when the spec targets a GitHub repository; false for a raw tarball. */
  github: boolean;
}

/**
 * Normalize a user-pasted GitHub reference into a canonical pnpm install spec.
 * See the implementation in lib/index.js for the accepted forms.
 */
export declare function normalizeGithubReference(raw: string): NormalizedReference;

/** The plugin's Cordis entry point. */
export declare function apply(ctx: Context): void;

/** Loader injection metadata. */
export declare const name: string;
export declare const inject: readonly string[];
