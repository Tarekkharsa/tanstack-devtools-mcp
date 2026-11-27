// @vitest-environment happy-dom
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { connect } from '@loopsight/core/page'
import { Hub, createMcpServer } from '@loopsight/core/server'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
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

async function setup(actions: boolean) {
  const hub = new Hub()
  const createSocket = (): SocketLike => {
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
  cleanups.push(
    connect({ sources: [cartPage], console: false, network: false, url: 'ws://test/bridge', createSocket }),
  )
  const server = createMcpServer(hub, { actions, sources: [cartServer] })
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
  return { client, call }
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
