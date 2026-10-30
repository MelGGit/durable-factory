import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { ChatApp } from './chat.js';
import { PageCardsProvider } from './hooks/use-page-cards.js';
import { applyTheme, readTheme } from './hooks/use-theme.js';

applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(
  <PageCardsProvider>
    <ChatApp />
  </PageCardsProvider>,
);
