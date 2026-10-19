/**
 * @az module figures
 * Purpose: what a data source answers a `from` request with — figures, rows, cards or a map's pins — as the answer checker fills a component from it.
 * Spec: docs/chat-block-spec.md §20.5, §20.6, §21.3, §21.4.2
 * Exports: Figures, RowsResult, CardImage, CardsResult, PinsResult
 * Edit guide: types only; the server's reader of its own tables (chat-query.ts) and an app's data source both answer in these shapes.
 * Tests: packages/chat-answer/test/checker.test.ts, packages/backend/test/chat-query.test.ts
 */

/**
 * A `from …` request in an answer (`chart bar "Orders" from orders count by
 * status`) is answered by whoever holds the data: the built-in server reads
 * its public tables (chat-query.ts); an app passes its own data source to the
 * checker. Either way the answer comes back in one of these shapes, and the
 * checker (chat-rich.ts resolveRich) turns it into the component the page
 * draws, marked `src: site`. Moved here from the server's chat-query.ts.
 */

/** One number, or groups in display order, with the unit the measure carries. */
export interface Figures {
  readonly kind: 'figures';
  readonly unit: string | null;
  readonly value: number | null;
  readonly groups: readonly (readonly [string, number])[] | null;
  /** More groups existed than were read. */
  readonly more: boolean;
  /** The grouping was by date: groups run oldest to newest. */
  readonly dated: boolean;
}

export interface RowsResult {
  readonly kind: 'rows';
  /** `date`: a `YYYY-MM-DD` day (a date, or a datetime's UTC day) — an explore compares them (§21.3); a table shows them as text. */
  readonly columns: readonly { readonly label: string; readonly type: 'text' | 'number' | 'date'; readonly unit: string | null }[];
  readonly rows: readonly (readonly (string | number | null)[])[];
}

export interface CardImage { readonly url: string; readonly width: number; readonly height: number; readonly variants: readonly { readonly url: string; readonly width: number }[] }

export interface CardsResult {
  readonly kind: 'cards';
  readonly items: readonly { readonly title: string; readonly text: string | null; readonly image: CardImage | null; readonly row: { readonly table: string; readonly id: string; readonly field: string } | null }[];
}

/** A map's pins from a table (§21.4.2): each row with a label and both coordinates in range, read from millionths of a degree. */
export interface PinsResult {
  readonly kind: 'pins';
  readonly pins: readonly { readonly label: string; readonly lat: number; readonly lon: number }[];
}
