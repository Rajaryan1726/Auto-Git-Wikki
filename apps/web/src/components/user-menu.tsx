import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '../features/auth/auth-context';

export function UserMenu() {
  const { user, signOut, isSigningOut } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex items-center gap-3">
      {user.avatarUrl ? (
        <img
          src={user.avatarUrl}
          alt=""
          width={36}
          height={36}
          className="h-9 w-9 shrink-0 rounded-full border border-border"
        />
      ) : (
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-soft font-semibold"
        >
          {user.username.charAt(0).toUpperCase()}
        </span>
      )}
      {/* Never truncate the username: wrap long names instead. */}
      <div className="min-w-0 flex-1">
        <p
          className="text-sm leading-snug font-semibold [overflow-wrap:anywhere]"
          title={user.username}
        >
          {user.username}
        </p>
        <p className="text-xs text-muted">Signed in with GitHub</p>
      </div>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={isSigningOut}
        aria-label="Sign out"
        title="Sign out"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-soft hover:text-text disabled:opacity-60"
      >
        <LogOut size={18} aria-hidden />
      </button>
    </div>
  );
}
