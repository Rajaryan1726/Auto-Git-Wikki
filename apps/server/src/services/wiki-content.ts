/**
 * Pure wiki helpers (no I/O, unit-tested): outline validation, prompts, file-tree and excerpt
 * formatting, and the hallucination check for file paths. Orchestration: services/wiki.ts.
 */
import { z } from 'zod';
import type { SourceRef } from '../db/schema.js';
import { UNTRUSTED_CONTEXT_RULES, formatContext, type ContextBlock } from './rag-context.js';
import type { FileChunk } from './qdrant.js';

export const WIKI_MIN_PAGES = 5;
export const WIKI_MAX_PAGES = 12;
const MAX_FILES_PER_PAGE = 8;

// ---------------------------------------------------------------- outline

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

const rawOutlineSchema = z.object({
  pages: z
    .array(
      z.object({
        slug: z.string().default(''),
        title: z.string().trim().min(1).max(100),
        parentSlug: z.string().nullish(),
        position: z.number().int().optional(),
        purpose: z.string().trim().min(1).max(800),
        files: z.array(z.string()).default([]),
      }),
    )
    .min(WIKI_MIN_PAGES)
    .max(WIKI_MAX_PAGES),
});

export type OutlinePage = {
  slug: string;
  title: string;
  parentSlug: string | null;
  position: number;
  purpose: string;
  files: string[];
};
export type WikiOutline = { pages: OutlinePage[] };

/** The three pages every wiki must have, recognised by slug or title. */
export const REQUIRED_PAGES = [
  { name: 'Overview', test: /overview|introduction/i },
  { name: 'Architecture', test: /architecture/i },
  { name: 'Setup & run', test: /setup|set up|install|getting[\s-]started|running|how to run/i },
] as const;

/** Normalises a model-written path to the repo-relative form used in the index. */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** First `{ … }` object in a model reply (tolerates code fences and surrounding prose). */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The reply contains no JSON object.');
  return JSON.parse(text.slice(start, end + 1));
}

export type OutlineResult =
  { ok: true; outline: WikiOutline; droppedFiles: string[] } | { ok: false; errors: string[] };

/**
 * Validates a model-written outline: shape (zod), 5–12 pages, unique slugs, parents that
 * exist and are top-level, and the required Overview / Architecture / Setup pages. Paths in
 * `files` that are not in the indexed file list are dropped (and reported), not fatal.
 */
