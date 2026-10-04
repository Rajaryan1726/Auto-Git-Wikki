import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHUNK_LINES, chunkFile, type Chunk } from './chunker.js';
import {
  MAX_FILE_BYTES,
  filterRepoFiles,
  looksLikeBinaryOrMinified,
  skipReason,
} from './file-filter.js';
import { POINT_ID_NAMESPACE, chunkPointId, uuidV5 } from './point-id.js';

// ---------- file filter ----------

test('skipReason keeps source, docs and config files', () => {
  for (const path of [
    'src/index.ts',
    'apps/web/src/App.tsx',
    'lib/util.py',
    'cmd/server/main.go',
    'README.md',
    'docs/guide.mdx',
    'package.json',
    'Dockerfile',
    'Makefile',
    '.github/workflows/ci.yml',
    'src/main.rs',
    'include/foo.h',
    '.env.example',
    'config/.env.sample',
  ]) {
    assert.equal(skipReason({ path, size: 100 }), null, path);
  }
});

test('skipReason excludes vendored dirs, lockfiles, secrets, generated and binaries', () => {
  const cases: [string, string][] = [
    ['node_modules/react/index.js', 'excluded_dir'],
    ['packages/a/node_modules/x/y.ts', 'excluded_dir'],
    ['dist/bundle.js', 'excluded_dir'],
    ['web/.next/server/page.js', 'excluded_dir'],
    ['src/__pycache__/x.py', 'excluded_dir'],
    ['vendor/github.com/pkg/errors/errors.go', 'excluded_dir'],
    ['package-lock.json', 'lockfile'],
    ['frontend/yarn.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['.env', 'secret'],
    ['config/.env.production', 'secret'],
    ['certs/server.key', 'secret'],
    ['deploy/id_rsa', 'secret'],
    ['public/app.min.js', 'minified_or_generated'],
    ['static/main.js.map', 'minified_or_generated'],
    ['api/service.pb.go', 'minified_or_generated'],
    ['assets/logo.png', 'unsupported_type'],
    ['fonts/inter.woff2', 'unsupported_type'],
    ['bin/tool.exe', 'unsupported_type'],
    ['LICENSE', 'unsupported_type'],
  ];
  for (const [path, reason] of cases) {
    assert.equal(skipReason({ path, size: 100 }), reason, path);
  }
});

test('skipReason enforces size limits', () => {
  assert.equal(skipReason({ path: 'a.ts', size: 0 }), 'empty');
  assert.equal(skipReason({ path: 'a.ts', size: MAX_FILE_BYTES }), null);
  assert.equal(skipReason({ path: 'a.ts', size: MAX_FILE_BYTES + 1 }), 'too_large');
});

test('filterRepoFiles keeps blobs only, sorts, counts skips and caps the list', () => {
  const result = filterRepoFiles(
    [
      { path: 'src', type: 'tree', sha: 't1' },
      { path: 'src/b.ts', type: 'blob', size: 10, sha: 'b' },
      { path: 'src/a.ts', type: 'blob', size: 10, sha: 'a' },
      { path: 'node_modules/x.js', type: 'blob', size: 10, sha: 'x' },
      { path: 'img.png', type: 'blob', size: 10, sha: 'p' },
      { path: 'sub', type: 'commit', sha: 'c' }, // submodule
    ],
    1,
  );
  assert.deepEqual(result.files, [{ path: 'src/a.ts', size: 10, sha: 'a' }]);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.skipped, { excluded_dir: 1, unsupported_type: 1 });
});

test('looksLikeBinaryOrMinified flags NUL bytes and very long lines', () => {
  assert.equal(looksLikeBinaryOrMinified('const a = 1;\nconst b = 2;\n'), false);
  assert.equal(looksLikeBinaryOrMinified('abc\u0000def'), true);
  assert.equal(looksLikeBinaryOrMinified('x'.repeat(6000)), true);
});

// ---------- point ids ----------

