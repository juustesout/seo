/**
 * Web entry point: mounts the React app into #root and imports the global
 * stylesheet. StrictMode double-invokes effects in development, which is why
 * effects across the codebase guard their async work with `alive` flags. No
 * router library is used here - App owns history-based routing from the URL.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
