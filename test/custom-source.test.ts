// @vitest-environment happy-dom
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { appFrames, connect } from '@loopsight/core/page'
import { Hub, createMcpServer } from '@loopsight/core/server'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { connect as presetConnect } from 'loopsight/client'
import type { PageSource, SocketLike } from '@loopsight/core/page'
import type { ServerSource } from '@loopsight/core/server'

/**
 * A library the core has never heard of, and a source for it written the way
 * someone outside this repository would: against the two public contracts,
 * with no change to the core, the host or any other source.
 */
interface Store {
  getState: () => { items: Record<string, number> }
  subscribe: (listener: (change: { item: string; quantity: number }) => void) => () => void
  set: (item: string, quantity: number) => void
}

function createStore(): Store {
  const items: Record<string, number> = {}
  const listeners = new Set<(change: { item: string; quantity: number }) => void>()
  return {
    getState: () => ({ items: { ...items } }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (item, quantity) => {
      items[item] = quantity
      listeners.forEach((listener) => listener({ item, quantity }))
    },
  }
}

const cartPage: PageSource<Store> = {
  key: 'cart',
  instance: {
    label: 'cart store',
    accepts: (value): value is Store =>
      typeof (value as Store | undefined)?.subscribe === 'function',
    globals: ['__CART_STORE__'],
    find: ({ global }) => global.__CART_STORE__,
    missing: 'No cart store on this page. Pass it to connect({ instances: { cart } }).',
  },
  attach: (store, { record }) => ({
    stop: store.subscribe(({ item, quantity }) =>
      record({
        source: 'cart',
        type: 'set',
        key: item,
        summary: `${item} = ${quantity}`,
        detail: { quantity },
        ...(quantity < 0 ? { problem: true as const } : {}),
      }),
    ),
    handlers: {
      'cart.state': () => store.getState(),
      'cart.set': ({ item, quantity }) => store.set(item, quantity),
    },
    overview: () => ({ lines: Object.keys(store.getState().items).length }),
    facts: () => ({ max: 99 }),
  }),
}

const cartServer: ServerSource = {
  key: 'cart',
  title: 'Cart',
  about: 'get_cart reads what is in the cart.',
  writes: { cart: 'changes to the cart' },
  tools: [
    {
      name: 'get_cart',
      description: 'What is in the cart now.',
      input: {},
      run: (_args, { call }) => call('cart.state'),
    },
    {
      name: 'set_cart_item',
      description: 'Sets how many of one item are in the cart.',
      input: { item: z.string(), quantity: z.number().int() },
      action: true,
      run: (args, { call }) => call('cart.set', args),
    },
  ],
  rules: [
    {
      id: 'cart/over-limit',
      fix: 'Clamp the quantity to the limit before writing it to the store, so the total stays one the checkout accepts.',
      docs: { label: 'Cart docs: Limits', at: 'https://example.com/cart/limits' },
      check: ({ by, facts }) => {
        const max = facts<{ max: number }>('cart')?.max
        if (max === undefined) return []
        const over = by('cart', 'set').filter(
          (entry) => (entry.detail as { quantity: number }).quantity > max,
        )
        return over.length === 0
          ? []
          : [
              {
                severity: 'warning',
                title: `An item was set above the limit of ${max}`,
                entries: over.map((entry) => entry.n),
                evidence: over.map((entry) => entry.summary),
              },
            ]
      },
    },
  ],
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  delete (globalThis as any).__LOOPSIGHT__
  delete (globalThis as any).__CART_STORE__
})

