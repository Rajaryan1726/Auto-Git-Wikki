import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../app/theme-context';

/**
 * `icon`: square icon-only button (login page corner).
 * `full`: full-width row with icon + label naming the mode it switches to (sidebar footer).
 */
export function ThemeToggle({ variant = 'icon' }: { variant?: 'icon' | 'full' }) {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const Icon = next === 'light' ? Sun : Moon;
  const label = next === 'light' ? 'Light mode' : 'Dark mode';

  if (variant === 'full') {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={`Switch to ${next} mode`}
        className="flex min-h-11 w-full items-center gap-3 rounded-md border border-border bg-raised px-3 text-sm font-medium text-muted transition-colors hover:bg-soft hover:text-text"
      >
        <Icon size={18} aria-hidden />
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} mode`}
      title={label}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-muted transition-colors hover:text-text"
    >
      <Icon size={18} aria-hidden />
    </button>
  );
}
