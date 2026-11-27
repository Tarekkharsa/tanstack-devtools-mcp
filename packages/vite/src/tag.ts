import { TAG_TIMING } from '@loopsight/core/server'
import { VITE_REQUESTS } from './page.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Hub, ServerSource } from '@loopsight/core/server'
import type { ViteDevServer } from 'vite'

const OWN = VITE_REQUESTS.map((source) => new RegExp(source))
const TAG_SHAPE = /^[\w.-]{1,128}$/

/**
 * Whether a request is one the app's server answers: the document, or a
 * call the page makes from code. Modules, styles, images and fonts are the
 * dev server's and the browser's own business.
 */
function forTheApp(request: IncomingMessage): boolean {
  if (request.headers.upgrade !== undefined) return false
  const destination = request.headers['sec-fetch-dest']
  if (destination !== undefined && destination !== 'document' && destination !== 'empty') {
    return false
  }
  const path = (request.url ?? '/').split('?')[0]!
  return !path.includes('/__loopsight/') && !OWN.some((pattern) => pattern.test(path))
}

function withTag(current: unknown, tag: string): string {
  const ours = `${TAG_TIMING};desc="${tag}"`
  const existing = Array.isArray(current) ? current.join(', ') : typeof current === 'string' ? current : ''
  if (existing.includes(`${TAG_TIMING};`)) return existing
  return existing ? `${existing}, ${ours}` : ours
}

/**
 * Tags each request on its way to the app's server, for as long as a source
 * asks for it. The tag goes to the server as `x-request-id` and, for servers
 * that follow the W3C trace context, as the trace id of a `traceparent`; it
 * comes back to the page in `Server-Timing`. Nothing a client already sent is
 * replaced.
 */
export function tagRequests(
  server: ViteDevServer,
  hub: Hub,
  sources: () => ReadonlyArray<ServerSource>,
  /** True when the app is already set to send its records here. */
  expected: () => boolean,
): void {
  const handle = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    try {
      const wanted = sources().some(
        (source) => source.tagRequests !== undefined && (expected() || source.tagRequests(hub)),
      )
      if (wanted && forTheApp(request)) {
        const sent = request.headers['x-request-id']
        const kept = typeof sent === 'string' && TAG_SHAPE.test(sent) ? sent : undefined
        const tag = hub.tag({ method: request.method ?? 'GET', url: request.url ?? '/' }, kept)
        if (kept === undefined) {
          request.headers['x-request-id'] = tag
          request.rawHeaders.push('x-request-id', tag)
        }
        if (request.headers.traceparent === undefined && /^[0-9a-f]{32}$/.test(tag)) {
          const parent = `00-${tag}-${tag.slice(0, 16)}-01`
          request.headers.traceparent = parent
          request.rawHeaders.push('traceparent', parent)
        }
        response.setHeader('Server-Timing', withTag(undefined, tag))
        // The app may set the header itself after this; keep both.
        const setHeader = response.setHeader.bind(response)
        response.setHeader = ((name: string, value: number | string | ReadonlyArray<string>) =>
          setHeader(
            name,
            name.toLowerCase() === 'server-timing' ? withTag(value, tag) : value,
          )) as typeof response.setHeader
      }
    } catch {
      // The request goes on untouched whatever happens here.
    }
    next()
  }
  // Ahead of everything that answers, whatever order the plugins came in:
  // a server framework's own middleware would otherwise answer first.
  const stack = (server.middlewares as unknown as { stack: Array<{ route: string; handle: unknown }> }).stack
  stack.unshift({ route: '', handle })
}

/** Whether an environment variable already points something at this address. */
export function pointedHere(port: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const here = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  return Object.values(env).some(
    (value) => typeof value === 'string' && here.some((address) => value.includes(address)),
  )
}