export function validateOutline(raw: unknown, indexedFiles: string[]): OutlineResult {
  const parsed = rawOutlineSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`),
    };
  }
  const known = new Set(indexedFiles);
  const droppedFiles: string[] = [];
  const pages = parsed.data.pages.map((p, i) => {
    const files: string[] = [];
    for (const f of p.files) {
      const path = normalizePath(f);
      if (known.has(path)) {
        if (!files.includes(path) && files.length < MAX_FILES_PER_PAGE) files.push(path);
      } else droppedFiles.push(f);
    }
    return {
      slug: slugify(p.slug || p.title) || `page-${i + 1}`,
      title: p.title,
      parentSlug: p.parentSlug ? slugify(p.parentSlug) || null : null,
      position: p.position ?? i,
      purpose: p.purpose,
      files,
      index: i,
    };
  });

  const errors: string[] = [];
  const bySlug = new Map<string, (typeof pages)[number]>();
  for (const p of pages) {
    if (bySlug.has(p.slug)) errors.push(`Duplicate slug "${p.slug}".`);
    bySlug.set(p.slug, p);
  }
  for (const p of pages) {
    if (!p.parentSlug) continue;
    const parent = bySlug.get(p.parentSlug);
    if (p.parentSlug === p.slug) errors.push(`Page "${p.slug}" cannot be its own parent.`);
    else if (!parent) errors.push(`Page "${p.slug}" has unknown parentSlug "${p.parentSlug}".`);
    else if (parent.parentSlug) {
      errors.push(`Page "${p.slug}" is nested two levels deep; parents must be top-level pages.`);
    }
  }
  for (const req of REQUIRED_PAGES) {
    if (!pages.some((p) => req.test.test(p.slug) || req.test.test(p.title))) {
      errors.push(`Missing the required "${req.name}" page.`);
    }
  }
  if (errors.length) return { ok: false, errors };

  return { ok: true, outline: { pages: orderPages(pages) }, droppedFiles };
}

/**
 * Flat tree order: top-level pages by position, each followed by its children by position.
 * Positions are renumbered 0..n per parent.
 */
export function orderPages<T extends Omit<OutlinePage, never> & { index?: number }>(
  pages: T[],
): OutlinePage[] {
  const sort = (list: T[]) =>
    [...list].sort((a, b) => a.position - b.position || (a.index ?? 0) - (b.index ?? 0));
  const out: OutlinePage[] = [];
  const strip = (p: T, position: number): OutlinePage => ({
    slug: p.slug,
    title: p.title,
    parentSlug: p.parentSlug,
    position,
    purpose: p.purpose,
    files: p.files,
  });
  sort(pages.filter((p) => !p.parentSlug)).forEach((top, i) => {
    out.push(strip(top, i));
    sort(pages.filter((p) => p.parentSlug === top.slug)).forEach((child, j) =>
      out.push(strip(child, j)),
    );
  });
  return out;
}

// ---------------------------------------------------------------- inputs

/**
 * The file list for a prompt. If it is too long, deep directories are collapsed into
 * "dir/ (N files)" lines, shallower and shallower until it fits.
 */
export function formatFileTree(paths: string[], maxChars: number): string {
  const full = paths.join('\n');
  if (full.length <= maxChars) return full;
  const maxDepth = Math.max(...paths.map((p) => p.split('/').length));
  for (let depth = maxDepth - 1; depth >= 1; depth--) {
    const lines: string[] = [];
    const counts = new Map<string, number>();
    for (const p of paths) {
      const parts = p.split('/');
      if (parts.length <= depth) {
        lines.push(p);
        continue;
      }
      const dir = `${parts.slice(0, depth).join('/')}/`;
      if (!counts.has(dir)) lines.push(dir);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    const text = lines.map((l) => (counts.has(l) ? `${l} (${counts.get(l)} files)` : l)).join('\n');
    if (text.length <= maxChars) return text;
    if (depth === 1) {
      const cut = text.slice(0, maxChars);
      const kept = cut.slice(0, cut.lastIndexOf('\n'));
      const more = lines.length - kept.split('\n').length;
      return `${kept}\n… (${more} more entries)`;
    }
  }
  return full.slice(0, maxChars);
}

/** The root README (or the shallowest one). */
export function pickReadme(paths: string[]): string | null {
  const readmes = paths.filter((p) => /(^|\/)readme(\.[a-z]+)?$/i.test(p));
  readmes.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return readmes[0] ?? null;
}

const MANIFEST =
  /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|docker-compose\.ya?ml|compose\.ya?ml|Dockerfile|Makefile)$/;

/** Dependency / build manifests, shallowest first. */
export function pickManifests(paths: string[], max = 8): string[] {
  return paths
    .filter((p) => MANIFEST.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, max);
}

export type Excerpt = { path: string; startLine: number; endLine: number; text: string };

/**
 * Rebuilds the start of a file from its (non-overlapping) chunks: lines from the first
 * chunk on, gaps left empty, cut at `maxLines` / `maxChars` on a line boundary.
 */
export function excerptFromChunks(
  path: string,
  chunks: FileChunk[],
  maxLines: number,
  maxChars: number,
): Excerpt | null {
  const own = chunks
    .filter((c) => c.file_path === path)
    .sort((a, b) => a.start_line - b.start_line);
  if (own.length === 0) return null;
  const lines = new Map<number, string>();
  for (const c of own) c.text.split('\n').forEach((l, i) => lines.set(c.start_line + i, l));
  const start = own[0]!.start_line;
  const last = Math.max(...own.map((c) => c.end_line));
  const out: string[] = [];
  let chars = 0;
  let end = start - 1;
  for (let n = start; n <= last && out.length < maxLines; n++) {
    const line = lines.get(n) ?? '';
    if (chars + line.length + 1 > maxChars && out.length > 0) break;
    out.push(line);
    chars += line.length + 1;
    end = n;
  }
  return { path, startLine: start, endLine: end, text: out.join('\n') };
}

function fenced(text: string, lang = ''): string {
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${text}\n${fence}`;
}

// ---------------------------------------------------------------- prompts

export const OUTLINE_SYSTEM_PROMPT = [
  'You plan a developer wiki for one code repository. You get its file list, README and manifest files.',
  '',
  'Output ONLY a JSON object, no prose:',
  '{"pages":[{"slug":"overview","title":"Overview","parentSlug":null,"position":0,"purpose":"…","files":["README.md"]}]}',
  '',
  'Rules:',
  `- ${WIKI_MIN_PAGES}–${WIKI_MAX_PAGES} pages in total. Fewer pages for small repositories.`,
  '- Always include: "Overview" (slug overview), "Architecture" (slug architecture) and "Setup & run" (slug setup-and-run).',
  '- The other pages cover the key modules or features of THIS repository, derived from the file list. No generic pages (license, contributing, FAQ) and nothing the repository does not contain.',
  '- slug: unique, kebab-case. parentSlug: null for a top-level page, or the slug of a top-level page (at most one level of nesting).',
  '- position: order among pages with the same parent, starting at 0.',
  '- purpose: 1–2 sentences on what the page must explain to a developer new to the repository.',
  '- files: 1–8 of the most relevant paths for the page, copied exactly from the file list.',
  '',
  ...UNTRUSTED_CONTEXT_RULES,
].join('\n');