test('uuidV5 matches the RFC 4122 reference vector', () => {
  const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  assert.equal(uuidV5('www.example.com', DNS), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
});

test('chunkPointId is deterministic, unique per input and a valid v5 uuid', () => {
  const a = chunkPointId('repo-1', 'abc123', 'src/a.ts', 10);
  assert.equal(a, chunkPointId('repo-1', 'abc123', 'src/a.ts', 10));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const variants = new Set([
    a,
    chunkPointId('repo-2', 'abc123', 'src/a.ts', 10),
    chunkPointId('repo-1', 'def456', 'src/a.ts', 10),
    chunkPointId('repo-1', 'abc123', 'src/b.ts', 10),
    chunkPointId('repo-1', 'abc123', 'src/a.ts', 11),
    // separators cannot be confused
    chunkPointId('repo-1', 'abc123', 'src/a.ts:1', 0),
  ]);
  assert.equal(variants.size, 6);
  assert.notEqual(POINT_ID_NAMESPACE, a);
});

// ---------- chunker ----------

function assertWellFormed(chunks: Chunk[], content: string) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine, `range ${c.startLine}-${c.endLine}`);
    assert.ok(c.endLine - c.startLine + 1 <= MAX_CHUNK_LINES, 'line limit');
    if (i > 0) assert.ok(c.startLine > chunks[i - 1]!.endLine, 'sorted and non-overlapping');
    assert.equal(c.text, lines.slice(c.startLine - 1, c.endLine).join('\n'), 'text matches lines');
    assert.ok(c.text.trim().length > 0, 'no empty chunks');
  }
}

const summary = (chunks: Chunk[]) => chunks.map((c) => `${c.chunkType}:${c.symbol ?? '-'}`);

test('TypeScript: functions, arrow functions, classes, exports and doc comments', async () => {
  const src = [
    "import { x } from './x';",
    "import { y } from './y';",
    '',
    '/** Adds numbers. */',
    'export function add(a: number, b: number) {',
    '  return a + b;',
    '}',
    '',
    'export const double = (n: number) => n * 2;',
    '',
    'const CONFIG = { a: 1 };',
    '',
    'export class Store {',
    '  get() { return 1; }',
    '}',
    '',
    'interface Shape { area(): number }',
  ].join('\n');
  const chunks = await chunkFile('src/math.ts', src);
  assertWellFormed(chunks, src);
  // The tiny import header and the one-line const fold into the next chunk.
  assert.deepEqual(summary(chunks), [
    'function:add',
    'function:double',
    'class:Store',
    'class:Shape',
  ]);
  const add = chunks.find((c) => c.symbol === 'add')!;
  assert.ok(add.text.includes('/** Adds numbers. */'), 'doc comment attached to the function');
  assert.ok(chunks.find((c) => c.symbol === 'Store')!.text.startsWith('const CONFIG'));
  assert.equal(add.language, 'typescript');
});

test('TypeScript: an oversized class is split into header + Class.method chunks', async () => {
  const method = (name: string) => [
    `  ${name}() {`,
    ...Array.from({ length: 30 }, (_, i) => `    const v${i} = ${i};`),
    '  }',
  ];
  const src = [
    'export class Big {',
    '  private count = 0;',
    '',
    ...method('alpha'),
    ...method('beta'),
    ...method('gamma'),
    ...method('delta'),
    '}',
  ].join('\n');
  const chunks = await chunkFile('big.ts', src);
  assertWellFormed(chunks, src);
  assert.deepEqual(summary(chunks), [
    'class:Big',
    'function:Big.alpha',
    'function:Big.beta',
    'function:Big.gamma',
    'function:Big.delta',
  ]);
  assert.equal(chunks.at(-1)!.endLine, src.split('\n').length, 'closing brace folded in');
});

test('a huge function is split into windows within the limits', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `  total += ${i};`);
  const src = ['function huge() {', '  let total = 0;', ...body, '  return total;', '}'].join('\n');
  const chunks = await chunkFile('huge.js', src);
  assertWellFormed(chunks, src);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.symbol === 'huge' && c.chunkType === 'function'));
});

