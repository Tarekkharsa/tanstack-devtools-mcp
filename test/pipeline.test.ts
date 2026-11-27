// @vitest-environment happy-dom
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { QueryClient } from '@tanstack/query-core'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { connect } from '../src/client/index.js'
import { Hub } from '../src/server/hub.js'
import { createMcpServer } from '../src/server/mcp.js'
import type { ConnectOptions, SocketLike } from '../src/client/index.js'

/** A socket whose other end is `hub`, with no network in between. */
function linkTo(hub: Hub) {
  return (): SocketLike => {
    const toHub: Array<(text: string) => void> = []
    const closed: Array<() => void> = []
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (data) => queueMicrotask(() => toHub.forEach((l) => l(data))),
      close: () => {
        closed.forEach((l) => l())
        socket.onclose?.()
      },
    }
    hub.attach({
      send: (text) => queueMicrotask(() => socket.onmessage?.({ data: text })),
      onMessage: (listener) => toHub.push(listener),
      onClose: (listener) => closed.push(listener),
    })
    queueMicrotask(() => socket.onopen?.())
    return socket
  }
}

const cleanups: Array<() => unknown> = []
/** Closed after everything else, so a test can end a page and keep asking. */
const closers: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const closer of closers.splice(0)) await closer()
  // Each test gets its own page-side bridge and session.
  delete (globalThis as any).__TANSTACK_DEVTOOLS_MCP__
  delete (globalThis as any).__TANSTACK_QUERY_CLIENT__
  // TanStack Router leaves the last router here, where the bridge looks.
  delete (globalThis as any).__TSR_ROUTER__
})

