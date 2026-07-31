import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';   // ← THIS LINE loads Tailwind. Without it, nothing is styled.
import App from './App.jsx';

// Ask the browser to mark our storage as persistent. Without this, IndexedDB
// (which holds unsynced sales and debts) is "best effort" and the browser may
// evict it under disk pressure — silently losing a day of offline takings.
// Granted automatically for installed PWAs on Android; harmless if denied.
if (navigator.storage?.persist) {
  navigator.storage.persist().then((granted) => {
    if (!granted) console.warn('Persistent storage not granted — offline data is evictable');
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
