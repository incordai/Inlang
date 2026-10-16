/** Types for self-signed.mjs, so a TypeScript test can import it. */

/** `{ key, cert }` as PEM for `localhost` and 127.0.0.1, valid for a day; a new key every call. */
export function selfSignedCert(now?: number): { readonly key: string; readonly cert: string };

/** A DER INTEGER (tag, length, value) for unsigned big-endian bytes, in minimal form. */
export function derInteger(bytes: Uint8Array): Buffer;
