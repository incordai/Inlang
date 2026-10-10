/** Types for scripts/gen-words-index.mjs, so the words tests can regenerate and compare. */
export interface WordFolder {
  dir: string;
  manifest: { name: string; description?: string; variants?: string[]; [key: string]: unknown };
  emitter: string;
  previewSource: string;
  files: string[];
}
export declare const ROOT: string;
export declare const INDEX_FILE: string;
export declare const README_FILE: string;
export declare const CATALOGUE_START: string;
export declare const CATALOGUE_END: string;
export declare function loadWords(root?: string): WordFolder[];
export declare function headerFields(src: string): Record<string, string>;
export declare function wordsIndexSource(words?: WordFolder[]): string;
export declare function catalogueSource(words?: WordFolder[]): string;
export declare function withCatalogue(readme: string, words?: WordFolder[]): string;