async function setup(
  options: Omit<ConnectOptions, 'createSocket' | 'url'> = {},
  server: { actions?: boolean } = {},
) {
  const hub = new Hub({ size: 50 })
  const disconnect = connect({
    console: false,
    network: false,
    ...options,
    url: 'ws://test/bridge',
    createSocket: linkTo(hub),
  })
  cleanups.push(disconnect)

  const mcp = createMcpServer(hub, server)
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(a), client.connect(b)])
  closers.push(() => client.close())

  const raw = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<{
      isError?: boolean
      content: Array<{ text: string }>
    }>
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args)
    if (result.isError) throw new Error(result.content[0]!.text)
    return JSON.parse(result.content[0]!.text)
  }
  await expect.poll(() => hub.sessions.size).toBe(1)
  return { hub, client, call, disconnect }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('queries', () => {
  it('lists the cache and returns bounded data', async () => {
    const queryClient = new QueryClient()
    await queryClient.prefetchQuery({
      queryKey: ['todos', { page: 1 }],
      queryFn: () => Array.from({ length: 80 }, (_, id) => ({ id })),
    })
    const { call } = await setup({ queryClient })

    const list = await call('list_queries')
    expect(list.total).toBe(1)
    expect(list.byStatus).toEqual({ success: 1 })
    expect(list.queries[0]).toMatchObject({
      queryHash: '["todos",{"page":1}]',
      status: 'success',
      observers: 0,
    })
    // A row leaves out what is at its usual value, and never carries data.
    for (const absent of ['data', 'fetch', 'invalidated', 'disabled', 'error']) {
      expect(list.queries[0]).not.toHaveProperty(absent)
    }

    const query = await call('get_query', { queryHash: '["todos",{"page":1}]' })
    expect(query.queryKey).toEqual(['todos', { page: 1 }])
    expect(query.data).toHaveLength(51)
    expect(query.data.at(-1)).toBe('…(+30 more)')

    // `path` reaches what the cut left out.
    const deep = await call('get_query', {
      queryHash: '["todos",{"page":1}]',
      path: [79],
    })
    expect(deep.data).toEqual({ id: 79 })
    await expect(
      call('get_query', { queryHash: '["todos",{"page":1}]', path: [200, 'id'] }),
    ).rejects.toThrow('Nothing at path [200]')

    expect((await call('list_queries', { status: 'error' })).total).toBe(0)
    expect((await call('list_queries', { keyContains: 'todos' })).total).toBe(1)
    await expect(call('get_query', { queryHash: 'nope' })).rejects.toThrow(
      'No query with hash nope',
    )
  })

  it('finds a QueryClient the app put on window', async () => {
    const queryClient = new QueryClient()
    ;(globalThis as any).__TANSTACK_QUERY_CLIENT__ = queryClient
    const { call } = await setup()
    await expect
      .poll(async () => (await call('list_sessions')).sessions[0].has.query)
      .toBe(true)
    expect((await call('list_queries')).total).toBe(0)
  })

  it('says what is missing when no QueryClient is connected', async () => {
    const { call } = await setup()
    await expect(call('list_queries')).rejects.toThrow(/no QueryClient connected/)
    await expect(call('get_router_state')).rejects.toThrow(/no TanStack Router/)
  })

  it('records fetches and waits for them to settle', async () => {
    const queryClient = new QueryClient()
    const { call } = await setup({ queryClient })

    const fetching = queryClient.fetchQuery({
      queryKey: ['slow'],
      queryFn: async () => {
        await sleep(80)
        return 'done'
      },
    })
    const waited = await call('wait_for_idle', { after: 0 })
    await fetching

    expect(waited.idle).toBe(true)
    expect(waited.waitedMs).toBeGreaterThanOrEqual(80)
    expect(waited.entries.map((e: any) => `${e.source}/${e.type}`)).toEqual([
      'query/added',
      'query/fetch',
      'query/success',
    ])
    expect(waited.entries[2]).toMatchObject({ n: 3, summary: '["slow"] success' })
    expect(waited.entries[2].ms).toBeGreaterThanOrEqual(70)
    expect(waited.entries[1].summary).toBe('["slow"] fetching')

    const failing = queryClient.fetchQuery({
      queryKey: ['bad'],
      queryFn: () => Promise.reject(new Error('offline')),
    })
    await expect(failing).rejects.toThrow('offline')
    await call('wait_for_idle')
    const errors = await call('list_events', { type: 'error' })
    expect(errors.entries).toHaveLength(1)
    expect(errors.entries[0].summary).toBe('["bad"] error: Error: offline')
    expect((await call('list_events', { problems: true })).matched).toBe(1)
    expect((await call('count_events')).counts).toMatchObject({
      'query/fetch': 2,
      'query/success': 1,
      'query/error': 1,
    })
  })

  it('gives up waiting at the timeout and says the page is not idle', async () => {
    const queryClient = new QueryClient()
    const { call } = await setup({ queryClient })
    void queryClient
      .fetchQuery({ queryKey: ['never'], queryFn: () => sleep(2000) })
      .catch(() => {})
    const waited = await call('wait_for_idle', { timeoutMs: 60 })
    expect(waited.idle).toBe(false)
    queryClient.clear()
  })
})

describe('actions', () => {
  it('are not registered, and unsafe page tools are refused, by default', async () => {
    const queryClient = new QueryClient()
    const { client, call } = await setup({ queryClient })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('list_queries')
    expect(names).not.toContain('query_action')
    expect(names).not.toContain('set_query_data')
    expect(names).not.toContain('navigate')
    expect(names).not.toContain('invalidate_router')

    const controller = new AbortController()
    let ran = 0
    await (document as any).modelContext.registerTool(
      { name: 'demo.write', description: 'Writes', execute: () => ++ran },
      { signal: controller.signal },
    )
    await expect
      .poll(async () => (await call('list_page_tools')).tools)
      .toEqual([
        { name: 'demo.write', description: 'Writes', readOnly: false, callable: false },
      ])
    await expect(call('call_page_tool', { name: 'demo.write' })).rejects.toThrow(
      /not marked read-only, and actions are off/,
    )
    expect(ran).toBe(0)
  })

  it('change the cache when enabled', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['user'], { name: 'Ada' })
    queryClient.setQueryData(['team'], { size: 3 })
    const { call } = await setup({ queryClient }, { actions: true })

    await call('set_query_data', { queryHash: '["user"]', data: { name: 'Grace' } })
    expect(queryClient.getQueryData(['user'])).toEqual({ name: 'Grace' })

    await expect(call('query_action', { action: 'invalidate' })).rejects.toThrow(
      'Pass queryHash, keyContains, or all: true',
    )
    const result = await call('query_action', {
      action: 'invalidate',
      keyContains: 'user',
    })
    expect(result).toEqual({ action: 'invalidate', matched: 1 })
    const { queries } = await call('list_queries')
    expect(
      Object.fromEntries(
        queries.map((q: any) => [q.queryHash, q.invalidated ?? false]),
      ),
    ).toEqual({ '["user"]': true, '["team"]': false })

    await call('query_action', { action: 'remove', all: true })
    expect((await call('list_queries')).total).toBe(0)
  })
})

