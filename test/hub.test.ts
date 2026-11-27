import { describe, expect, it } from 'vitest'
import { appFrames, parseStack } from '../src/client/stack.js'
import { diagnose } from '../src/server/diagnose.js'
import { Hub } from '../src/server/hub.js'
import type { Connection } from '../src/server/hub.js'
import type { LogEntry, PageMessage } from '../src/protocol.js'

function page(hub: Hub, id: string) {
  const listeners: Array<(text: string) => void> = []
  const closers: Array<() => void> = []
  const connection: Connection = {
    send: () => {},
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener),
  }
  hub.attach(connection)
  const send = (message: PageMessage) => listeners.forEach((l) => l(JSON.stringify(message)))
  send({
    kind: 'hello',
    session: { id, url: 'http://localhost/', title: '', startedAt: 0, has: { query: false, router: false }, tools: [] },
  })
  return { send, close: () => closers.forEach((close) => close()) }
}

describe('Hub', () => {
  it('numbers entries itself and puts server entries on every open session', () => {
    const hub = new Hub()
    const a = page(hub, 'a')
    const b = page(hub, 'b')
    a.send({ kind: 'entries', entries: [{ seq: 7, t: 1, source: 'console', type: 'warn', summary: 'from a' }] })
    b.close()
    hub.recordServer({ source: 'vite', type: 'hmr-update', summary: 'hot update: src/a.tsx' })

    expect(hub.sessions.get('a')!.entries.map((e) => [e.n, e.summary])).toEqual([
      [1, 'from a'],
      [2, 'hot update: src/a.tsx'],
    ])
    expect(hub.sessions.get('a')!.pageSeq).toBe(7)
    expect(hub.sessions.get('b')!.entries).toEqual([])
  })

  it('defaults to the newest open page that has something to inspect', async () => {
    const hub = new Hub()
    const app = page(hub, 'app')
    app.send({ kind: 'meta', patch: { has: { query: true, router: true } } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Connected later, with no router or client: an embedded frame, say.
    const bare = page(hub, 'bare')
    expect(hub.resolve().info.id).toBe('app')
    app.close()
    expect(hub.resolve().info.id).toBe('bare')
    bare.close()
    expect(hub.resolve().info.id).toBe('bare')
    expect(hub.resolve('app').info.id).toBe('app')
  })

  it('greets a new page with what the dev server just did', () => {
    const hub = new Hub()
    hub.recordServer({ source: 'vite', type: 'full-reload', summary: 'full reload' })
    hub.recent[0]!.t -= 60_000
    hub.recordServer({ source: 'vite', type: 'full-reload', summary: 'full reload triggered by src/b.tsx' })
    page(hub, 'next')
    expect(hub.sessions.get('next')!.entries.map((e) => e.summary)).toEqual([
      'full reload triggered by src/b.tsx',
    ])
  })

  it('turns frames into source places, and says when it could not', async () => {
    const frames = [
      { fn: 'loadPost', url: 'http://localhost:5173/src/post.tsx?t=1', line: 40, column: 9 },
      { url: 'http://localhost:5173/src/other.tsx', line: 2, column: 1 },
    ]
    const mapped = new Hub({
      resolveFrame: (frame) =>
        frame.url.includes('post') ? `${frame.fn} src/post.tsx:12:5` : undefined,
    })
    expect(await mapped.resolveFrames(frames)).toEqual([
      'loadPost src/post.tsx:12:5',
      'src/other.tsx:2:1 (served code)',
    ])
    const throwing = new Hub({
      resolveFrame: () => {
        throw new Error('no map')
      },
    })
    expect(await throwing.resolveFrames(frames.slice(0, 1))).toEqual([
      'loadPost src/post.tsx:40:9 (served code)',
    ])

    const hub = new Hub({ resolveFrame: () => 'App src/App.tsx:3:1' })
    const p = page(hub, 'a')
    p.send({
      kind: 'entries',
      entries: [{ seq: 1, t: 1, source: 'console', type: 'error', summary: 'x', frames: frames.slice(0, 1) }],
    })
    await expect.poll(() => hub.sessions.get('a')!.entries[0]!.at).toEqual(['App src/App.tsx:3:1'])
    expect(hub.sessions.get('a')!.entries[0]).not.toHaveProperty('frames')
  })
})

describe('stack frames', () => {
  it('reads Chrome and Firefox traces and keeps only the app frames', () => {
    const chrome = `Error
    at here (http://localhost:5173/@id/__x00__tanstack-devtools-mcp:client/stack.js:30:5)
    at useBaseQuery (http://localhost:5173/node_modules/.vite/deps/@tanstack_react-query.js?v=1:3000:20)
    at usePosts (http://localhost:5173/src/hooks/posts.ts?t=17:8:10)
    at async Posts (http://localhost:5173/src/routes/posts.tsx:21:16)
    at http://localhost:5173/src/main.tsx:5:1
    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js:11000:1)`
    expect(appFrames(chrome)).toEqual([
      { fn: 'usePosts', url: 'http://localhost:5173/src/hooks/posts.ts?t=17', line: 8, column: 10 },
      { fn: 'Posts', url: 'http://localhost:5173/src/routes/posts.tsx', line: 21, column: 16 },
      { url: 'http://localhost:5173/src/main.tsx', line: 5, column: 1 },
    ])
    const firefox = `usePosts@http://localhost:5173/src/hooks/posts.ts:8:10
@http://localhost:5173/src/main.tsx:5:1`
    expect(parseStack(firefox)).toEqual([
      { fn: 'usePosts', url: 'http://localhost:5173/src/hooks/posts.ts', line: 8, column: 10 },
      { url: 'http://localhost:5173/src/main.tsx', line: 5, column: 1 },
    ])
    expect(appFrames(undefined)).toEqual([])
  })
})

describe('diagnose', () => {
  let n = 0
  const entry = (partial: Partial<LogEntry> & Pick<LogEntry, 'source' | 'type' | 'summary'>): LogEntry => ({
    n: ++n,
    t: 1_000_000 + n * 100,
    ...partial,
  })

  it('finds nothing wrong in a quiet log', () => {
    const result = diagnose(
      [
        entry({ source: 'query', type: 'fetch', key: '["a"]', summary: '["a"] fetching' }),
        entry({ source: 'query', type: 'success', key: '["a"]', summary: '["a"] success', dur: 40 }),
        entry({ source: 'console', type: 'warn', summary: 'deprecated' }),
      ],
      { router: {}, query: { errors: [] } },
    )
    expect(result).toEqual({ ok: true, findings: [], checked: 3 })
  })

  it('reports each kind of problem with its evidence', () => {
    const loop = Array.from({ length: 5 }, () =>
      entry({ source: 'query', type: 'fetch', key: '["rates"]', summary: '["rates"] refetching', at: ['Rates src/rates.tsx:9:3'] }),
    )
    // Each takes 500 ms and they finish 100 ms apart: all three overlap.
    const twice = Array.from({ length: 3 }, () =>
      entry({ source: 'network', type: 'ok', key: '/api/me', summary: 'GET /api/me → 200', dur: 500 }),
    )
    const result = diagnose(
      [
        ...loop,
        ...twice,
        entry({ source: 'network', type: 'error', key: '/api/cart', summary: 'POST /api/cart → 500', dur: 2500 }),
        entry({ source: 'console', type: 'uncaught', summary: "TypeError: Cannot read properties of undefined (reading 'id')", at: ['Cart src/Cart.tsx:14:22'] }),
        entry({ source: 'console', type: 'error', summary: 'Hydration failed because the server rendered HTML did not match' }),
        entry({ source: 'console', type: 'error', summary: 'socket closed' }),
        entry({ source: 'mutation', type: 'error', summary: '["checkout"] error: Error: declined' }),
        entry({ source: 'router', type: 'onResolved', summary: '/ → /slow', dur: 2400 }),
        entry({ source: 'vite', type: 'hmr-update', summary: 'hot update: src/a.tsx' }),
      ],
      {
        router: { error: '/cart: Error: boom' },
        query: { errors: [{ queryHash: '["cart"]', error: 'Error: 500' }] },
      },
      12,
    )
    expect(result.ok).toBe(false)
    expect(result.findings.map((f) => `${f.severity}: ${f.title}`)).toEqual([
      'error: Hydration mismatch between the server render and the client',
      'error: Uncaught error',
      'error: A matched route is showing an error',
      'error: 1 query is in the error state',
      'error: 1 failed mutation',
      'error: 1 failed requests',
      'warning: console.error called with 1 distinct message',
      'warning: A query fetched 5 times within 10 s',
      'warning: The same request was in flight 3 times at once',
      'info: Slowest navigations, queries and requests',
      'info: The log dropped its 12 oldest entries',
    ])
    const uncaught = result.findings[1]!
    expect(uncaught.evidence[0]).toMatch(/reading 'id'\) — from Cart src\/Cart\.tsx:14:22$/)
    expect(result.findings[7]!.evidence).toEqual(['["rates"] — from Rates src/rates.tsx:9:3'])
    expect(result.findings[9]!.evidence).toEqual([
      '2400 ms navigation: / → /slow',
      '2500 ms request: POST /api/cart → 500',
    ])
  })

  it('plays down the error a cross-origin script hides', () => {
    const [finding] = diagnose(
      [entry({ source: 'console', type: 'uncaught', summary: 'Script error.' })],
      null,
    ).findings
    expect(finding).toMatchObject({ severity: 'warning', title: 'Uncaught error' })
    expect(finding!.hint).toMatch(/another origin/)
  })

  it('treats a build error as fixed once an update succeeds after it', () => {
    const broken = [entry({ source: 'vite', type: 'error', summary: 'build error in src/a.tsx:1:1: Unexpected token' })]
    expect(diagnose(broken, null).findings[0]!.title).toMatch(/build error/)
    const fixed = [...broken, entry({ source: 'vite', type: 'hmr-update', summary: 'hot update: src/a.tsx' })]
    expect(diagnose(fixed, null).ok).toBe(true)
  })

  it('compares whole URLs, not the shortened text, when the page fingerprints them', () => {
    const call = (id: string) =>
      entry({
        source: 'network',
        type: 'ok',
        key: 'serverFn:getOffers',
        summary: 'GET serverFn getOffers ?payload=%7B%22t%22…(+700 chars) → 200',
        dur: 500,
        detail: { kind: 'fetch', status: 200, id },
      })
    // Same visible text, different URLs: two rails asking for different things.
    expect(diagnose([call('GET aaa.900'), call('GET bbb.900')], null).findings).toEqual([])
    const same = diagnose([call('GET aaa.900'), call('GET aaa.900')], null).findings
    expect(same.map((f) => f.title)).toEqual(['The same request was in flight 2 times at once'])
    expect(same[0]!.evidence[0]).toBe('GET serverFn getOffers ?payload=%7B%22t%22…(+700 chars)')
  })

  it('does not call two POSTs to one URL the same request', () => {
    const posts = Array.from({ length: 3 }, () =>
      entry({ source: 'network', type: 'ok', key: '/api/rates', summary: 'POST /api/rates → 200', dur: 500 }),
    )
    expect(diagnose(posts, null).findings).toEqual([])
  })

  it('does not flag the same request sent again after the first finished', () => {
    const sequential = Array.from({ length: 4 }, () =>
      entry({ source: 'network', type: 'ok', key: '/api/me', summary: 'GET /api/me → 200', dur: 40 }),
    )
    expect(diagnose(sequential, null).findings).toEqual([])
  })

  it('does not call slow user-paced refetches a loop', () => {
    const spaced = Array.from({ length: 6 }, (_, index) =>
      ({ ...entry({ source: 'query', type: 'fetch', key: '["a"]', summary: '["a"] refetching' }), t: index * 5000 }),
    )
    expect(diagnose(spaced, null).findings).toEqual([])
  })
})