export function outlineUserTurn(input: {
  repoFullName: string;
  description: string | null;
  fileTree: string;
  readme: Excerpt | null;
  manifests: Excerpt[];
}): string {
  const parts = [
    `Repository: ${input.repoFullName}`,
    input.description ? `Description: ${input.description}` : null,
    '',
    '<context>',
    'File list (indexed files):',
    input.fileTree,
    '',
    input.readme
      ? `README (${input.readme.path}, truncated):\n${fenced(input.readme.text, 'markdown')}`
      : 'README: none',
    '',
    ...input.manifests.map((m) => `Manifest ${m.path}:\n${fenced(m.text)}`),
    '</context>',
    '',
    'Plan the wiki now. Output only the JSON object.',
  ];
  return parts.filter((p) => p !== null).join('\n');
}

export function outlineRetryTurn(errors: string[]): string {
  return [
    'That outline is invalid:',
    ...errors.slice(0, 20).map((e) => `- ${e}`),
    '',
    'Fix these problems and output the complete corrected JSON object only.',
  ].join('\n');
}

export function pageSystemPrompt(repoFullName: string, commitSha: string): string {
  return [
    `You write one page of a developer wiki for the GitHub repository ${repoFullName} (commit ${commitSha.slice(0, 7)}).`,
    '',
    'Rules:',
    '- Audience: a developer who is new to this repository. Explain what this part does, how it works, how the pieces connect and where to look in the code.',
    '- Base every statement on the provided context (code blocks, excerpts) and the file list. Never invent features, files, functions, commands, settings or environment variables.',
    '- Refer to real file paths exactly as they appear in the file list (full path from the repository root, in backticks) and to real symbol names.',
    '- Include a few short code snippets (at most about 15 lines each) copied exactly from the context, in fenced code blocks with a language tag.',
    '- If the context does not cover part of the page purpose, say briefly what is not covered instead of guessing.',
    '- Format: GitHub-flavoured Markdown. Start with a 1–3 sentence summary paragraph. Do not repeat the page title as a heading (it is shown separately). Use ## and ### headings; tables are fine.',
    '- Output only the page. No citation markers like [1], no "Sources" or "References" section, no links to other wiki pages, no closing remarks or offers.',
    '',
    ...UNTRUSTED_CONTEXT_RULES,
  ].join('\n');
}

export function pageUserTurn(input: {
  page: OutlinePage;
  outline: WikiOutline;
  fileTree: string;
  blocks: ContextBlock[];
  excerpts: Excerpt[];
}): string {
  const others = input.outline.pages
    .filter((p) => p.slug !== input.page.slug)
    .map((p) => `- ${p.title}: ${p.purpose}`)
    .join('\n');
  return [
    `Page to write: "${input.page.title}"`,
    `Purpose: ${input.page.purpose}`,
    input.page.files.length ? `Key files: ${input.page.files.join(', ')}` : null,
    '',
    'Other pages of this wiki (covered elsewhere; mention them only briefly if at all):',
    others,
    '',
    '<context>',
    'File list (the only paths that exist):',
    input.fileTree,
    '',
    'Relevant code:',
    formatContext(input.blocks),
    '',
    input.excerpts.length ? 'Excerpts of the key files:' : null,
    ...input.excerpts.map(
      (e) => `${e.path} (lines ${e.startLine}-${e.endLine})\n${fenced(e.text)}`,
    ),
    '</context>',
    '',
    `Write the "${input.page.title}" page now.`,
  ]
    .filter((p) => p !== null)
    .join('\n');
}

export function badPathsRetryTurn(badPaths: string[]): string {
  return [
    'These file paths in your page do not exist in the repository:',
    ...badPaths.map((p) => `- ${p}`),
    '',
    'Rewrite the complete page. Fix each path to a real one from the file list, or remove the reference. Output only the page markdown.',
  ].join('\n');
}

