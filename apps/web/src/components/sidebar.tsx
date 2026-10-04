import { NavLink } from 'react-router-dom';
import { FolderGit2, LayoutDashboard, MessageSquare, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

const NAV: NavItem[] = [
  { to: '/overview', label: 'Overview', icon: LayoutDashboard },
  { to: '/', label: 'Repositories', icon: FolderGit2, end: true },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function navClass({ isActive }: { isActive: boolean }): string {
  const base =
    'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors';
  return isActive
    ? `${base} bg-accent-soft text-accent-text`
    : `${base} text-muted hover:bg-soft hover:text-text`;
}

export function Sidebar() {
  return (
    <aside className="flex flex-col gap-4 border-b border-border bg-surface p-4 md:sticky md:top-0 md:h-screen md:w-64 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <NavLink to="/" className="flex min-h-11 items-center gap-2 rounded-md px-1">
          <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-accent font-heading text-base font-bold text-on-accent">
            A
          </span>
          <span className="font-heading text-lg font-semibold">AutoWiki</span>
        </NavLink>
      </div>

      <nav aria-label="Main">
        <ul className="flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to} className="shrink-0">
              <NavLink to={to} end={end} className={navClass}>
                <Icon size={18} aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex flex-col gap-3 border-t border-border pt-4 md:mt-auto">
        <ThemeToggle variant="full" />
        <hr className="border-border" />
        <UserMenu />
      </div>
    </aside>
  );
}
