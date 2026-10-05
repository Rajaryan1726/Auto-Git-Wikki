import { createContext, useContext } from 'react';

export type Theme = 'light' | 'dark';
/** What the user chose: follow the OS, or a fixed theme. */
export type ThemePreference = 'system' | Theme;

type ThemeContextValue = {
  theme: Theme;
  preference: ThemePreference;
  toggleTheme: () => void;
  setPreference: (preference: ThemePreference) => void;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
