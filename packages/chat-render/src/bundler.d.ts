/**
 * The two bundler imports the map runtime uses (overlay runtime
 * chat-map-gl.ts), declared as the site's bundler declares them in a
 * generated project (its `vite/client` types): a file's URL by `?url`, and a
 * stylesheet imported for its effect. Only the type-check of this package
 * reads this file; it is not runtime code and is never copied into a site.
 */

declare module '*?url' {
  const src: string;
  export default src;
}

declare module '*.css' {}
