import React, { useContext, useEffect } from 'react';
import {
  PageCardsContext,
  PageCardsDisplayContext,
  type PageCard,
} from './hooks/use-page-cards.js';
import { Overlay, useMedia } from './panels.js';
import { Icon } from './icons.js';

export function PageCardsToggle({ disabled }: { disabled?: boolean }) {
  const registration = useContext(PageCardsContext);
  const display = useContext(PageCardsDisplayContext)!;
  const desktop = useMedia('(min-width: 1200px)');
  if (!registration?.cards.length) return null;
  const open = desktop ? display.desktopOpen : display.overlayOpen;
  const label = open ? 'Hide chat trails' : 'Show chat trails';
  return (
    <button
      type="button"
      className="page-cards-toggle"
      aria-label={label}
      title={label}
      aria-controls="page-information"
      aria-expanded={open}
      aria-haspopup={desktop ? undefined : 'dialog'}
      disabled={disabled}
      onClick={() =>
        desktop ? display.setDesktopOpen(!open) : display.setOverlayOpen(!open)
      }
    >
      <Icon name="list" size={18} />
    </button>
  );
}

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
  const { desktopOpen, overlayOpen, setOverlayOpen } = useContext(
    PageCardsDisplayContext,
  )!;
  const desktop = useMedia('(min-width: 1200px)');
  useEffect(
    () => setOverlayOpen(false),
    [registration?.owner, desktop, setOverlayOpen],
  );
  const hasCards = Boolean(registration?.cards.length);
  const cards = registration?.cards.map((card) => (
    <Card key={card.id} card={card} />
  ));
  return (
    <div
      className={`page-workspace${desktop && hasCards ? ' with-page-cards' : ''}`}
    >
      <div className="page-content">{children}</div>
      {hasCards && desktop && (
        <section
          id="page-information"
          className={`page-cards${desktopOpen ? '' : ' page-cards-hidden'}`}
          aria-label={registration!.label}
          aria-hidden={!desktopOpen}
          inert={disabled || !desktopOpen}
        >
          {cards}
        </section>
      )}
      {hasCards && !desktop && (
        <Overlay
          open={overlayOpen}
          label={registration!.label}
          className="page-cards-overlay"
          onClose={() => setOverlayOpen(false)}
        >
          <div id="page-information" className="page-cards" inert={disabled}>
            {cards}
          </div>
        </Overlay>
      )}
    </div>
  );
}
