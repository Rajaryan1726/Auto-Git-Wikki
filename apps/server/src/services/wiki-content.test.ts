import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPageMarkdown,
  excerptFromChunks,
  extractPathMentions,
  findUnknownPaths,
  formatFileTree,
  mergeSourceRefs,
  parseJsonObject,
  pickManifests,
  pickReadme,
  slugify,
  unlinkPaths,
  validateOutline,
} from './wiki-content.js';

const FILES = [
  'README.md',
  'package.json',
  'apps/server/package.json',
  'apps/server/src/routes/auth.ts',
  'apps/server/src/services/rag.ts',
  'apps/server/src/services/llm.ts',
  'apps/web/src/pages/chat-page.tsx',
  'docker-compose.yml',
];

const page = (slug: string, title: string, extra: Record<string, unknown> = {}) => ({
  slug,
  title,
  parentSlug: null as string | null,
  position: 0,
  purpose: `Explain ${title}.`,
  files: [],
  ...extra,
});

const validPages = () => [
  page('overview', 'Overview', { files: ['README.md'] }),
  page('architecture', 'Architecture', { position: 1 }),
  page('setup-and-run', 'Setup & run', { position: 2, files: ['./docker-compose.yml'] }),
  page('chat', 'Chat & RAG', { position: 3, files: ['apps/server/src/services/rag.ts'] }),
  page('llm', 'LLM providers', {
    parentSlug: 'chat',
    position: 0,
    files: ['apps/server/src/services/llm.ts', 'src/made-up.ts'],
  }),
];

test('slugify makes kebab-case slugs', () => {
  assert.equal(slugify('Setup & Run'), 'setup-and-run');
  assert.equal(slugify('  Chat / RAG pipeline!! '), 'chat-rag-pipeline');
});

test('parseJsonObject tolerates fences and prose', () => {
  assert.deepEqual(parseJsonObject('Here:\n```json\n{"pages":[]}\n```'), { pages: [] });
  assert.throws(() => parseJsonObject('no json here'));
});

test('validateOutline accepts a valid outline, orders the tree and drops unknown files', () => {
  const result = validateOutline({ pages: validPages() }, FILES);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(
    result.outline.pages.map((p) => `${p.parentSlug ?? '-'}/${p.slug}@${p.position}`),
    ['-/overview@0', '-/architecture@1', '-/setup-and-run@2', '-/chat@3', 'chat/llm@0'],
  );
  assert.deepEqual(result.outline.pages[2]!.files, ['docker-compose.yml'], 'normalised ./');
  assert.deepEqual(result.outline.pages[4]!.files, ['apps/server/src/services/llm.ts']);
  assert.deepEqual(result.droppedFiles, ['src/made-up.ts']);
});

test('validateOutline normalises slugs from titles', () => {
  const pages = validPages();
  pages[3]!.slug = '';
  pages[4]!.parentSlug = 'Chat & RAG';
  const result = validateOutline({ pages }, FILES);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.outline.pages[3]!.slug, 'chat-and-rag');
});

test('validateOutline rejects too few / too many pages and bad JSON shapes', () => {
  const few = validateOutline({ pages: validPages().slice(0, 3) }, FILES);
  assert.equal(few.ok, false);
  const many = validateOutline(
    { pages: Array.from({ length: 13 }, (_, i) => page(`p${i}`, `Page ${i}`)) },
    FILES,
  );
  assert.equal(many.ok, false);
  assert.equal(validateOutline({ nope: true }, FILES).ok, false);
});

test('validateOutline reports missing required pages, duplicates and bad parents', () => {
  const pages = validPages();
  pages[1] = page('design', 'Design');
  pages[3]!.slug = 'overview';
  pages[4]!.parentSlug = 'nowhere';
  const result = validateOutline({ pages }, FILES);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => /Duplicate slug "overview"/.test(e)));
  assert.ok(result.errors.some((e) => /unknown parentSlug "nowhere"/.test(e)));
  assert.ok(result.errors.some((e) => /Architecture/.test(e)));
});

test('validateOutline rejects nesting deeper than one level', () => {
  const pages = validPages();
  pages.push(page('deep', 'Deep', { parentSlug: 'llm' }));
  const result = validateOutline({ pages }, FILES);
  assert.equal(result.ok, false);
});

test('formatFileTree collapses deep directories when the list is too long', () => {
  const paths = [
    'README.md',
    ...Array.from({ length: 50 }, (_, i) => `src/components/widgets/w${i}.tsx`),
    'src/index.ts',
  ];
  assert.equal(formatFileTree(paths, 100_000), paths.join('\n'));
  const short = formatFileTree(paths, 200);
  assert.ok(short.length <= 200, short);
  assert.match(short, /src\/components\/(widgets\/)? \(50 files\)/);
  assert.match(short, /README\.md/);
});

