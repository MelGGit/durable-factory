import React from 'react';

/** The top bar shared by every view: page title, optional mode tag and actions. */
export function PageHeader({
  title,
  tag,
  actions,
  onOpenNavigation,
  navigationOpen,
}: {
  title: string;
  tag?: string;
  actions?: React.ReactNode;
  onOpenNavigation?: () => void;
  navigationOpen?: boolean;
}) {
  return (
    <header className="chat-header">
      {onOpenNavigation && (
        <button
          type="button"
          className="secondary navigation-toggle"
          aria-haspopup="dialog"
          aria-expanded={navigationOpen}
          onClick={onOpenNavigation}
        >
          Conversations
        </button>
      )}
      <h1>{title}</h1>
      {tag && <span className="mode-tag">{tag}</span>}
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}
