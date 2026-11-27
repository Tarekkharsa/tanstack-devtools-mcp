import { createServer as createHttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'vite'
import { Hub, collect, diagnose, startServer } from '@loopsight/core/server'
import { otelServerSource } from '@loopsight/otel'
import { loopsight } from 'loopsight/vite'
import type { AddressInfo } from 'node:net'
import type { LogEntry, Session } from '@loopsight/core/server'

const closers: Array<() => unknown> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** A page that has connected and reports whatever the test tells it to. */
function page(hub: Hub, id = 'page-1') {
  let hear: (text: string) => void = () => {}
  hub.attach({ send: () => {}, onMessage: (listener) => (hear = listener), onClose: () => {} })
  const say = (message: unknown) => hear(JSON.stringify(message))
  say({ kind: 'hello', session: { id, url: 'http://localhost/', title: 'App', startedAt: Date.now(), has: {}, tools: [] } })
  let seq = 0
  return {
    session: hub.sessions.get(id)!,
    /** The page finished a request the host had tagged. */
    requested(summary: string, tag: string, more: Partial<LogEntry> = {}) {
      say({
        kind: 'entries',
        entries: [{ seq: ++seq, t: Date.now(), source: 'network', type: 'ok', summary, detail: { kind: 'fetch', status: 200, tag }, ...more }],
      })
    },
  }
}

const T0 = 1_800_000_000_000
let nextSpan = 1
const hex = (n: number, width: number) => n.toString(16).padStart(width, '0')

interface Made {
  name: string
  at: number
  ms: number
  kind?: number
  error?: string
  attrs?: Record<string, string | number | boolean>
  children?: Array<Made>
}

/** One trace as an OTLP/HTTP JSON export, from a tree of spans. */
function exported(traceId: string, root: Made) {
  const spans: Array<unknown> = []
  const add = (span: Made, parent?: string) => {
    const spanId = hex(nextSpan++, 16)
    spans.push({
      traceId,
      spanId,
      ...(parent ? { parentSpanId: parent } : {}),
      name: span.name,
      kind: span.kind ?? 1,
      startTimeUnixNano: String((T0 + span.at) * 1e6),
      endTimeUnixNano: String((T0 + span.at + span.ms) * 1e6),
      attributes: Object.entries(span.attrs ?? {}).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? { stringValue: value } : typeof value === 'boolean' ? { boolValue: value } : { intValue: value },
      })),
      status: span.error ? { code: 2, message: span.error } : { code: 1 },
    })
    for (const child of span.children ?? []) add(child, spanId)
  }
  add(root)
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] }
}

const call = (path: string, at: number, ms: number, status: number): Made => ({
  name: 'POST',
  at,
  ms,
  kind: 3,
  ...(status >= 400 ? { error: `StatusCode error (${status})` } : {}),
  attrs: { 'http.request.method': 'POST', 'url.full': `https://pricing.example${path}?secret=1`, 'http.response.status_code': status },
})

async function running() {
  const server = await startServer({ port: 0, sources: [otelServerSource] })
  closers.push(() => server.close())
  const post = (signal: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}/v1/${signal}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  return { hub: server.hub, post }
}

const serverEntries = (session: Session) => session.entries.filter((entry) => entry.source === 'server')
const tool = otelServerSource.tools![0]!
const explain = (session: Session, hub: Hub, n?: number): any =>
  tool.run({ n }, { session, hub, actions: false, call: () => Promise.reject(new Error('no page')) })