describe('page tools', () => {
  it('serves tools registered through WebMCP until they are aborted', async () => {
    const { call } = await setup()
    const controller = new AbortController()
    const context = (document as any).modelContext
    await context.registerTool(
      {
        name: 'demo.read',
        description: 'Reads',
        inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
        annotations: { readOnlyHint: true, debugging: true },
        execute: (input: { id: number }, options: { signal: AbortSignal }) => ({
          id: input.id,
          hasSignal: options.signal instanceof AbortSignal,
        }),
      },
      { signal: controller.signal },
    )
    await expect(
      context.registerTool({ name: 'demo.read', execute: () => 1 }),
    ).rejects.toThrow('already registered')

    await expect
      .poll(async () => (await call('list_page_tools')).tools.length)
      .toBe(1)
    expect(await call('call_page_tool', { name: 'demo.read', input: { id: 7 } })).toEqual({
      id: 7,
      hasSignal: true,
    })

    controller.abort()
    await expect
      .poll(async () => (await call('list_page_tools')).tools.length)
      .toBe(0)
    await expect(call('call_page_tool', { name: 'demo.read' })).rejects.toThrow(
      'No registered tool named demo.read',
    )
  })

  it('returns a tool failure as an error, not a crash', async () => {
    const { call } = await setup()
    await (document as any).modelContext.registerTool({
      name: 'demo.fail',
      description: 'Fails',
      annotations: { readOnlyHint: true },
      execute: () => {
        throw new Error('tool broke')
      },
    })
    await expect
      .poll(async () => (await call('list_page_tools')).tools.length)
      .toBe(1)
    await expect(call('call_page_tool', { name: 'demo.fail' })).rejects.toThrow(
      'tool broke',
    )
  })
})

