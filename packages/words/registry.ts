/**
 * @az module registry
 * Purpose: every bundled word's web emitter, by word name, as static imports a bundler can see.
 * Spec: docs/ARCHITECTURE.md §1a · docs/ARCHITECTURE.md §4.3
 * Exports: WEB_EMITTERS
 * Edit guide: a new word adds one import and one map entry; the caller passes this map to the target, which never imports it.
 * Tests: packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/target-web/test/emit.test.ts
 */

/**
 * The web emitters, as a map.
 *
 * Static imports, not a directory scan: a bundler must be able to see every
 * emitter to include it, and `az` has to work in the browser for the API and
 * the playground (ARCHITECTURE §1a). A dynamic `import(path)` would work in
 * the CLI and quietly produce an empty registry everywhere else.
 *
 * The target does NOT import this file. `deps.test.ts` forbids a target from
 * importing a word, so the CALLER passes the registry in — the same shape as
 * `compile(source, { manifests })`. That keeps the dependency arrow
 * `words → core` and never `target → words`.
 */

import type { WordEmitter } from '../core/src/emit-contract.ts';

import * as auth from './auth/emit.web.ts';
import * as chat from './chat/emit.web.ts';
import * as cta from './cta/emit.web.ts';
import * as faq from './faq/emit.web.ts';
import * as feature from './feature/emit.web.ts';
import * as footer from './footer/emit.web.ts';
import * as gallery from './gallery/emit.web.ts';
import * as hero from './hero/emit.web.ts';
import * as nav from './nav/emit.web.ts';
import * as pricing from './pricing/emit.web.ts';
import * as scene from './scene/emit.web.ts';
import * as text from './text/emit.web.ts';

/**
 * Word name to emitter.
 *
 * All twelve words have an emitter. A word missing from this map renders
 * through the target's fallback rather than crashing the build, so an
 * unfinished word degrades visibly (`data-az-unimplemented`) instead of
 * silently dropping a page's navigation.
 */
export const WEB_EMITTERS: Readonly<Record<string, WordEmitter>> = {
  auth, chat, cta, faq, feature, footer, gallery, hero, nav, pricing, scene, text,
};
