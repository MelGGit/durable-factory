import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { ChatApp } from './chat.js';

createRoot(document.getElementById('root')!).render(<ChatApp />);