describe('router', () => {
  function makeRouter() {
    const root = createRootRoute()
    const index = createRoute({ getParentRoute: () => root, path: '/' })
    const post = createRoute({
      getParentRoute: () => root,
      path: '/posts/$postId',
      validateSearch: (search: Record<string, unknown>) => ({
        tab: typeof search.tab === 'string' ? search.tab : 'info',
      }),
      loader: ({ params }) => ({ id: params.postId, body: 'x'.repeat(10) }),
    })
    return createRouter({
      routeTree: root.addChildren([index, post]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
  }

  it('reads state and routes, and navigates when actions are on', async () => {
    const router = makeRouter()
    await router.load()
    const { call } = await setup({ router }, { actions: true })

    const before = await call('get_router_state')
    expect(before.location.pathname).toBe('/')
    expect(before.status).toBe('idle')

    const { routes } = await call('list_routes')
    expect(routes.find((r: any) => r.id === '/posts/$postId')).toEqual({
      id: '/posts/$postId',
      has: ['loader', 'search'],
    })
    expect(await call('list_routes', { contains: 'posts' })).toMatchObject({
      total: 3,
      matched: 1,
    })

    const moved = await call('navigate', {
      to: '/posts/$postId',
      params: { postId: '42' },
      search: { tab: 'comments' },
    })
    expect(moved.location.href).toBe('/posts/42?tab=comments')
    const waited = await call('wait_for_idle', { after: 0 })
    expect(waited.idle).toBe(true)

    const after = await call('get_router_state')
    const match = after.matches.at(-1)
    expect(match).toMatchObject({
      routeId: '/posts/$postId',
      params: { postId: '42' },
      search: { tab: 'comments' },
      loaderData: { id: '42', body: 'xxxxxxxxxx' },
    })

    const events = await call('list_events', { source: 'router' })
    expect(events.entries.map((e: any) => e.type)).toEqual(
      expect.arrayContaining(['onBeforeNavigate', 'onBeforeLoad', 'onResolved']),
    )
    expect(events.entries[0]).toMatchObject({
      type: 'attached',
      summary: 'at / (__root__ > /)',
    })
    expect(events.entries[1].summary).toBe('/ → /posts/42?tab=comments')
    const resolved = events.entries.find((e: any) => e.type === 'onResolved')
    expect(resolved.ms).toBeGreaterThanOrEqual(0)

    const overview = await call('overview')
    expect(overview.router).toEqual({
      status: 'idle',
      href: '/posts/42?tab=comments',
      matches: ['__root__', '/posts/$postId'],
    })
    expect(overview.idle).toBe(true)
  })
})

describe('the log', () => {
  it('stays readable after the page disconnects, within its size', async () => {
    const queryClient = new QueryClient()
    const { call, disconnect, hub } = await setup({ queryClient })
    for (let index = 0; index < 40; index++) {
      queryClient.setQueryData(['item', index], index)
    }
    // 40 added + 40 success entries into a log of 50.
    await expect.poll(() => [...hub.sessions.values()][0]!.dropped).toBe(30)

    disconnect()
    const { sessions } = await call('list_sessions')
    expect(sessions[0]).toMatchObject({ connected: false, entries: 50, lastEntry: 80 })

    const newest = await call('list_events', { limit: 2 })
    expect(newest).toMatchObject({ matched: 50, dropped: 30, lastEntry: 80 })
    expect(newest.entries.map((e: any) => e.n)).toEqual([79, 80])

    const paged = await call('list_events', { after: 76, limit: 2 })
    expect(paged.entries.map((e: any) => e.n)).toEqual([77, 78])

    expect(await call('get_event', { n: 80 })).toMatchObject({
      type: 'success',
      key: '["item",39]',
      summary: '["item",39] success (set by hand)',
      detail: { manual: true },
    })
    await expect(call('get_event', { n: 1 })).rejects.toThrow('not in the log')
    await expect(call('list_queries')).rejects.toThrow(/no open page/)
  })

  it('reports that no page has connected', async () => {
    const hub = new Hub()
    expect(() => hub.resolve()).toThrow(/No page has connected yet/)
    expect(() => hub.resolve('missing')).toThrow(/No session missing/)
  })
})

describe('what changed', () => {
  it('diffs the last change to a query, by path', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['cart'], {
      items: [{ id: 1, qty: 1 }, { id: 2, qty: 1 }],
      total: 20,
    })
    const { call } = await setup({ queryClient })
    expect(await call('diff_query', { queryHash: '["cart"]' })).toMatchObject({
      note: 'The data has not changed since this page connected.',
      changes: [],
    })

    queryClient.setQueryData(['cart'], (old: any) => ({
      ...old,
      items: [old.items[0], { id: 2, qty: 3 }, { id: 3, qty: 1 }],
      total: 50,
      coupon: 'X',
    }))
    const result = await call('diff_query', { queryHash: '["cart"]' })
    expect(result.changes).toEqual([
      { path: 'items.1.qty', kind: 'changed', before: 1, after: 3 },
      { path: 'items.2', kind: 'added', after: { id: 3, qty: 1 } },
      { path: 'total', kind: 'changed', before: 20, after: 50 },
      { path: 'coupon', kind: 'added', after: 'X' },
    ])
    expect(result.more).toBe(0)
  })

  it('notes what the cache already held when the page connected', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['a'], 1)
    queryClient.setQueryData(['b'], 2)
    const { call } = await setup({ queryClient })
    const { entries } = await call('list_events')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      source: 'query',
      type: 'attached',
      summary: '2 queries already in the cache: 2 success',
    })
  })
})

