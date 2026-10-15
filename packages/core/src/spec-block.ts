/**
 * @az module spec-block
 * Purpose: the SpecBlock type — what a word emitter receives.
 * Spec: docs/ARCHITECTURE.md §4.3
 * Exports: SpecBlock, SpecFrom, SpecChat
 * Edit guide: kept dependency-free so an ejected word can copy it.
 * Tests: packages/core/test/compile.test.ts
 */

/**
 * One block of the Spec — what a word's emitter receives.
 *
 * Its own module, with no imports, so the emit contract depends on nothing
 * else in core. That is what lets `az eject` copy the contract beside an
 * ejected word verbatim: the copy must build without the compiler's source.
 */

export interface SpecBlock {
  readonly word: string;
  readonly variant: string | null;
  readonly modifiers: string[];
  /**
   * Positional values, in source order.
   *
   * `link "Work" /work` carries its label and destination here. Without this
   * a child word reached the target as a bare tag with its content dropped —
   * the same bug that lost the site name, one level down.
   */
  readonly args: { kind: string; value: string }[];
  /** Resolved values — defaults applied, so a target never guesses. */
  readonly props: Record<string, string>;
  readonly as: string | null;
  readonly children: SpecBlock[];
  /**
   * `from <table>` (data-spec §10): the block's items load from a table
   * after the page. Absent on every block without it, so such a block
   * serialises exactly as before.
   */
  readonly from?: SpecFrom;
  /**
   * A `chat` block's place in the site (chat-block-spec §4.2): the route its
   * questions are asked from, and where a signed-out visitor signs in.
   * Absent on every other block, so such a block serialises as before.
   */
  readonly chat?: SpecChat;
}

/** What a chat block's emitter needs beyond its props (core/src/chat.ts chatOf). */
export interface SpecChat {
  /** The page the block is on — the server answers only its declared chat pages. */
  readonly route: string;
  /** The site's sign-in page when only signed-in visitors may ask; null otherwise. */
  readonly signin: string | null;
  /**
   * What an answer may hold (chat-block-spec §5.3), when the block lists
   * `show`; absent for a prose-only chat, so it serialises as before.
   */
  readonly answer?: SpecChatAnswer;
}

/** The components a chat's answers may hold, the blocks they may quote, where they may link (core/src/chat.ts). */
export interface SpecChatAnswer {
  /** The `show` words, in the closed list's order: pricing, faq, cta, feature. */
  readonly show: readonly string[];
  /** With `pricing`: every pricing block a signed-out visitor can see, by page and position — the blocks an answer quotes. */
  readonly quotes: readonly { readonly route: string; readonly n: number; readonly block: SpecBlock }[];
  /** With `cta`: the destinations the .az file declares (chat-block-spec §6.2), sorted. */
  readonly destinations: readonly string[];
}

/**
 * A block's data source, checked against the tables at compile time
 * (core/src/from.ts). Every name in it is a validated identifier.
 */
export interface SpecFrom {
  /** The table, by its name in the .az file. */
  readonly table: string;
  /** The slot each row becomes one fill of: `item`, `image`. */
  readonly slot: string;
  /** The mapped prop that is the fill's first value (`item "…"`), if any. */
  readonly label: string | null;
  /** Slot prop → the field it shows, keys sorted. */
  readonly map: Readonly<Record<string, string>>;
  /** Slot prop → that field's data type (`text`, `longtext`), keys sorted. */
  readonly types: Readonly<Record<string, string>>;
  /** `name`, `-created` — as the API's `sort` takes it; null is the server's default. */
  readonly sort: string | null;
  /** Rows per load; the skeleton shows this many. */
  readonly limit: number;
  /** Field → value, equality, as the API takes it (`on`/`off` for a flag); keys sorted. */
  readonly filter: Readonly<Record<string, string>>;
  /** Only the visitor's own rows. */
  readonly mine: boolean;
  /** What the block says when there are no rows. */
  readonly empty: string;
  /** Where a signed-out visitor signs in, when the rows may need it; null otherwise. */
  readonly signin: string | null;
}
