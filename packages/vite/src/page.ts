/**
 * What a page served by Vite should not count as the app's own. Plain data,
 * safe to import in the browser: the plugin puts it in the entry it
 * generates, and an app that calls `connect` itself can pass it along.
 */

/** Stack frames in Vite's own modules, as regular expression sources. */
export const VITE_FRAMES: ReadonlyArray<string> = [
  '/@id/',
  '/@vite/',
  '/@fs/',
  '/@react-refresh',
  '/\\.vite/',
]

/** Same-origin requests Vite's client makes, likewise. */
export const VITE_REQUESTS: ReadonlyArray<string> = [
  '^/(?:@vite|@id|@fs|@react-refresh|__vite|node_modules/\\.vite)',
]