describe('network', () => {
  it('records fetch calls with status and time, and never touches the response', async () => {
    const realFetch = globalThis.fetch
    const seen: Array<string> = []
    globalThis.fetch = (async (input: any) => {
      seen.push(String(input))
      await sleep(30)
      if (String(input).includes('down')) throw new TypeError('Failed to fetch')
      return new Response('{"ok":true}', {
        status: String(input).includes('missing') ? 404 : 200,
      })
    }) as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = realFetch
    })
    const { call } = await setup({ network: true })

    const ok = await fetch('https://api.test/items?id=1')
    expect(await ok.json()).toEqual({ ok: true })
    await fetch('https://api.test/missing', { method: 'post' })
    await expect(fetch('https://api.test/down')).rejects.toThrow('Failed to fetch')
    const waited = await call('wait_for_idle', { after: 0 })

    expect(seen).toHaveLength(3)
    expect(waited.entries.map((e: any) => [e.type, e.summary])).toEqual([
      ['ok', 'GET https://api.test/items?id=1 → 200'],
      ['error', 'POST https://api.test/missing → 404'],
      ['failed', 'GET https://api.test/down → TypeError: Failed to fetch'],
    ])
    // The pathname is the key, for filtering; a row leaves it out when the
    // summary already shows it.
    expect((await call('list_events', { key: '/missing' })).matched).toBe(1)
    expect(await call('get_event', { n: 2 })).toMatchObject({
      key: '/missing',
      detail: { kind: 'fetch', status: 404 },
    })
    expect(waited.entries[0].ms).toBeGreaterThanOrEqual(25)
    expect((await call('list_events', { problems: true })).matched).toBe(2)
  })

  it('names server functions, and does not count a cancelled request as a failure', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('signal is aborted', 'AbortError')
      return new Response('{}')
    }) as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = realFetch
    })
    const { call } = await setup({ network: true })
    const id = btoa(
      JSON.stringify({
        file: '/src/features/cart/api.ts?tss-serverfn-split',
        export: 'getCart_createServerFn_handler',
      }),
    ).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    await fetch(`${location.origin}/_serverFn/${id}?locale=en`)
    await fetch('https://api.test/slow', { signal: AbortSignal.abort() }).catch(() => {})
    const { entries } = await call('wait_for_idle', { after: 0 })
    expect(entries.map((e: any) => [e.type, e.summary])).toEqual([
      ['ok', 'GET serverFn getCart (src/features/cart/api.ts) ?locale=en → 200'],
      ['aborted', 'GET https://api.test/slow → aborted'],
    ])
    expect((await call('list_events', { key: 'serverFn:getCart' })).matched).toBe(1)
    expect((await call('list_events', { problems: true })).matched).toBe(0)
  })

  it('holds wait_for_idle until a request in flight finishes', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      await sleep(120)
      return new Response('ok')
    }) as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = realFetch
    })
    const { call } = await setup({ network: true })
    void fetch('https://api.test/slow')
    expect((await call('overview')).pendingRequests).toBe(1)
    const waited = await call('wait_for_idle')
    expect(waited.idle).toBe(true)
    expect(waited.waitedMs).toBeGreaterThanOrEqual(100)
  })
})

describe('console', () => {
  it('records errors once, then says how often they repeated', async () => {
    const quiet = console.error
    console.error = () => {}
    cleanups.push(() => {
      console.error = quiet
    })
    const { call } = await setup({ console: true })
    for (let index = 0; index < 4; index++) console.error('socket closed', { code: 1006 })
    console.error('different')
    await expect
      .poll(async () => (await call('list_events', { source: 'console' })).matched)
      .toBe(2)
    await sleep(5100)
    const { entries } = await call('list_events', { source: 'console' })
    expect(entries.map((e: any) => [e.type, e.summary])).toEqual([
      ['error', 'socket closed {"code":1006}'],
      ['error', 'different'],
      ['repeat', '(repeated 3 more times in 5 s) socket closed {"code":1006}'],
    ])
  }, 10_000)
})

