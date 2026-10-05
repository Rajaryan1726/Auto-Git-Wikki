import { useEffect, useRef, type ReactNode } from 'react';
import { LoaderCircle, Trash2, TriangleAlert } from 'lucide-react';
import { buttonClass, dangerButtonClass } from '../lib/ui';

/**
 * Styled confirmation for destructive actions (native <dialog>: focus trap, Esc to
 * cancel). Cancel has the initial focus, so Enter never confirms by accident.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      aria-labelledby="confirm-title"
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-6 text-text backdrop:bg-black/50"
    >
      <h2 id="confirm-title" className="flex items-center gap-2 text-lg font-semibold">
        <TriangleAlert size={20} className="shrink-0 text-danger" aria-hidden />
        {title}
      </h2>
      <div className="mt-2 text-sm text-muted">{children}</div>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={buttonClass.secondary}
          autoFocus
        >
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} className={dangerButtonClass}>
          {busy ? (
            <LoaderCircle size={16} className="animate-spin" aria-hidden />
          ) : (
            <Trash2 size={16} aria-hidden />
          )}
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