function link(hub: Hub) {
  return (): SocketLike => {
    const toHub: Array<(text: string) => void> = []
    const closed: Array<() => void> = []
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (data) => queueMicrotask(() => toHub.forEach((listener) => listener(data))),
      close: () => closed.forEach((listener) => listener()),
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

async function setup(
  actions: boolean,
  pages: Array<PageSource> = [cartPage],
  servers: Array<ServerSource> = [cartServer],
) {
  const hub = new Hub()
  const options = {
    sources: pages,
    console: false,
    network: false,
    url: 'ws://test/bridge',
    createSocket: link(hub),
  }
  const disconnect = connect(options)
  cleanups.push(disconnect)
  const server = createMcpServer(hub, { actions, sources: servers })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  cleanups.push(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    if (result.isError) throw new Error(result.content[0]!.text)
    return JSON.parse(result.content[0]!.text)
  }
  await expect.poll(() => hub.sessions.size).toBe(1)
  return { hub, client, call, disconnect, reconnect: () => cleanups.push(connect(options)) }
}

describe('a source from outside this repository', () => {
  it('gets its tools, its place in the overview, the timeline and the diagnosis', async () => {
    const { client, call } = await setup(true)

    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names.slice(-2)).toEqual(['get_cart', 'set_cart_item'])
    expect(names).toHaveLength(12)
    expect(client.getInstructions()).toMatch(/get_cart reads what is in the cart\./)

    // Before the app creates the store, the tool says what is missing.
    expect((await call('list_sessions')).sessions[0].has).toEqual({ cart: false })
    await expect(call('get_cart')).rejects.toThrow(/No cart store on this page/)

    // The store appears on the global the source named, and is picked up.
    const store = createStore()
    ;(globalThis as any).__CART_STORE__ = store
    await expect
      .poll(async () => (await call('list_sessions')).sessions[0].has)
      .toEqual({ cart: true })

    store.set('tea', 2)
    // The store's setter returns nothing; the agent still gets an answer.
    expect(await call('set_cart_item', { item: 'tea', quantity: 120 })).toEqual({ ok: true })
    expect(await call('get_cart')).toEqual({ items: { tea: 120 } })
    expect((await call('overview')).cart).toEqual({ lines: 1 })

    await expect
      .poll(async () =>
        (await call('list_events', { source: 'cart' })).entries.map((entry: any) => entry.summary),
      )
      .toEqual(['tea = 2', 'tea = 120'])

    const { ok, findings } = await call('diagnose')
    expect(ok).toBe(false)
    expect(findings).toEqual([
      {
        severity: 'warning',
        title: 'An item was set above the limit of 99',
        entries: [expect.any(Number)],
        evidence: ['tea = 120'],
        fix: expect.stringMatching(/^Clamp the quantity/),
        docs: { label: 'Cart docs: Limits', at: 'https://example.com/cart/limits' },
        rule: 'cart/over-limit',
      },
    ])
  })

  it('keeps its action tools off unless the server allows actions', async () => {
    const { client } = await setup(false)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('get_cart')
    expect(names).not.toContain('set_cart_item')
  })
})

describe('the page bridge, whatever the sources', () => {
  it('starts a listen-only source again when the page reconnects', async () => {
    let listening = 0
    const listener: PageSource = {
      key: 'clicks',
      attach: () => {
        listening += 1
        return { stop: () => (listening -= 1) }
      },
    }
    const { disconnect, reconnect } = await setup(false, [listener], [])
    expect(listening).toBe(1)
    disconnect()
    expect(listening).toBe(0)
    reconnect()
    expect(listening).toBe(1)
  })

  it('finds an instance kept inside another source\'s, in either listing order', async () => {
    const shell = { settings: { subscribe: () => () => {}, getState: () => ({ items: {} }), set: () => {} } }
    const shellPage: PageSource<typeof shell> = {
      key: 'shell',
      instance: {
        label: 'shell',
        accepts: (value): value is typeof shell => typeof value === 'object' && value !== null,
        find: ({ global }) => global.__SHELL__,
        missing: 'No shell.',
      },
      attach: () => ({}),
    }
    // Listed first, though it can only find its store once the shell is known.
    const inner: PageSource<Store> = {
      ...cartPage,
      instance: {
        ...cartPage.instance!,
        globals: [],
        find: ({ instanceOf }) => (instanceOf('shell') as typeof shell | undefined)?.settings,
      },
    }
    ;(globalThis as any).__SHELL__ = shell
    cleanups.push(() => delete (globalThis as any).__SHELL__)
    const { call } = await setup(false, [inner, shellPage], [cartServer])
    // No waiting for the next timed check: both are there on the first answer.
    expect((await call('list_sessions')).sessions[0].has).toEqual({ cart: true, shell: true })
  })

  it('keeps the other sources working when one throws as it starts', async () => {
    const broken: PageSource<Store> = {
      ...cartPage,
      key: 'broken',
      methods: ['broken'],
      instance: { ...cartPage.instance!, globals: [], find: ({ global }) => global.__CART_STORE__ },
      attach: () => {
        throw new Error('unexpected store shape')
      },
    }
    const brokenServer: ServerSource = {
      key: 'broken',
      title: 'Broken',
      tools: [{ name: 'get_broken', description: 'x', input: {}, run: (_a, { call }) => call('broken.state') }],
    }
    ;(globalThis as any).__CART_STORE__ = createStore()
    const { call } = await setup(false, [broken, cartPage], [brokenServer, cartServer])

    expect(await call('get_cart')).toEqual({ items: {} })
    expect((await call('list_sessions')).sessions[0].has).toEqual({ broken: false, cart: true })
    // The tool answers with the reason instead of timing out, and the
    // failure is on the timeline once, not once per check.
    await expect(call('get_broken')).rejects.toThrow(
      'The broken source could not start on this page: unexpected store shape',
    )
    const failures = (await call('list_events', { problems: true })).entries
    expect(failures.map((entry: any) => `${entry.source}/${entry.type}`)).toEqual(['broken/attach-failed'])
  })

  it('leaves Vite\'s own frames out for an app that connects through the preset by itself', () => {
    const origin = location.origin === 'null' ? 'http://localhost:5173' : location.origin
    const stack = `Error
    at refresh (${origin}/@react-refresh:10:1)
    at hot (${origin}/@vite/client:900:3)
    at dep (${origin}/node_modules/.vite/deps/react.js:40:2)
    at App (${origin}/src/App.tsx:7:9)`
    // Before the preset connects, the core alone knows nothing of Vite.
    expect(appFrames(stack)).toHaveLength(3)
    const hub = new Hub()
    cleanups.push(
      presetConnect({ console: false, network: false, url: 'ws://test/bridge', createSocket: link(hub) }),
    )
    expect(appFrames(stack).map((frame) => frame.url)).toEqual([`${origin}/src/App.tsx`])
  })
})