describe('after an edit', () => {
  const change = { source: 'vite', type: 'change', key: 'src/Cart.tsx', summary: 'src/Cart.tsx changed' } as const

  it('reports a hot update with the files and what followed', async () => {
    const queryClient = new QueryClient()
    const { call, hub } = await setup({ queryClient })
    hub.recordServer(change)
    hub.recordServer({ source: 'vite', type: 'hmr-update', key: 'src/Cart.tsx', summary: 'hot update: src/Cart.tsx' })
    await queryClient
      .fetchQuery({ queryKey: ['cart'], queryFn: () => Promise.reject(new Error('500')) })
      .catch(() => {})

    const result = await call('wait_for_update')
    expect(result).toMatchObject({ update: 'hmr-update', files: ['src/Cart.tsx'], idle: true })
    expect(result).not.toHaveProperty('reloaded')
    expect(result.problems.map((p: any) => p.summary)).toEqual(['["cart"] error: Error: 500'])
    expect(result.entries.map((e: any) => `${e.source}/${e.type}`)).toEqual([
      'vite/change',
      'vite/hmr-update',
      'query/added',
      'query/fetch',
      'query/error',
    ])
  })

  it('reports a build error with its code frame, without waiting on the page', async () => {
    const { call, hub } = await setup()
    hub.recordServer(change)
    hub.recordServer({
      source: 'vite',
      type: 'error',
      key: 'src/Cart.tsx',
      summary: 'build error in src/Cart.tsx:3:9: Unexpected token',
      detail: { message: 'Unexpected token', frame: '3 |  const = 1' },
    })
    const result = await call('wait_for_update')
    expect(result.update).toBe('error')
    expect(result).not.toHaveProperty('idle')
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatchObject({
      summary: 'build error in src/Cart.tsx:3:9: Unexpected token',
      detail: { frame: '3 |  const = 1' },
    })
    expect((await call('diagnose')).findings[0]).toMatchObject({
      severity: 'error',
      title: 'Vite reports a build error, and no update has succeeded since',
    })
  })

  it('only counts updates newer than `after`', async () => {
    const { call, hub } = await setup()
    hub.recordServer({ source: 'vite', type: 'hmr-update', key: 'src/Old.tsx', summary: 'hot update: src/Old.tsx' })
    const { lastEntry } = await call('count_events')
    const result = await call('wait_for_update', { after: lastEntry, timeoutMs: 80 })
    expect(result.update).toBe('none')
    expect(result.note).toMatch(/no change to a module of the app, hot update, reload or build error/)
    expect(result.files).toEqual([])
  })

  it('says so when Vite saw the change but the browser got nothing', async () => {
    const { call, hub } = await setup()
    hub.recordServer({ source: 'vite', type: 'change', key: 'server/db.ts', summary: 'server/db.ts changed' })
    const started = Date.now()
    const result = await call('wait_for_update', { timeoutMs: 9000 })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result.update).toBe('none')
    expect(result.files).toEqual(['server/db.ts'])
    expect(result.note).toMatch(/sent the browser no update/)
  })

  it('follows the page across a full reload', async () => {
    const { call, hub } = await setup()
    hub.recordServer({ source: 'vite', type: 'full-reload', key: 'src/main.tsx', summary: 'full reload triggered by src/main.tsx' })
    // The page reloads: a new bridge, a new session.
    cleanups.splice(0).reverse().forEach((cleanup) => cleanup())
    delete (globalThis as any).__TANSTACK_DEVTOOLS_MCP__
    const queryClient = new QueryClient()
    queryClient.setQueryData(['fresh'], 1)
    const pending = call('wait_for_update')
    await sleep(60)
    cleanups.push(
      connect({ console: false, network: false, queryClient, url: 'ws://test/bridge', createSocket: linkTo(hub) }),
    )
    const result = await pending
    expect(result).toMatchObject({ update: 'full-reload', reloaded: true, idle: true })
    expect(result.files).toEqual(['src/main.tsx'])
    expect(hub.sessions.size).toBe(2)
    // The new page's log opens with the reload that caused it.
    expect(result.entries.map((e: any) => `${e.source}/${e.type}`)).toEqual([
      'vite/full-reload',
      'vite/full-reload',
      'query/attached',
    ])
  })
})
