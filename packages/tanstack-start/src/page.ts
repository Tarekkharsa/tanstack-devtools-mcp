import type { PageSource } from '@loopsight/core/page'

const SERVER_FN = /\/_serverFn\/([A-Za-z0-9_-]{16,})$/

/**
 * TanStack Start's dev server names a server function in its URL as base64
 * JSON. Read it back, so the log says which function was called.
 */
export function serverFnName(
  pathname: string,
): { name: string; file?: string } | undefined {
  const match = SERVER_FN.exec(pathname)
  if (!match) return undefined
  try {
    const decoded = JSON.parse(atob(match[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof decoded?.export !== 'string') return undefined
    const file =
      typeof decoded.file === 'string'
        ? decoded.file.split('?')[0].replace(/^\//, '')
        : undefined
    return {
      name: decoded.export.replace(/_createServerFn_handler$/, ''),
      ...(file ? { file } : {}),
    }
  } catch {
    // A production build uses an opaque id; the URL is shown as it is.
    return undefined
  }
}

function cut(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}…(+${text.length - chars} chars)`
}

/**
 * TanStack Start, seen from the page. It needs no instance: it only names
 * the server function behind each `/_serverFn/...` request, so the network
 * log reads `serverFn getCart` instead of an opaque id.
 */
const source: PageSource = {
  key: 'start',
  attach: (_instance, { network }) => ({
    stop: network.annotate((url, sameOrigin) => {
      if (!sameOrigin) return undefined
      const fn = serverFnName(url.pathname)
      if (!fn) return undefined
      return {
        key: `serverFn:${fn.name}`,
        shown: `serverFn ${fn.name}${fn.file ? ` (${fn.file})` : ''}${url.search ? ` ${cut(url.search, 60)}` : ''}`,
      }
    }),
  }),
}

export default source
