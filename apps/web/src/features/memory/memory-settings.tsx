import { useEffect, useRef, useState } from 'react';
import { Brain, CircleAlert, LoaderCircle, Trash2, TriangleAlert } from 'lucide-react';
import type { MemoryCategory, UserMemory } from '@autowiki/shared';
import { relativeTime } from '../../lib/time';
import { buttonClass, pillClass } from '../../lib/ui';
import { useDeleteMemory, useForgetEverything, useMemories, useSetMemoryEnabled } from './api';

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  identity: 'About you',
  progress: 'Working on',
  weak_topic: 'Finds hard',
  preference: 'Preference',
  goal: 'Goal',
  other: 'Other',
};

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className="relative h-6 w-11 shrink-0 rounded-full bg-soft transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent-text peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-raised after:shadow after:transition-transform peer-checked:after:translate-x-5"
      />
      {checked ? 'Memory on' : 'Memory off'}
    </label>
  );
}

function ConfirmForgetDialog({
  open,
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
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
      onClose={onCancel}
      aria-labelledby="forget-title"
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-6 text-text backdrop:bg-black/50"
    >
      <h2 id="forget-title" className="flex items-center gap-2 text-lg font-semibold">
        <TriangleAlert size={20} className="text-danger" aria-hidden />
        Forget everything?
      </h2>
      <p className="mt-2 text-sm text-muted">
        AutoWiki will permanently delete everything it remembers about you, including the history of
        each memory. This cannot be undone.
      </p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={buttonClass.secondary} autoFocus>
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`${buttonClass.primary} bg-danger`}
        >
          {busy ? (
            <LoaderCircle size={16} className="animate-spin" aria-hidden />
          ) : (
            <Trash2 size={16} aria-hidden />
          )}
          Forget everything
        </button>
      </div>
    </dialog>
  );
}

function MemoryRow({ memory }: { memory: UserMemory }) {
  const del = useDeleteMemory();
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm [overflow-wrap:anywhere]">{memory.text}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className={`${pillClass} border-border bg-raised`}>
            {CATEGORY_LABEL[memory.category]}
          </span>
          <span title={new Date(memory.updatedAt).toLocaleString()}>
            Updated {relativeTime(memory.updatedAt)}
          </span>
        </p>
        {del.error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {del.error.message}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => del.mutate(memory.id)}
        disabled={del.isPending}
        aria-label={`Forget: ${memory.text}`}
        title="Forget this"
        className={`${buttonClass.ghost} w-11 shrink-0 px-0`}
      >
        {del.isPending ? (
          <LoaderCircle size={16} className="animate-spin" aria-hidden />
        ) : (
          <Trash2 size={16} aria-hidden />
        )}
      </button>
    </li>
  );
}

/** Settings section: "What AutoWiki remembers about you". */
export function MemorySettings() {
  const memories = useMemories();
  const setEnabled = useSetMemoryEnabled();
  const forget = useForgetEverything();

  return (
    <section
      id="memory"
      aria-labelledby="memory-title"
      className="scroll-mt-6 rounded-lg border border-border bg-surface p-5 md:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <h2 id="memory-title" className="flex items-center gap-2 text-lg font-semibold">
            <Brain size={20} aria-hidden className="text-accent-text" />
            What AutoWiki remembers about you
          </h2>
          <p className="mt-1 text-sm text-muted">
            From your own chat messages, AutoWiki remembers things like your experience level, how
            you like explanations and what you are working on, and uses them to tailor answers. It
            never stores facts about code, anything from repositories, or secrets.
          </p>
        </div>
        {memories.data && (
          <Toggle
            checked={memories.data.enabled}
            disabled={setEnabled.isPending}
            onChange={(v) => setEnabled.mutate(v)}
          />
        )}
      </div>
      {setEnabled.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {setEnabled.error.message}
        </p>
      )}
      {memories.data && !memories.data.enabled && (
        <p className="mt-3 rounded-md bg-soft px-3 py-2 text-sm text-muted">
          Memory is off: nothing new is remembered and answers are not personalised. Existing
          memories are kept until you delete them.
        </p>
      )}

      <div className="mt-5">
        {memories.isPending ? (
          <div className="space-y-2" role="status" aria-label="Loading memories">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-md bg-soft" />
            ))}
          </div>
        ) : memories.error ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-danger">
            <CircleAlert size={16} aria-hidden />
            Could not load memories: {memories.error.message}
          </p>
        ) : memories.data.memories.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
            Nothing remembered yet.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-raised/40">
              {memories.data.memories.map((m) => (
                <MemoryRow key={m.id} memory={m} />
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <ForgetEverything
                onConfirm={() => forget.mutateAsync()}
                busy={forget.isPending}
                error={forget.error?.message ?? null}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ForgetEverything({
  onConfirm,
  busy,
  error,
}: {
  onConfirm: () => Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="inline-flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${buttonClass.secondary} text-danger`}
        >
          <Trash2 size={16} aria-hidden />
          Forget everything
        </button>
        {error && (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        )}
      </span>
      <ConfirmForgetDialog
        open={open}
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={() => void onConfirm().then(() => setOpen(false))}
      />
    </>
  );
}
