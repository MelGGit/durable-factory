import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { ChatApp } from './chat.js';
import { applyTheme, readTheme } from './hooks/use-theme.js';

applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(<ChatApp />);
