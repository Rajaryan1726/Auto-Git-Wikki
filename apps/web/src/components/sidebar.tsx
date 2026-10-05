import { useState, type MouseEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { FolderGit2, LayoutDashboard, Menu, MessageSquare, Settings, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';
import { SidebarIndexing } from '../features/index-jobs/sidebar-indexing';
import { PlanBadge } from '../features/billing/plan-badge';

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

function Logo() {
  return (
    <NavLink to="/" className="flex min-h-11 items-center gap-2 rounded-md px-1">
      <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-accent font-heading text-base font-bold text-on-accent">
        A
      </span>
      <span className="font-heading text-lg font-semibold">AutoWiki</span>
    </NavLink>
  );
}

/**
 * Desktop (≥ 768 px): a fixed sidebar. Mobile: a compact top bar; the menu button opens
 * the same navigation, indexing status, theme and account below it, so pages are not
 * pushed down by the full sidebar.
 */
export function Sidebar() {
  const [open, setOpen] = useState(false);

  return (
    <aside className="sticky top-0 z-30 border-b border-border bg-surface md:h-screen md:w-64 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0">
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <Logo />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="app-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-raised text-muted hover:text-text md:hidden"
          >
            {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
          </button>
        </div>

        <div
          id="app-menu"
          // Close the mobile menu once a link in it is followed.
          onClick={(e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('a')) setOpen(false);
          }}
          className={`${open ? 'flex' : 'hidden'} max-h-[calc(100dvh-5rem)] flex-col gap-4 overflow-y-auto md:flex md:max-h-none md:flex-1 md:overflow-visible`}
        >
          <nav aria-label="Main">
            <ul className="flex flex-col gap-1">
              {NAV.map(({ to, label, icon: Icon, end }) => (
                <li key={to}>
                  <NavLink to={to} end={end} className={navClass}>
                    <Icon size={18} aria-hidden />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <SidebarIndexing />

          <div className="flex flex-col gap-3 border-t border-border pt-4 md:mt-auto">
            <ThemeToggle variant="full" />
            <hr className="border-border" />
            <UserMenu />
            <PlanBadge />
          </div>
        </div>
      </div>
    </aside>
  );
}
