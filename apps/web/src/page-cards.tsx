import React, { useContext, useEffect, useState } from 'react';
import { PageCardsContext, type PageCard } from './hooks/use-page-cards.js';
import { Overlay, useMedia } from './panels.js';

function Card({ card }: { card: PageCard }) {
  const heading = (
    <>
      <h2>{card.title}</h2>
      {card.actions && <div className="page-card-actions">{card.actions}</div>}
    </>
  );
  return card.collapsible ? (
    <details className="page-card" data-card-id={card.id}>
      <summary className="page-card-heading">{heading}</summary>
      <div className="page-card-body">{card.content}</div>
    </details>
  ) : (
    <section
      className="page-card"
      data-card-id={card.id}
      aria-label={card.title}
    >
      <div className="page-card-heading">{heading}</div>
      <div className="page-card-body">{card.content}</div>
    </section>
  );
}

/** Shared content area. Pages register cards without owning the layout. */
export function PageWorkspace({
  children,
  disabled,
}: {
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const registration = useContext(PageCardsContext);
  const desktop = useMedia('(min-width: 1200px)');
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [registration?.owner, desktop]);
  const hasCards = Boolean(registration?.cards.length);
  const cards = registration?.cards.map((card) => (
    <Card key={card.id} card={card} />
  ));
  return (
    <div
      className={`page-workspace${desktop && hasCards ? ' with-page-cards' : ''}`}
    >
      <div className="page-content">
        {hasCards && !desktop && (
          <div className="page-information-toolbar">
            <button
              type="button"
              className="secondary"
              aria-haspopup="dialog"
              aria-expanded={open}
              disabled={disabled}
              onClick={() => setOpen(true)}
            >
              {registration!.label}
            </button>
          </div>
        )}
        {children}
      </div>
      {hasCards && desktop && (
        <section
          className="page-cards"
          aria-label={registration!.label}
          inert={disabled}
        >
          {cards}
        </section>
      )}
      {hasCards && !desktop && (
        <Overlay
          open={open}
          label={registration!.label}
          className="page-cards-overlay"
          onClose={() => setOpen(false)}
        >
          <div className="page-cards" inert={disabled}>
            {cards}
          </div>
        </Overlay>
      )}
    </div>
  );
}
