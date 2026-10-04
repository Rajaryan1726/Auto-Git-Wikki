/**
 * Per-language tree-sitter configuration for the chunker.
 * Grammar wasm files come from @vscode/tree-sitter-wasm (ABI-compatible with web-tree-sitter).
 */

export type LanguageConfig = {
  /** Payload `language` value. */
  name: string;
  /** File name in @vscode/tree-sitter-wasm/wasm (without `tree-sitter-` / `.wasm`). */
  grammar: string;
  /** Nodes emitted as `function` chunks. */
  functions: ReadonlySet<string>;
  /** Nodes emitted as `class` chunks; split into members when too large. */
  classes: ReadonlySet<string>;
  /** Namespaces/modules: never a chunk themselves, their members are chunked. */
  containers?: ReadonlySet<string>;
  /** Wrapper node -> field holding the real declaration (exports, decorators). */
  wrappers?: Readonly<Record<string, string>>;
  /** `const foo = () => {}` style declarations count as functions. */
  variableFunctions?: boolean;
};

const set = (...items: string[]): ReadonlySet<string> => new Set(items);

const ecmascript = (name: string, grammar: string): LanguageConfig => ({
  name,
  grammar,
  functions: set(
    'function_declaration',
    'generator_function_declaration',
    'method_definition',
    'function_signature',
  ),
  classes: set(
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
  ),
  containers: set('internal_module', 'module'),
  wrappers: { export_statement: 'declaration' },
  variableFunctions: true,
});

const CONFIGS: Record<string, LanguageConfig> = {
  typescript: ecmascript('typescript', 'typescript'),
  tsx: ecmascript('tsx', 'tsx'),
  javascript: ecmascript('javascript', 'javascript'),
  python: {
    name: 'python',
    grammar: 'python',
    functions: set('function_definition'),
    classes: set('class_definition'),
    wrappers: { decorated_definition: 'definition' },
  },
  go: {
    name: 'go',
    grammar: 'go',
    functions: set('function_declaration', 'method_declaration'),
    classes: set('type_declaration'),
  },
  rust: {
    name: 'rust',
    grammar: 'rust',
    functions: set('function_item', 'function_signature_item'),
    classes: set('impl_item', 'struct_item', 'enum_item', 'trait_item', 'union_item'),
    containers: set('mod_item'),
  },
  java: {
    name: 'java',
    grammar: 'java',
    functions: set('method_declaration', 'constructor_declaration'),
    classes: set(
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'annotation_type_declaration',
    ),
  },
  csharp: {
    name: 'csharp',
    grammar: 'c-sharp',
    functions: set('method_declaration', 'constructor_declaration', 'local_function_statement'),
    classes: set(
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'record_declaration',
      'enum_declaration',
    ),
    containers: set('namespace_declaration', 'file_scoped_namespace_declaration'),
  },
  ruby: {
    name: 'ruby',
    grammar: 'ruby',
    functions: set('method', 'singleton_method'),
    classes: set('class', 'module', 'singleton_class'),
  },
  php: {
    name: 'php',
    grammar: 'php',
    functions: set('function_definition', 'method_declaration'),
    classes: set(
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ),
    containers: set('namespace_definition'),
  },
  cpp: {
    name: 'cpp',
    grammar: 'cpp',
    functions: set('function_definition'),
    classes: set('class_specifier', 'struct_specifier', 'enum_specifier', 'union_specifier'),
    containers: set('namespace_definition', 'linkage_specification'),
    wrappers: { template_declaration: '' },
  },
  bash: {
    name: 'bash',
    grammar: 'bash',
    functions: set('function_definition'),
    classes: set(),
  },
};

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  sh: 'bash',
  bash: 'bash',
};

/** Language label for files we only split as text. */
const TEXT_LANGUAGE: Record<string, string> = {
  md: 'markdown',
  mdx: 'markdown',
  rst: 'rst',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  xml: 'xml',
  kt: 'kotlin',
  swift: 'swift',
  vue: 'vue',
  svelte: 'svelte',
  dart: 'dart',
};

function ext(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
}

/** Tree-sitter config for a path, or null when the file is chunked as plain text. */
export function languageForPath(path: string): LanguageConfig | null {
  const key = EXTENSION_LANGUAGE[ext(path)];
  return key ? (CONFIGS[key] ?? null) : null;
}

/** Payload `language` for any path (falls back to the extension, or `text`). */
export function languageName(path: string): string {
  const e = ext(path);
  return languageForPath(path)?.name ?? TEXT_LANGUAGE[e] ?? (e.length <= 10 ? e : 'text');
}
