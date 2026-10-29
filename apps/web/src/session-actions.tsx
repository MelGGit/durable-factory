import React, { useEffect, useRef, useState } from 'react';

/** One-item disclosure; native button tab order, Escape and outside dismissal. */
export function SessionActions({
  title,
  disabled,
  retry,
  status,
  onDelete,
}: {
  title: string;
  disabled: boolean;
  retry: boolean;
  status?: string;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    action.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return (
    <div
      className="session-actions"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        // Safari can blur to the page when a button is clicked. Closing on a
        // null target removes Delete before its click is delivered. Pointer
        // dismissal handles that case; keyboard focus changes have a target.
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        type="button"
        className="session-actions-trigger"
        ref={trigger}
        aria-label={`Actions for ${title}`}
        aria-expanded={open}
        title={status ?? 'Session actions'}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <div className="session-actions-popover">
          <button
            type="button"
            ref={action}
            className="delete-chat"
            aria-label={`${retry ? 'Retry deleting' : 'Delete'} ${title}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
              onDelete();
            }}
          >
            {retry ? 'Retry deletion' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}