test('pickReadme and pickManifests prefer the root', () => {
  assert.equal(pickReadme(['docs/README.md', 'README.md', 'x.ts']), 'README.md');
  assert.equal(pickReadme(['x.ts']), null);
  assert.deepEqual(pickManifests(FILES), [
    'docker-compose.yml',
    'package.json',
    'apps/server/package.json',
  ]);
});

test('excerptFromChunks rebuilds the start of a file within limits', () => {
  const chunks = [
    { file_path: 'a.ts', start_line: 5, end_line: 6, text: 'five\nsix' },
    { file_path: 'a.ts', start_line: 1, end_line: 3, text: 'one\ntwo\nthree' },
    { file_path: 'b.ts', start_line: 1, end_line: 1, text: 'other' },
  ];
  assert.deepEqual(excerptFromChunks('a.ts', chunks, 100, 10_000), {
    path: 'a.ts',
    startLine: 1,
    endLine: 6,
    text: 'one\ntwo\nthree\n\nfive\nsix',
  });
  assert.equal(excerptFromChunks('a.ts', chunks, 2, 10_000)!.endLine, 2);
  assert.equal(excerptFromChunks('a.ts', chunks, 100, 9)!.text, 'one\ntwo');
  assert.equal(excerptFromChunks('zzz.ts', chunks, 10, 10), null);
});

test('extractPathMentions finds paths in inline code and links, not in fenced code', () => {
  const md = [
    'See `apps/server/src/services/rag.ts` and [the route](apps/server/src/routes/auth.ts#L10-L20).',
    'Also `services/llm.ts:42`, `res.json`, `npm run dev`, `text/event-stream`, `@autowiki/shared`.',
    '```ts',
    "import { x } from 'apps/server/src/fake.ts';",
    '`apps/inside/fence.ts`',
    '```',
    'And `apps/server/src/services/missing.ts` and `https://example.com/a.ts`.',
  ].join('\n');
  const mentions = extractPathMentions(md);
  assert.deepEqual(mentions.map((m) => m.path).sort(), [
    'apps/server/src/routes/auth.ts',
    'apps/server/src/services/missing.ts',
    'apps/server/src/services/rag.ts',
    'services/llm.ts',
    'text/event-stream',
  ]);
});

test('findUnknownPaths flags only path claims that match nothing', () => {
  const mentions = extractPathMentions(
    [
      '`apps/server/src/services/rag.ts`', // exact
      '`services/llm.ts`', // suffix
      '`apps/server/src`', // directory
      '`src/routes/`', // directory suffix
      '`text/event-stream`', // not a path claim
      '`owner/repo`', // not a path claim
      '`apps/server/src/services/missing.ts`', // unknown file
      '`apps/server/nope`', // unknown dir under a real top-level dir
      '`lib/thing.py`', // unknown, has an extension
      '[readme](README.md)',
      '[setup](SETUP.md)', // unknown link target
    ].join(' '),
  );
  assert.deepEqual(
    findUnknownPaths(mentions, FILES).map((m) => m.path),
    ['apps/server/src/services/missing.ts', 'apps/server/nope', 'lib/thing.py', 'SETUP.md'],
  );
});

test('unlinkPaths removes backticks and links around bad paths only, outside fences', () => {
  const md = [
    'Use `lib/fake.ts` and `apps/server/src/services/rag.ts`; see [setup](SETUP.md).',
    '```',
    '`lib/fake.ts`',
    '```',
  ].join('\n');
  const bad = findUnknownPaths(extractPathMentions(md), FILES);
  assert.equal(
    unlinkPaths(md, bad),
    [
      'Use lib/fake.ts and `apps/server/src/services/rag.ts`; see setup.',
      '```',
      '`lib/fake.ts`',
      '```',
    ].join('\n'),
  );
});

test('cleanPageMarkdown strips wrapper fences, a leading H1 and a Sources section', () => {
  const md = '```markdown\n# Overview\n\nIntro.\n\n## Parts\nText.\n\n## Sources\n- a.ts\n```';
  assert.equal(cleanPageMarkdown(md), 'Intro.\n\n## Parts\nText.');
});

test('mergeSourceRefs merges overlapping and touching ranges per file', () => {
  assert.deepEqual(
    mergeSourceRefs([
      { path: 'b.ts', startLine: 1, endLine: 5 },
      { path: 'a.ts', startLine: 10, endLine: 20 },
      { path: 'a.ts', startLine: 1, endLine: 9 },
      { path: 'a.ts', startLine: 30, endLine: 40 },
      { path: 'b.ts', startLine: 3, endLine: 4 },
    ]),
    [
      { path: 'a.ts', startLine: 1, endLine: 20 },
      { path: 'a.ts', startLine: 30, endLine: 40 },
      { path: 'b.ts', startLine: 1, endLine: 5 },
    ],
  );
});
