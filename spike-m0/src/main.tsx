import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Hero } from './Hero.tsx';
import './style.css';

const el = document.getElementById('root');
if (!el) throw new Error('root element missing from index.html');
createRoot(el).render(
  <StrictMode>
    <Hero />
  </StrictMode>,
);
