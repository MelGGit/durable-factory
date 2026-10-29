import React from 'react';

/** The top bar shared by every view: page title and contextual actions. */
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
      <div className="header-heading">
        <h1 title={title}>{title}</h1>
      </div>
      {tag && <span className="mode-tag">{tag}</span>}
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}
