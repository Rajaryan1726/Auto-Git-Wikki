import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { ToastContext, type ToastTone } from './toast-context';

type Toast = { id: number; tone: ToastTone; message: string };

const TONE: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: 'border-success/40 text-success' },
  error: { icon: CircleAlert, className: 'border-danger/40 text-danger' },
  info: { icon: Info, className: 'border-border text-text' },
};

/** Short confirmations for actions. Errors stay until dismissed; others fade after 5 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, tone, message }]);
      if (tone !== 'error') setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      success: (m: string) => show('success', m),
      error: (m: string) => show('error', m),
      info: (m: string) => show('info', m),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
      >
        {toasts.map((t) => {
          const { icon: Icon, className } = TONE[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-raised px-4 py-3 text-sm shadow-lg ${className}`}
            >
              <Icon size={18} aria-hidden className="mt-0.5 shrink-0" />
              <p className="min-w-0 flex-1 text-text [overflow-wrap:anywhere]">{t.message}</p>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="-my-1 -mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-soft hover:text-text"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
