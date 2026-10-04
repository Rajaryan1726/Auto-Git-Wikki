import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

/** Matches [1], [2, 3] and [1][2]; numbers only, so links like [text](url) are untouched. */
const CITATION = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

export const CITE_PREFIX = '#cite-';

/**
 * remark plugin: turns `[n]` markers in prose into links with href `#cite-n` (rendered as
 * small source links). Code and inline code are separate node types, so they stay as-is.
 */
export function remarkCitations() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || parent.type === 'link') return;
      const parts: PhrasingContent[] = [];
      let last = 0;
      for (const m of node.value.matchAll(CITATION)) {
        const at = m.index ?? 0;
        if (at > last) parts.push({ type: 'text', value: node.value.slice(last, at) });
        for (const n of m[1]!.split(',').map((x) => x.trim())) {
          const link: Link = {
            type: 'link',
            url: `${CITE_PREFIX}${n}`,
            children: [{ type: 'text', value: n }],
          };
          parts.push(link);
        }
        last = at + m[0].length;
      }
      if (parts.length === 0) return;
      if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
      parent.children.splice(index, 1, ...(parts as typeof parent.children));
      return [SKIP, index + parts.length];
    });
  };
}
