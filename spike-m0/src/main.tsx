import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Hero } from './Hero.tsx';
import './style.css';

const el = document.getElementById('root');
if (!el) throw new Error('root element missing from index.html');

const mount = (): Root => {
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <Hero />
    </StrictMode>,
  );
  return root;
};

let root: Root | null = mount();

/**
 * `?az-test=mount` exposes mount/unmount for motion-tiers-spec §8.1 check 2
 * (heap growth across mount/unmount cycles — the dispose() test). Absent the
 * parameter nothing is exposed.
 */
if (new URLSearchParams(window.location.search).get('az-test') === 'mount') {
  Object.assign(window, {
    __azUnmount: () => { root?.unmount(); root = null; },
    __azMount: () => { root ??= mount(); },
  });
}
