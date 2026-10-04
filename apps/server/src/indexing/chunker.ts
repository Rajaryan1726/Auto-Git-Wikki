import type { Node } from 'web-tree-sitter';
import { languageForPath, languageName, type LanguageConfig } from './languages.js';
import { getParser } from './parser.js';

export type ChunkType = 'function' | 'class' | 'block' | 'text';

export type Chunk = {
  /** 1-based, inclusive. Chunks of one file never overlap, so startLine is unique. */
  startLine: number;
  endLine: number;
  text: string;
  symbol: string | null;
  chunkType: ChunkType;
  language: string;
};

export const MAX_CHUNK_LINES = 120;
export const MAX_CHUNK_CHARS = 6000;
/** Loose code between definitions is grouped into blocks of about this size. */
export const BLOCK_TARGET_LINES = 60;
/** A pathological single line is cut so one chunk can never blow up the embed request. */
const MAX_TEXT_CHARS = 8000;

/** 0-based inclusive row range, before text is attached. */
type Range = { start: number; end: number; type: ChunkType; symbol: string | null };

type Ctx = { lines: string[]; config: LanguageConfig };

const BODY_TYPES = new Set([
  'class_body',
  'declaration_list',
  'field_declaration_list',
  'enum_body',
  'enum_member_declaration_list',
  'interface_body',
  'object_type',
  'block',
  'body_statement',
  'compound_statement',
  'enum_variant_list',
]);

const VARIABLE_FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

function isComment(node: Node): boolean {
  return node.type.includes('comment');
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function rowsChars(lines: string[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i <= end; i++) n += (lines[i]?.length ?? 0) + 1;
  return n;
}

function tooBig(ctx: Ctx, start: number, end: number): boolean {
  return end - start + 1 > MAX_CHUNK_LINES || rowsChars(ctx.lines, start, end) > MAX_CHUNK_CHARS;
}

/** Splits a row range into windows that respect the line and character limits. */
function splitRange(ctx: Ctx, range: Range): Range[] {
  const out: Range[] = [];
  let start = range.start;
  while (start <= range.end) {
    let end = start;
    let chars = (ctx.lines[start]?.length ?? 0) + 1;
    while (end < range.end) {
      const next = (ctx.lines[end + 1]?.length ?? 0) + 1;
      if (end - start + 1 >= MAX_CHUNK_LINES || chars + next > MAX_CHUNK_CHARS) break;
      end++;
      chars += next;
    }
    out.push({ ...range, start, end });
    start = end + 1;
  }
  return out;
}

function goReceiverType(node: Node): string | null {
  const receiver = node.childForFieldName('receiver')?.text;
  const match = receiver ? /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)\s*$/.exec(receiver) : null;
  return match?.[1] ?? null;
}

function nameOf(node: Node): string | null {
  switch (node.type) {
    case 'impl_item': {
      const type = node.childForFieldName('type')?.text;
      const trait = node.childForFieldName('trait')?.text;
      return type ? (trait ? `${trait} for ${type}` : type) : null;
    }
    case 'type_declaration': {
      const spec = namedChildren(node).find(
        (c) => c.type === 'type_spec' || c.type === 'type_alias',
      );
      return spec?.childForFieldName('name')?.text ?? null;
    }
    case 'method_declaration': {
      const name = node.childForFieldName('name')?.text ?? null;
      const receiver = goReceiverType(node);
      return name && receiver ? `${receiver}.${name}` : name;
    }
    case 'function_definition': {
      // C/C++ keep the name inside nested declarators; other grammars have a `name` field.
      const direct = node.childForFieldName('name');
      if (direct) return direct.text;
      let d = node.childForFieldName('declarator');
      while (d) {
        const inner = d.childForFieldName('declarator');
        if (!inner || d.type === 'qualified_identifier') break;
        d = inner;
      }
      return d ? d.text.replace(/\s+/g, '') : null;
    }
  }
  return node.childForFieldName('name')?.text ?? null;
}

type Definition = {
  kind: 'function' | 'class' | 'container';
  /** The declaration node itself (inside any export/decorator wrapper). */
  decl: Node;
  name: string | null;
};

function classify(node: Node, config: LanguageConfig): Definition | null {
  const wrapperField = config.wrappers?.[node.type];
  if (wrapperField !== undefined) {
    const inner = wrapperField
      ? node.childForFieldName(wrapperField)
      : (namedChildren(node).find((c) => classify(c, config)) ?? null);
    const def = inner ? classify(inner, config) : null;
    return def ?? null;
  }
  if (config.functions.has(node.type)) return { kind: 'function', decl: node, name: nameOf(node) };
  if (config.classes.has(node.type)) return { kind: 'class', decl: node, name: nameOf(node) };
  if (config.containers?.has(node.type)) {
    return { kind: 'container', decl: node, name: nameOf(node) };
  }
  if (
    config.variableFunctions &&
    (node.type === 'lexical_declaration' || node.type === 'variable_declaration')
  ) {
    const declarators = namedChildren(node).filter((c) => c.type === 'variable_declarator');
    const value = declarators.length === 1 ? declarators[0]!.childForFieldName('value') : null;
    if (value && VARIABLE_FUNCTION_VALUES.has(value.type)) {
      return {
        kind: 'function',
        decl: node,
        name: declarators[0]!.childForFieldName('name')?.text ?? null,
      };
    }
  }
  return null;
}

