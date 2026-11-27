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
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  // Each test gets its own page-side bridge and session.
  delete (globalThis as any).__TANSTACK_DEVTOOLS_MCP__
  delete (globalThis as any).__TANSTACK_QUERY_CLIENT__
})

async function setup(
  options: Omit<ConnectOptions, 'createSocket' | 'url'> = {},
  server: { actions?: boolean } = {},
) {
  const hub = new Hub({ size: 50 })
  const disconnect = connect({
    ...options,
    console: false,
    url: 'ws://test/bridge',
    createSocket: linkTo(hub),
  })
  cleanups.push(disconnect)

  const mcp = createMcpServer(hub, server)
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(a), client.connect(b)])
  cleanups.push(() => client.close())

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
    expect(list.queries[0]).toMatchObject({
      queryHash: '["todos",{"page":1}]',
      queryKey: ['todos', { page: 1 }],
      status: 'success',
      fetchStatus: 'idle',
      observers: 0,
    })
    expect(list.queries[0]).not.toHaveProperty('data')

    const query = await call('get_query', { queryHash: '["todos",{"page":1}]' })
    expect(query.data).toHaveLength(51)
    expect(query.data.at(-1)).toBe('…(+30 more)')

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
    expect(waited.entries[2]).toMatchObject({ key: '["slow"]', n: 3 })

    const failing = queryClient.fetchQuery({
      queryKey: ['bad'],
      queryFn: () => Promise.reject(new Error('offline')),
    })
    await expect(failing).rejects.toThrow('offline')
    await call('wait_for_idle')
    const errors = await call('list_events', { type: 'error' })
    expect(errors.entries).toHaveLength(1)
    expect(errors.entries[0].summary).toBe('["bad"]: Error: offline')
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
      Object.fromEntries(queries.map((q: any) => [q.queryHash, q.invalidated])),
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
    expect(routes.find((r: any) => r.id === '/posts/$postId')).toMatchObject({
      fullPath: '/posts/$postId',
      parent: '__root__',
      hasLoader: true,
      validatesSearch: true,
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
    expect(events.entries[0].summary).toBe('/ → /posts/42?tab=comments')
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
