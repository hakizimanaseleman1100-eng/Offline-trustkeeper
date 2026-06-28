import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';   // ← THIS LINE loads Tailwind. Without it, nothing is styled.
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);