function membersOf(def: Definition): Node[] {
  const body =
    def.decl.childForFieldName('body') ??
    namedChildren(def.decl).find((c) => BODY_TYPES.has(c.type)) ??
    null;
  if (body) return namedChildren(body);
  // e.g. C# file-scoped namespaces hold their declarations directly.
  const nameNode = def.decl.childForFieldName('name');
  return namedChildren(def.decl).filter((c) => c.id !== nameNode?.id);
}

function joinSymbol(parent: string | null, name: string | null): string | null {
  if (!name) return parent;
  return parent ? `${parent}.${name}` : name;
}

/**
 * Chunks a run of sibling nodes. Definitions become their own chunks (with the comments
 * directly above them); everything else is grouped into `block` chunks.
 */
function chunkSiblings(ctx: Ctx, nodes: Node[], parentSymbol: string | null): Range[] {
  const out: Range[] = [];
  let block: { start: number; end: number } | null = null;
  let comments: { start: number; end: number } | null = null;

  const addToBlock = (start: number, end: number) => {
    if (block && end - block.start + 1 > BLOCK_TARGET_LINES) flushBlock();
    block = block ? { start: block.start, end: Math.max(block.end, end) } : { start, end };
  };
  const flushBlock = () => {
    if (block) out.push(...splitRange(ctx, { ...block, type: 'block', symbol: parentSymbol }));
    block = null;
  };
  const flushComments = () => {
    if (comments) addToBlock(comments.start, comments.end);
    comments = null;
  };

  for (const node of nodes) {
    const start = node.startPosition.row;
    const end = node.endPosition.row;

    if (isComment(node)) {
      // Contiguous comments may belong to the next definition.
      if (comments && start <= comments.end + 1) comments.end = end;
      else {
        flushComments();
        comments = { start, end };
      }
      continue;
    }

    const def = classify(node, ctx.config);
    if (!def) {
      flushComments();
      addToBlock(start, end);
      continue;
    }

    // Attach a doc comment that ends right above the definition.
    let defStart = start;
    if (comments && comments.end >= start - 1) {
      defStart = comments.start;
      comments = null;
    } else flushComments();
    flushBlock();

    const symbol = def.kind === 'container' ? parentSymbol : joinSymbol(parentSymbol, def.name);
    const split = def.kind === 'container' || (def.kind === 'class' && tooBig(ctx, defStart, end));
    const members = split ? membersOf(def) : [];

    if (!split || members.length === 0) {
      out.push(
        ...splitRange(ctx, {
          start: defStart,
          end,
          type: def.kind === 'container' ? 'block' : def.kind,
          symbol,
        }),
      );
      continue;
    }

    // Header = signature plus everything before the first member definition (fields,
    // properties), keeping a doc comment that sits right above that definition with it.
    let firstDef = members.findIndex((m) => classify(m, ctx.config) !== null);
    if (firstDef === -1) firstDef = members.length - 1;
    while (
      firstDef > 0 &&
      isComment(members[firstDef - 1]!) &&
      members[firstDef - 1]!.endPosition.row >= members[firstDef]!.startPosition.row - 1
    ) {
      firstDef--;
    }
    const rest = members.slice(firstDef);
    const firstMemberStart = rest[0]!.startPosition.row;
    if (firstMemberStart > defStart) {
      out.push(
        ...splitRange(ctx, {
          start: defStart,
          end: firstMemberStart - 1,
          type: def.kind === 'class' ? 'class' : 'block',
          symbol,
        }),
      );
    }
    const inner = chunkSiblings(ctx, rest, symbol);
    out.push(...inner);
    // Closing brace / `end`: fold short tails into the last member chunk.
    const last = out[out.length - 1];
    const tailStart = (last?.end ?? firstMemberStart) + 1;
    if (tailStart <= end) {
      if (last && end - tailStart < 3) last.end = end;
      else out.push(...splitRange(ctx, { start: tailStart, end, type: 'block', symbol }));
    }
  }
  flushComments();
  flushBlock();
  return out;
}

/** Merges neighbouring small `block` ranges so loose code is not split into crumbs. */
function mergeBlocks(ctx: Ctx, ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === 'block' &&
      r.type === 'block' &&
      prev.symbol === r.symbol &&
      r.end - prev.start + 1 <= BLOCK_TARGET_LINES &&
      rowsChars(ctx.lines, prev.start, r.end) <= MAX_CHUNK_CHARS
    ) {
      prev.end = r.end;
    } else out.push({ ...r });
  }
  return out;
}

