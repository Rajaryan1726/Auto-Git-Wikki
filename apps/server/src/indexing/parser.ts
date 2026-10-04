import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';
import type { LanguageConfig } from './languages.js';

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const parsers = new Map<string, Promise<Parser>>();

function init(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

/** One parser per grammar, created lazily and reused (parsing is synchronous). */
export function getParser(config: LanguageConfig): Promise<Parser> {
  let parser = parsers.get(config.grammar);
  if (!parser) {
    parser = (async () => {
      await init();
      const wasm = require.resolve(
        `@vscode/tree-sitter-wasm/wasm/tree-sitter-${config.grammar}.wasm`,
      );
      const language = await Language.load(wasm);
      const p = new Parser();
      p.setLanguage(language);
      return p;
    })();
    // Do not cache a failed load; the next call retries.
    parser.catch(() => parsers.delete(config.grammar));
    parsers.set(config.grammar, parser);
  }
  return parser;
}
