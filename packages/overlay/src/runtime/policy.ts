/**
 * The overlay presets as policy — overlays-spec §2's matrix.
 *
 * "Build the engine once. The presets are configuration." This file is that
 * configuration, shared by the compiler (which styles the presets) and the
 * behaviour runtime (which enforces them). It is copied into every generated
 * project, so it imports nothing.
 */

/** The presets Phase 1 ships: nav groups, the mobile menu, and the video popup. */
export const PRESETS = ['dropdown', 'drawer', 'popup'] as const;
export type Preset = (typeof PRESETS)[number];

export interface Policy {
  /** `return`: focus moves in and returns on close. `trap`: it cannot leave. */
  readonly focus: 'return' | 'trap';
  /** `close` on scroll (anchored), or `lock` the page behind a modal. */
  readonly scroll: 'close' | 'lock';
  /** A modal makes everything behind it inert and sits in the top layer. */
  readonly modal: boolean;
}

export const POLICY: Readonly<Record<Preset, Policy>> = {
  // §2: a dropdown must NOT trap — Tab leaves it and carries on down the page.
  dropdown: { focus: 'return', scroll: 'close', modal: false },
  drawer: { focus: 'trap', scroll: 'lock', modal: true },
  popup: { focus: 'trap', scroll: 'lock', modal: true },
};

export const isPreset = (value: string | null | undefined): value is Preset =>
  value !== null && value !== undefined && (PRESETS as readonly string[]).includes(value);
