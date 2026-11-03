import React, { useLayoutEffect, useRef } from 'react';

/** Let the browser own clicks and keyboard activation. Synchronize only actual
 * state changes: cancelling a summary click can undo React's open update in Safari. */
export function ActivityDisclosure({
  open,
  onOpenChange,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'details'>, 'open' | 'onToggle'> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (ref.current && ref.current.open !== open) ref.current.open = open;
  }, [open]);
  return (
    <details
      {...props}
      ref={ref}
      onToggle={(event) => {
        if (
          event.target === event.currentTarget &&
          event.currentTarget.open !== open
        )
          onOpenChange(event.currentTarget.open);
      }}
    >
      {children}
    </details>
  );
}
