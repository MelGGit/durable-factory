import React, { useEffect, useRef } from 'react';

export function useMedia(query: string) {
  const [matches, setMatches] = React.useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Native modal dialog provides inert background, Escape, and focus containment. */
export function Overlay({
  open,
  label,
  title,
  className,
  descriptionId,
  closeDisabled = false,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  title?: string;
  className?: string;
  descriptionId?: string;
  closeDisabled?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!open) {
      dialog.close();
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`chat-overlay${className ? ` ${className}` : ''}`}
      aria-describedby={descriptionId}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const elements = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!closeDisabled) onClose();
      }}
    >
      <div className="overlay-toolbar">
        {title ? <h2>{title}</h2> : <strong>{label}</strong>}
        <button
          autoFocus
          type="button"
          className="overlay-close"
          aria-label={`Close ${label.toLowerCase()}`}
          disabled={closeDisabled}
          onClick={onClose}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      {children}
    </dialog>
  );
}
