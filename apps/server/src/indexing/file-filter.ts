/** Which repository files are worth indexing. Pure; unit tested. */

export type TreeEntry = { path: string; type: string; size?: number; sha: string };
export type IndexableFile = { path: string; size: number; sha: string };

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILES = 5000;

export type SkipReason =
  | 'excluded_dir'
  | 'lockfile'
  | 'secret'
  | 'minified_or_generated'
  | 'unsupported_type'
  | 'too_large'
  | 'empty';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'site-packages',
  '.tox',
  '.gradle',
  '.idea',
  'Pods',
  'DerivedData',
  '.terraform',
  'storybook-static',
]);

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'Podfile.lock',
  'packages.lock.json',
  'flake.lock',
]);

const TEXT_EXTENSIONS = new Set([
  // code (parsed with tree-sitter where a grammar exists)
  'ts',
  'mts',
  'cts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'py',
  'pyi',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'rb',
  'cs',
  'php',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'hxx',
  'swift',
  'm',
  'mm',
  'dart',
  'lua',
  'r',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'cljs',
  'elm',
  'ml',
  'zig',
  'sol',
  'vue',
  'svelte',
  'astro',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'sql',
  'graphql',
  'gql',
  'proto',
  // markup / docs / config
  'md',
  'mdx',
  'rst',
  'txt',
  'adoc',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'gradle',
  'tf',
  'hcl',
  'cmake',
  'prisma',
]);

/** Extension-less files that are still useful context. */
const TEXT_FILENAMES = new Set([
  'Dockerfile',
  'Makefile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Justfile',
  'README',
  'CONTRIBUTING',
  'CHANGELOG',
]);

const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

/** Committed env templates hold placeholders, not secrets, and document setup. */
const ENV_TEMPLATES = /^\.env\.(example|sample|template|dist)$/i;

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/i,
  /[-.]bundle\.js$/i,
  /\.map$/i,
  /\.(pb|pb\.gw)\.go$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.g\.dart$/i,
  /\.generated\.\w+$/i,
];

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

/** Returns why a path should be skipped, or null if it is indexable. */
export function skipReason(entry: { path: string; size?: number }): SkipReason | null {
  const segments = entry.path.split('/');
  if (segments.slice(0, -1).some((s) => EXCLUDED_DIRS.has(s))) return 'excluded_dir';

  const name = basename(entry.path);
  if (LOCKFILES.has(name)) return 'lockfile';
  if (SECRET_PATTERNS.some((re) => re.test(name)) && !ENV_TEMPLATES.test(name)) return 'secret';
  if (GENERATED_PATTERNS.some((re) => re.test(name))) return 'minified_or_generated';

  const ext = extension(name);
  const known =
    ENV_TEMPLATES.test(name) || (ext ? TEXT_EXTENSIONS.has(ext) : TEXT_FILENAMES.has(name));
  if (!known && !TEXT_FILENAMES.has(name.split('.')[0] ?? '')) return 'unsupported_type';

  if (entry.size !== undefined) {
    if (entry.size === 0) return 'empty';
    if (entry.size > MAX_FILE_BYTES) return 'too_large';
  }
  return null;
}

export type FilterResult = {
  files: IndexableFile[];
  skipped: Partial<Record<SkipReason, number>>;
  /** True when more than MAX_FILES files qualified and the rest were dropped. */
  truncated: boolean;
};

/** Keeps indexable blobs from a git tree, sorted by path, capped at MAX_FILES. */
export function filterRepoFiles(entries: TreeEntry[], maxFiles = MAX_FILES): FilterResult {
  const skipped: Partial<Record<SkipReason, number>> = {};
  const files: IndexableFile[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    const reason = skipReason(entry);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    files.push({ path: entry.path, size: entry.size ?? 0, sha: entry.sha });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.slice(0, maxFiles), skipped, truncated: files.length > maxFiles };
}

/** Content-level check after download: binary or minified files are skipped. */
export function looksLikeBinaryOrMinified(text: string): boolean {
  if (text.includes('\u0000')) return true;
  const lines = text.split('\n');
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0);
  return longest > 5000 || (lines.length > 0 && text.length / lines.length > 400);
}
