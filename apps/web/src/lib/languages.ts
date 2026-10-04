/** GitHub linguist colors for common languages; anything else uses the neutral fallback. */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Go: '#00add8',
  Rust: '#dea584',
  Ruby: '#701516',
  PHP: '#4f5d95',
  'C#': '#178600',
  'C++': '#f34b7d',
  C: '#555555',
  Swift: '#f05138',
  Dart: '#00b4ab',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Lua: '#000080',
  Shell: '#89e051',
  PowerShell: '#012456',
  HTML: '#e34c26',
  CSS: '#663399',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  'Jupyter Notebook': '#da5b0b',
  Dockerfile: '#384d54',
  MDX: '#fcb32c',
  Markdown: '#083fa1',
  Solidity: '#aa6746',
  R: '#198ce7',
};

export const FALLBACK_LANGUAGE_COLOR = 'var(--muted)';

export function languageColor(language: string | null | undefined): string {
  return (language && LANGUAGE_COLORS[language]) || FALLBACK_LANGUAGE_COLOR;
}