/** Strips wrapper fences, a leading H1 and a trailing Sources/References section. */
export function cleanPageMarkdown(md: string): string {
  let out = md.trim();
  const wrapped = /^```(?:markdown|md)?\n([\s\S]*)\n```$/i.exec(out);
  if (wrapped) out = wrapped[1]!.trim();
  out = out.replace(/^#\s+[^\n]+\n+/, '');
  out = out.replace(/\n#{1,3}\s*(sources|references)\s*\n[\s\S]*$/i, '');
  return out.trim();
}

// ---------------------------------------------------------------- hallucination check

export type PathMention = { raw: string; path: string; inLink: boolean };

const FENCE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g;

/** Applies `fn` to the parts of the markdown outside fenced code blocks. */
function outsideFences(md: string, fn: (text: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of md.matchAll(FENCE)) {
    out += fn(md.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  return out + fn(md.slice(last));
}

/** A backtick / link target that could be a file path, normalised; null if it cannot be. */
function asPathCandidate(raw: string, inLink: boolean): string | null {
  let c = raw.trim().replace(/^["']|["']$/g, '');
  if (!c || /\s/.test(c)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(c) || c.startsWith('#')) return null; // URLs, mailto:, anchors
  c = c
    .replace(/#L\d+(-L?\d+)?$/i, '')
    .replace(/:\d+(-\d+)?$/, '')
    .replace(/^\.\//, '');
  if (/^(\.\.\/|\/|~|@|\$|-)/.test(c)) return null; // relative-up, absolute, scoped pkgs, flags
  c = c.replace(/\/+$/, '');
  if (!/^[\w.\-/[\]()+]+$/.test(c)) return null; // globs, code expressions, placeholders
  if (!c.includes('/') && !inLink) return null; // bare names like `res.json` are too ambiguous
  return c;
}

/** File-path-like mentions in inline code and link targets (fenced code is ignored). */
export function extractPathMentions(md: string): PathMention[] {
  const found = new Map<string, PathMention>();
  outsideFences(md, (text) => {
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const path = asPathCandidate(m[1]!, false);
      if (path && !found.has(m[1]!)) found.set(m[1]!, { raw: m[1]!, path, inLink: false });
    }
    for (const m of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const path = asPathCandidate(m[1]!, true);
      if (path && !found.has(m[1]!)) found.set(m[1]!, { raw: m[1]!, path, inLink: true });
    }
    return text;
  });
  return [...found.values()];
}

/**
 * Mentions that claim to be repository paths but match no indexed file or directory.
 * A mention matches exactly, as a suffix of an indexed path (`services/rag.ts`), or as a
 * directory. Slash-separated values that do not look like paths (`text/event-stream`,
 * `owner/repo`) are ignored unless they have a file extension or start at a top-level
 * directory of the repository.
 */
export function findUnknownPaths(mentions: PathMention[], indexedFiles: string[]): PathMention[] {
  const files = new Set(indexedFiles);
  const dirs = new Set<string>();
  const topLevel = new Set<string>();
  for (const f of indexedFiles) {
    const parts = f.split('/');
    topLevel.add(parts[0]!);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const endsWith = (set: Iterable<string>, p: string) => {
    for (const x of set) if (x.endsWith(`/${p}`)) return true;
    return false;
  };
  return mentions.filter(({ path, inLink }) => {
    if (files.has(path) || dirs.has(path) || endsWith(files, path) || endsWith(dirs, path)) {
      return false;
    }
    const last = path.split('/').pop() ?? '';
    const hasExtension = /^[^.].*\.[A-Za-z0-9]{1,10}$/.test(last);
    return hasExtension || topLevel.has(path.split('/')[0]!) || inLink;
  });
}

/** Removes backticks / links around the given mentions (outside fenced code). */
export function unlinkPaths(md: string, bad: PathMention[]): string {
  if (bad.length === 0) return md;
  const raws = new Set(bad.map((b) => b.raw));
  return outsideFences(md, (text) =>
    text
      .replace(
        /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (all, label: string, target: string) => (raws.has(target) ? label : all),
      )
      .replace(/`([^`\n]+)`/g, (all, inner: string) => (raws.has(inner) ? inner : all)),
  );
}

// ---------------------------------------------------------------- sources

/** Sorted, de-duplicated source ranges (overlapping / touching ranges of a file merged). */
export function mergeSourceRefs(refs: SourceRef[]): SourceRef[] {
  const sorted = [...refs].sort(
    (a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine,
  );
  const out: SourceRef[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.path === r.path && r.startLine <= prev.endLine + 1) {
      prev.endLine = Math.max(prev.endLine, r.endLine);
    } else out.push({ ...r });
  }
  return out;
}