describe('the server, from what it exports', () => {
  it('ties a trace to the request the page made, by the trace id the host gave it', async () => {
    const { hub, post } = await running()
    const tab = page(hub)
    const tag = hub.tag({ method: 'GET', url: '/api/cart' })
    tab.requested('GET /api/cart → 200', tag, { dur: 1900 })

    const answer = await post(
      'traces',
      exported(tag, {
        name: 'cart.load',
        at: 0,
        ms: 1850,
        children: [
          { name: 'Prices.quote', at: 2, ms: 400, children: [call('/v1/quote', 3, 390, 400)] },
          { name: 'Prices.quote', at: 2, ms: 1800, children: [call('/v1/quote', 3, 1790, 200)] },
          { name: 'Stock.check', at: 5, ms: 150, attrs: { 'effect.fiber.interrupted': true } },
        ],
      }),
    )
    expect(answer.status).toBe(200)
    await expect.poll(() => serverEntries(tab.session).length).toBe(1)
    const [entry] = serverEntries(tab.session)
    expect(entry).toMatchObject({
      type: 'trace',
      key: 'cart.load',
      dur: 1850,
      summary: 'cart.load took 1850 ms on the server: 2 outbound calls, 1 failed, 1 cut short (for #1)',
      detail: { request: 1, calls: 2, failed: 1, cut: 1 },
    })
    // The query string of an outbound call is never kept.
    expect(JSON.stringify(entry)).not.toContain('secret')

    expect(explain(tab.session, hub)).toMatchObject({
      request: { n: 1, summary: 'GET /api/cart → 200' },
      traces: [
        {
          tree: [
            'cart.load 1850 ms',
            '  Prices.quote 400 ms +2',
            '    POST 390 ms +3 → POST pricing.example/v1/quote 400 FAILED: StatusCode error (400)',
            '  Prices.quote 1800 ms +2',
            '    POST 1790 ms +3 → POST pricing.example/v1/quote 200',
            '  Stock.check 150 ms +5 (stopped before finishing)',
          ],
        },
      ],
    })

    const found = diagnose(tab.session.entries, null, 0, collect([otelServerSource])).findings
    expect(found.map((finding) => [finding.rule, finding.severity, finding.title])).toEqual([
      ['server/failed-behind-success', 'warning', '1 call out of the server failed behind 1 answer the page took as a success'],
      ['server/cut-short', 'info', '1 piece of server work was stopped before finishing'],
      ['server/where-the-time-went', 'info', 'Where the server spent the time on its slowest answer'],
    ])
    expect(found[0]!.evidence).toEqual(['cart.load: POST pricing.example/v1/quote → 400'])
    expect(found[2]!.evidence).toEqual([
      '1850 ms for GET /api/cart: cart.load › Prices.quote › POST (POST pricing.example/v1/quote) 1790 ms',
    ])
  })

  it('ties records to a request by the id the server was sent, and waits for the page to report it', async () => {
    const { hub, post } = await running()
    const tab = page(hub)
    const tag = hub.tag({ method: 'GET', url: '/orders' })
    // The server tells first: the document is rendered before its page exists.
    await post('traces', exported('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { name: 'orders.page', at: 0, ms: 40, attrs: { 'request.inbound_id': tag } }))
    await post('logs', {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: String(T0 * 1e6), severityNumber: 13, severityText: 'WARN', body: { stringValue: 'recommendations unavailable' }, traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', attributes: [{ key: 'reason', value: { stringValue: 'timeout' } }] },
                { timeUnixNano: String(T0 * 1e6), severityNumber: 9, severityText: 'INFO', body: { stringValue: 'served' }, traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
              ],
            },
          ],
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(serverEntries(tab.session)).toEqual([])

    tab.requested('GET /orders → 200 (the document; first byte after 60 ms)', tag, {
      type: 'document',
      detail: { kind: 'document', status: 200, wait: 60, tag },
    })
    await expect.poll(() => serverEntries(tab.session).length, { timeout: 3000 }).toBe(2)
    expect(serverEntries(tab.session).map((entry) => entry.summary).sort()).toEqual([
      'WARN recommendations unavailable (for #1)',
      'orders.page took 40 ms on the server: 1 span (for #1)',
    ])
    const found = diagnose(tab.session.entries, null, 0, collect([otelServerSource])).findings
    expect(found).toMatchObject([
      {
        rule: 'server/logged',
        severity: 'warning',
        title: 'The server logged 1 distinct warning or error while answering this page',
        evidence: ['WARN recommendations unavailable'],
      },
    ])
    expect(explain(tab.session, hub, 1).logs).toMatchObject([
      { summary: 'WARN recommendations unavailable', fields: { reason: 'timeout' } },
    ])
  })

  it('says whether slow server work held the document up or was streamed in after it', async () => {
    const { hub, post } = await running()
    const tab = page(hub)
    const tag = hub.tag({ method: 'GET', url: '/product' })
    tab.requested('GET /product → 200 (the document; first byte after 420 ms)', tag, {
      type: 'document',
      detail: { kind: 'document', status: 200, wait: 420, tag },
    })
    await post('traces', exported(tag, { name: 'page.shell', at: 0, ms: 1200, attrs: { part: 'shell' } }))
    await post('traces', exported('dddddddddddddddddddddddddddddddd', { name: 'page.offers', at: 0, ms: 5300, attrs: { 'request.inbound_id': tag } }))
    await expect.poll(() => serverEntries(tab.session).length).toBe(2)
    const [finding] = diagnose(tab.session.entries, null, 0, collect([otelServerSource])).findings
    expect(finding).toMatchObject({ rule: 'server/where-the-time-went' })
    expect(finding!.evidence).toEqual([
      '5300 ms for the document (streamed in after its first byte at 420 ms): page.offers 5300 ms',
      '1200 ms for the document (streamed in after its first byte at 420 ms): page.shell 1200 ms',
    ])
  })

  it('tells steps that wait on each other from the same call made over and over', async () => {
    const { hub, post } = await running()
    const tab = page(hub)
    const steps = hub.tag({ method: 'GET', url: '/a' })
    const repeats = hub.tag({ method: 'GET', url: '/b' })
    tab.requested('GET /a → 200', steps)
    tab.requested('GET /b → 200', repeats)
    await post('traces', exported(steps, {
      name: 'page.load', at: 0, ms: 1000,
      children: [
        { name: 'Cms.resolve', at: 1, ms: 500 },
        { name: 'Cms.page', at: 502, ms: 490 },
      ],
    }))
    await expect.poll(() => serverEntries(tab.session).length).toBe(1)
    expect(diagnose(tab.session.entries, null, 0, collect([otelServerSource])).findings[0]).toMatchObject({
      rule: 'server/one-after-another',
      severity: 'info',
      evidence: ['page.load › page.load: Cms.resolve 500 ms, then Cms.page 490 ms'],
    })

    await post('traces', exported(repeats, {
      name: 'list.load', at: 0, ms: 1300,
      children: [0, 1, 2, 3].map((index) => ({ name: 'Items.one', at: 1 + index * 300, ms: 290, attrs: { 'graphql.operation.name': 'Item' } })),
    }))
    await expect.poll(() => serverEntries(tab.session).length).toBe(2)
    expect(diagnose(tab.session.entries, null, 0, collect([otelServerSource])).findings[0]).toMatchObject({
      rule: 'server/one-after-another',
      severity: 'warning',
      title: 'The server made the same call 4 times, one after another',
      evidence: [
        'list.load › list.load: 4× Items.one (Item), 1160 ms in all',
        'page.load › page.load: Cms.resolve 500 ms, then Cms.page 490 ms',
      ],
    })
  })

  it('shows a shared load under the step that waited on it, though it is a trace of its own', async () => {
    const { hub, post } = await running()
    const tab = page(hub)
    const tag = hub.tag({ method: 'GET', url: '/sitemap' })
    tab.requested('GET /sitemap → 200', tag)
    // A cache loads once for every reader, so the load belongs to none of them.
    await post('traces', exported('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', {
      name: 'Graphql.execute', at: 5, ms: 2990, attrs: { 'graphql.operation.name': 'Sitemap' },
      children: [call('/graphql', 6, 2980, 200)],
    }))
    await post('traces', exported('cccccccccccccccccccccccccccccccc', { name: 'Unrelated.job', at: 4000, ms: 900 }))
    await post('traces', exported(tag, {
      name: 'sitemap.page', at: 0, ms: 3000,
      children: [{ name: 'Cms.sitemap', at: 1, ms: 2998 }],
    }))
    await expect.poll(() => serverEntries(tab.session).length).toBe(1)
    expect(explain(tab.session, hub).traces[0].tree).toEqual([
      'sitemap.page 3000 ms',
      '  Cms.sitemap 2998 ms +1',
      '    ~ Graphql.execute (Sitemap) 2990 ms +5',
      '      ~ POST 2980 ms +6 → POST pricing.example/graphql 200',
      '~ marks work from another trace that ran while the step above it waited: placed by its timing.',
    ])
    expect(diagnose(tab.session.entries, null, 0, collect([otelServerSource])).findings).toMatchObject([
      {
        rule: 'server/where-the-time-went',
        evidence: [
          '3000 ms for GET /sitemap: sitemap.page › Cms.sitemap › ~Graphql.execute › ~POST (POST pricing.example/graphql) 2980 ms',
        ],
      },
    ])
  })

  it('says why a request the page saw fail went wrong', async () => {
    const { hub, post } = await running()
    const tab = page(hub)
    const tag = hub.tag({ method: 'POST', url: '/api/pay' })
    tab.requested('POST /api/pay → 500', tag, { type: 'error', problem: true })
    await post('traces', exported(tag, {
      name: 'pay', at: 0, ms: 30, error: 'failed',
      children: [{ name: 'Ledger.write', at: 1, ms: 20, error: 'duplicate key "order_id"' }],
    }))
    await expect.poll(() => serverEntries(tab.session).length).toBe(1)
    // Next to the core's own "1 failed requests", which cannot say why.
    const found = diagnose(tab.session.entries, null, 0, collect([otelServerSource])).findings
    expect(found.find((finding) => finding.rule === 'server/why-it-failed')).toMatchObject({
      severity: 'error',
      entries: [1, 2],
      evidence: ['POST /api/pay → 500', 'Ledger.write: duplicate key "order_id"'],
    })
  })

  it('refuses a page, takes metrics without keeping them, and asks for JSON', async () => {
    const { hub, post } = await running()
    expect(otelServerSource.tagRequests!(hub)).toBe(false)
    expect((await post('traces', {}, { origin: 'http://localhost:5173' })).status).toBe(404)
    expect((await post('traces', {}, { 'content-type': 'application/x-protobuf' })).status).toBe(415)
    expect(otelServerSource.tagRequests!(hub)).toBe(false)
    expect((await post('metrics', { resourceMetrics: [] })).status).toBe(200)
    // Something exports here now, so requests are worth tagging.
    expect(otelServerSource.tagRequests!(hub)).toBe(true)
  })
})

describe('the Vite host tagging requests', () => {
  it('names each request to the app both ways once a server exports, and leaves the rest alone', async () => {
    const seen: Array<Record<string, unknown>> = []
    let vite: Awaited<ReturnType<typeof createServer>> | undefined
    const app = createHttpServer((request, response) => {
      vite!.middlewares(request, response, () => {
        seen.push({ url: request.url, id: request.headers['x-request-id'], parent: request.headers.traceparent })
        response.setHeader('Server-Timing', 'db;dur=5')
        response.end('ok')
      })
    })
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
    const port = (app.address() as AddressInfo).port
    closers.push(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve) }))
    vite = await createServer({
      configFile: false,
      root: import.meta.dirname,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: { server: app }, ws: false },
      plugins: [loopsight({ port: 47993 })],
    })
    closers.push(() => vite!.close())
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers })

    // Nothing exports yet: the request passes as it came.
    expect((await get('/api/cart')).headers.get('server-timing')).toBe('db;dur=5')
    expect(seen.at(-1)).toEqual({ url: '/api/cart', id: undefined, parent: undefined })

    await fetch('http://127.0.0.1:47993/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const answer = await get('/api/cart?x=1')
    const { id, parent } = seen.at(-1) as { id: string; parent: string }
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(parent).toBe(`00-${id}-${id.slice(0, 16)}-01`)
    // The app's own timing entry is kept beside the tag.
    expect(answer.headers.get('server-timing')).toBe(`db;dur=5, loopsight;desc="${id}"`)

    // An id the client sent is kept, and a stylesheet or a module is not the app's.
    await get('/api/cart', { 'x-request-id': 'from-the-client' })
    expect(seen.at(-1)).toMatchObject({ id: 'from-the-client' })
    await get('/styles.css', { 'sec-fetch-dest': 'style' })
    expect(seen.at(-1)).toMatchObject({ url: '/styles.css', id: undefined })
  })
})
