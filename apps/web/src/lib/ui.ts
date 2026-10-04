/** Shared class strings so buttons look the same everywhere (44px min height). */
const buttonBase =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';

export const buttonClass = {
  primary: `${buttonBase} bg-accent text-on-accent hover:opacity-90`,
  secondary: `${buttonBase} border border-border bg-raised text-text hover:bg-soft`,
  ghost: `${buttonBase} text-muted hover:bg-soft hover:text-text`,
} as const;

export const pillClass =
  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-5';