/** Below this many non-blank characters a block is too small to be useful on its own. */
export const TINY_BLOCK_CHARS = 100;

function contentChars(lines: string[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i <= end; i++) n += (lines[i] ?? '').trim().length;
  return n;
}

/**
 * Folds tiny `block` ranges (section-divider comments, a trailing `export default x`)
 * into a neighbour: preferably the next range (dividers introduce what follows), else the
 * previous one. Limits still apply, and ranges stay sorted and non-overlapping.
 */
function absorbTinyBlocks(ctx: Ctx, ranges: Range[]): Range[] {
  const out = ranges.map((r) => ({ ...r }));
  const fits = (start: number, end: number) => !tooBig(ctx, start, end);
  for (let i = 0; i < out.length; i++) {
    const r = out[i]!;
    if (r.type !== 'block' || contentChars(ctx.lines, r.start, r.end) >= TINY_BLOCK_CHARS) continue;
    const next = out[i + 1];
    const prev = out[i - 1];
    if (next && fits(r.start, next.end)) {
      next.start = r.start;
    } else if (prev && fits(prev.start, r.end)) {
      prev.end = r.end;
    } else continue;
    out.splice(i, 1);
    i--;
  }
  return out;
}

/** Turns row ranges into chunks: trims blank edge lines and drops empty ranges. */
function toChunks(lines: string[], ranges: Range[], language: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const r of ranges) {
    let { start, end } = r;
    while (start <= end && !lines[start]?.trim()) start++;
    while (end >= start && !lines[end]?.trim()) end--;
    if (start > end) continue;
    let text = lines.slice(start, end + 1).join('\n');
    if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…`;
    chunks.push({
      startLine: start + 1,
      endLine: end + 1,
      text,
      symbol: r.symbol,
      chunkType: r.type,
      language,
    });
  }
  // Defensive: guarantee sorted, non-overlapping chunks (point ids key on startLine).
  chunks.sort((a, b) => a.startLine - b.startLine);
  return chunks.filter((c, i) => i === 0 || c.startLine > chunks[i - 1]!.endLine);
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s+(.*)$/;

/** Markdown: one section per heading. Other text: paragraphs packed into blocks. */
function chunkText(lines: string[], language: string): Chunk[] {
  const ctx: Ctx = { lines, config: null as unknown as LanguageConfig };
  const sections: Range[] = [];

  if (language === 'markdown') {
    let current: Range = { start: 0, end: -1, type: 'text', symbol: null };
    let inFence = false;
    lines.forEach((line, i) => {
      if (FENCE.test(line)) inFence = !inFence;
      const heading = !inFence ? HEADING.exec(line) : null;
      if (heading && i > current.start) {
        sections.push({ ...current, end: i - 1 });
        current = { start: i, end: -1, type: 'text', symbol: heading[1]!.trim() };
      } else if (heading) {
        current.symbol = heading[1]!.trim();
      }
    });
    sections.push({ ...current, end: lines.length - 1 });
  } else {
    let start = 0;
    for (let i = 0; i <= lines.length; i++) {
      const blank = i === lines.length || !lines[i]!.trim();
      if (blank) {
        if (i - 1 >= start) sections.push({ start, end: i - 1, type: 'text', symbol: null });
        start = i + 1;
      }
    }
  }

  // Pack small consecutive sections; split big ones.
  const packed: Range[] = [];
  for (const s of sections) {
    const prev = packed[packed.length - 1];
    if (
      prev &&
      (language !== 'markdown' || !s.symbol || s.end - s.start < 3) &&
      s.end - prev.start + 1 <= BLOCK_TARGET_LINES &&
      rowsChars(lines, prev.start, s.end) <= MAX_CHUNK_CHARS
    ) {
      prev.end = s.end;
    } else packed.push(...splitRange(ctx, s));
  }
  return toChunks(lines, packed, language);
}

/**
 * Splits a file into retrieval chunks. Code with a tree-sitter grammar is split on
 * functions/classes; everything else (and anything that fails to parse) as text.
 */
export async function chunkFile(path: string, content: string): Promise<Chunk[]> {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const language = languageName(path);
  const config = languageForPath(path);
  if (!config) return chunkText(lines, language);

  let tree;
  try {
    const parser = await getParser(config);
    tree = parser.parse(lines.join('\n'));
  } catch {
    return chunkText(lines, language);
  }
  if (!tree) return chunkText(lines, language);
  try {
    const ctx: Ctx = { lines, config };
    const ranges = absorbTinyBlocks(
      ctx,
      mergeBlocks(ctx, chunkSiblings(ctx, namedChildren(tree.rootNode), null)),
    );
    return toChunks(lines, ranges, language);
  } finally {
    tree.delete(); // free WASM memory
  }
}
