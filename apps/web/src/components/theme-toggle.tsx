import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../app/theme-context';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-muted transition-colors hover:text-text"
    >
      {theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}
