/** Types for scripts/gen-ramps.mjs, so theme tests can regenerate and compare. */
export declare const HUES: Readonly<Record<string, number>>;
export declare const STEPS: readonly number[];
export declare function buildRamps(): Record<string, Record<number, string>>;
export declare function rampsSource(): string;
