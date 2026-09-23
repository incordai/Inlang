/**
 * The opt-in model path's always-loaded half: which model `?az-model=` names,
 * what the path reports, and the boundary that keeps the poster up on failure.
 *
 * The loader itself (model.tsx) is imported lazily, so the procedural default
 * — which is what almost every visit renders — never downloads GLTFLoader or
 * DRACOLoader (PRD §9: 3D weight is paid only by what uses it).
 *
 * `?az-model=sample` opts in. Only names in MODELS are accepted, so the query
 * string can never point the loader at an arbitrary URL.
 */

import { Component, type ReactNode } from 'react';

/** The models the spike can load, by the name `?az-model=` takes. */
const MODELS: Readonly<Record<string, string>> = {
  sample: 'models/sample.glb',
};

/** The model URL `?az-model=` names, or null for the procedural default. */
export function readModelUrl(search: string = window.location.search): string | null {
  const name = new URLSearchParams(search).get('az-model');
  const path = name && Object.prototype.hasOwnProperty.call(MODELS, name) ? MODELS[name] : undefined;
  return path ? `${import.meta.env.BASE_URL}${path}` : null;
}

/** What the model path reports, read by scripts/model.test.ts. */
export interface ModelReport {
  url: string;
  state: 'loading' | 'ready' | 'failed';
  /** performance.now() when the model was drawable. */
  readyMs: number | null;
  triangles: number;
  error: string | null;
}

declare global {
  interface Window { __AZ_MODEL__?: ModelReport }
}

/** Publish the model path's state for scripts/model.test.ts. */
export function reportModel(report: ModelReport): void {
  window.__AZ_MODEL__ = report;
}

/** A load or render failure, in the report's shape. */
export function reportFailure(url: string, error: unknown): void {
  reportModel({ url, state: 'failed', readyMs: null, triangles: 0,
    error: error instanceof Error ? error.message : String(error) });
}

/**
 * A render-time failure on the model path — including the lazy chunk failing
 * to load — must leave the poster in place rather than an empty canvas. Load
 * failures are caught in the loader itself and reported the same way.
 */
export class ModelBoundary extends Component<
  { url: string; onFail: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    this.props.onFail(error);
  }
  render() { return this.state.failed ? null : this.props.children; }
}