test('Python: decorated functions and classes', async () => {
  const src = [
    'import os',
    '',
    '@app.route("/")',
    'def index():',
    '    return "hi"',
    '',
    'class Service:',
    '    """Docs."""',
    '    def run(self):',
    '        pass',
  ].join('\n');
  const chunks = await chunkFile('app/main.py', src);
  assertWellFormed(chunks, src);
  assert.deepEqual(summary(chunks), ['function:index', 'class:Service']);
  assert.ok(chunks[0]!.text.includes('@app.route'), 'decorator included');
  assert.equal(chunks[0]!.language, 'python');
});

test('Go: methods are named Receiver.method', async () => {
  const src = [
    'package main',
    '',
    'type Server struct {',
    '  addr string',
    '}',
    '',
    'func (s *Server) Start() error {',
    '  return nil',
    '}',
    '',
    'func main() {}',
  ].join('\n');
  const chunks = await chunkFile('main.go', src);
  assertWellFormed(chunks, src);
  assert.deepEqual(summary(chunks), ['class:Server', 'function:Server.Start', 'function:main']);
});

test('Rust: impl blocks and functions', async () => {
  const src = [
    'struct Point { x: i32 }',
    '',
    'impl Point {',
    '    fn new() -> Self { Point { x: 0 } }',
    '}',
    '',
    'fn main() {}',
  ].join('\n');
  const chunks = await chunkFile('src/main.rs', src);
  assertWellFormed(chunks, src);
  assert.deepEqual(summary(chunks), ['class:Point', 'class:Point', 'function:main']);
});

test('Markdown is split by heading with the heading as symbol', async () => {
  const src = [
    '# Project',
    'Intro text.',
    '',
    '## Setup',
    ...Array.from({ length: 10 }, (_, i) => `Step ${i}`),
    '',
    '```bash',
    '# not a heading',
    '```',
    '',
    '## Usage',
    ...Array.from({ length: 10 }, (_, i) => `Use ${i}`),
  ].join('\n');
  const chunks = await chunkFile('README.md', src);
  assertWellFormed(chunks, src);
  assert.deepEqual(summary(chunks), ['text:Project', 'text:Setup', 'text:Usage']);
  assert.equal(chunks[0]!.language, 'markdown');
});

test('unknown types fall back to text chunks; CRLF and empty files are handled', async () => {
  const yaml = 'a: 1\r\nb: 2\r\n\r\nc: 3\r\n';
  const chunks = await chunkFile('config/app.yaml', yaml);
  assertWellFormed(chunks, yaml);
  assert.ok(chunks.every((c) => c.chunkType === 'text' && c.language === 'yaml'));
  assert.ok(!chunks.some((c) => c.text.includes('\r')));
  assert.deepEqual(await chunkFile('empty.ts', ''), []);
  assert.deepEqual(await chunkFile('blank.md', '\n\n  \n'), []);
});

test('syntax errors still produce well-formed chunks', async () => {
  const src = 'function ok() { return 1 }\nfunction broken( {\n  ???\n}\nconst z = 1;';
  const chunks = await chunkFile('broken.ts', src);
  assertWellFormed(chunks, src);
  assert.ok(chunks.length >= 1);
});

test('tiny blocks (divider comments, trailing exports) fold into a neighbour', async () => {
  const body = (name: string) => [
    `function ${name}() {`,
    ...Array.from({ length: 8 }, (_, i) => `  const v${i} = ${i};`),
    '}',
  ];
  const src = [
    "import { a } from './a';",
    '',
    '// ---- claims ------------------------------------------------',
    '',
    ...body('first'),
    '',
    '// ---- engine ------------------------------------------------',
    '',
    ...body('second'),
    '',
    'export default second;',
  ].join('\n');
  const chunks = await chunkFile('mod.js', src);
  assertWellFormed(chunks, src);
  assert.ok(
    chunks.every((c) => c.startLine !== c.endLine),
    `no single-line chunks: ${chunks.map((c) => `${c.startLine}-${c.endLine}`).join(', ')}`,
  );
  const first = chunks.find((c) => c.symbol === 'first')!;
  const second = chunks.find((c) => c.symbol === 'second')!;
  assert.ok(first.text.includes('---- claims'), 'divider joins the code it introduces');
  assert.ok(second.text.includes('---- engine'));
  assert.ok(
    second.text.endsWith('export default second;'),
    'trailing export joins the previous chunk',
  );
});
