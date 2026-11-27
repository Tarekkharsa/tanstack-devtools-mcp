import { createServer, request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createBridge, startServer } from '../src/server/http.js'
import { Hub } from '../src/server/hub.js'
import type { RunningServer, ServerOptions } from '../src/server/http.js'
import type { SessionInfo } from '../src/protocol.js'

let server: RunningServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(options: ServerOptions = {}) {
  server = await startServer({ port: 0, ...options })
  return server
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
})

/** A POST with full control of the headers, which `fetch` does not give. */
function post(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (response) => {
        let body = ''
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode!, body }))
      },
    )
    outgoing.on('error', reject)
    outgoing.end(initialize)
  })
}

function open(url: string, origin?: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : {})
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

const session: SessionInfo = {
  id: 'page-1',
  url: 'http://localhost:5173/',
  title: 'App',
  startedAt: 0,
  has: { query: false, router: false },
  tools: [],
}

describe('/mcp', () => {
  it('serves the tools to an MCP client over HTTP', async () => {
    const { mcpUrl, bridgeUrl } = await start()
    const page = await open(bridgeUrl, 'http://localhost:5173')
    page.send(JSON.stringify({ kind: 'hello', session }))
    page.send(
      JSON.stringify({
        kind: 'entries',
        entries: [{ seq: 1, t: 0, source: 'console', type: 'warn', summary: 'careful' }],
      }),
    )

    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual([
        'list_sessions',
        'overview',
        'diagnose',
        'list_queries',
        'get_query',
        'diff_query',
        'list_mutations',
        'get_router_state',
        'list_routes',
        'list_events',
        'get_event',
        'count_events',
        'wait_for_idle',
        'wait_for_update',
        'list_page_tools',
        'call_page_tool',
      ])
      expect(client.getInstructions()).toMatch(/Start with overview/)

      await expect
        .poll(async () => {
          const result: any = await client.callTool({
            name: 'list_events',
            arguments: {},
          })
          return JSON.parse(result.content[0].text).entries
        })
        .toEqual([
          {
            n: 1,
            time: '00:00:00.000',
            source: 'console',
            type: 'warn',
            summary: 'careful',
          },
        ])
    } finally {
      await client.close()
      page.close()
    }
  })

  it('adds the action tools only when asked', async () => {
    const { mcpUrl } = await start({ actions: true })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    await client.close()
    expect(names).toEqual(
      expect.arrayContaining([
        'query_action',
        'set_query_data',
        'navigate',
        'invalidate_router',
      ]),
    )
  })

  it('refuses a request that comes from a web page', async () => {
    const { port } = await start()
    const fromPage = await post(port, { origin: 'http://localhost:5173' })
    expect(fromPage.status).toBe(403)
    expect(fromPage.body).toMatch(/browser origin/)
    expect((await post(port, {})).status).toBe(200)
  })

  it('refuses a Host that is not this machine (DNS rebinding)', async () => {
    const { port } = await start()
    expect((await post(port, { host: 'evil.example' })).status).toBe(403)
    expect((await post(port, { host: `localhost:${port}` })).status).toBe(200)
  })

  it('answers GET with 405, since it holds no stream open', async () => {
    const { mcpUrl } = await start()
    const response = await fetch(mcpUrl)
    expect(response.status).toBe(405)
  })
})

describe('/bridge', () => {
  it('accepts loopback and listed origins and refuses the rest', async () => {
    const { bridgeUrl } = await start({ origins: ['https://myapp.test'] })
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://app.localhost:3000',
      'https://myapp.test',
    ]) {
      const socket = await open(bridgeUrl, origin)
      socket.close()
    }
    await expect(open(bridgeUrl, 'https://evil.example')).rejects.toThrow(/403/)
    await expect(open(bridgeUrl, 'https://localhost.evil.example')).rejects.toThrow(
      /403/,
    )
    await expect(
      open(bridgeUrl.replace('/bridge', '/other'), 'http://localhost:5173'),
    ).rejects.toThrow(/403/)
  })

  it('keeps a session and marks it closed when the page goes', async () => {
    const { bridgeUrl, hub } = await start()
    const page = await open(bridgeUrl, 'http://localhost:5173')
    page.send(JSON.stringify({ kind: 'hello', session }))
    await expect.poll(() => hub.sessions.get('page-1')?.connected).toBe(true)

    const call = hub.call(hub.resolve(), 'query.list')
    page.close()
    await expect(call).rejects.toThrow('The page closed before it answered.')
    expect(hub.sessions.get('page-1')?.connected).toBe(false)
    await expect(hub.call(hub.resolve(), 'query.list')).rejects.toThrow(/no open page/)
  })

  it('times out a page that never answers', async () => {
    const { bridgeUrl, hub } = await start({ callTimeoutMs: 40 })
    const page = await open(bridgeUrl)
    page.send(JSON.stringify({ kind: 'hello', session }))
    await expect.poll(() => hub.sessions.size).toBe(1)
    await expect(hub.call(hub.resolve(), 'query.list')).rejects.toThrow(
      'The page did not answer query.list in 40 ms.',
    )
    page.close()
  })
})

describe('the bridge on a server that is not ours', () => {
  // As it runs with `standalone: false`: one upgrade handler among others on
  // the dev server the page came from.
  async function host(options: { allowHost?: (host: string | undefined) => boolean } = {}) {
    const hub = new Hub()
    const bridge = createBridge(hub, {
      path: '/__tanstack-devtools-mcp/bridge',
      sameOrigin: true,
      ...(options.allowHost ? { hostAllowed: options.allowHost } : {}),
    })
    const others: Array<string> = []
    const http = createServer()
    http.on('upgrade', (request, socket, head) => {
      if (bridge.handle(request, socket, head)) return
      // What another listener, such as Vite's own, would get.
      others.push(request.url ?? '')
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const port = (http.address() as { port: number }).port
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          bridge.close()
          http.closeAllConnections()
          http.close(() => resolve())
        }),
    )
    return { hub, port, others, url: `ws://127.0.0.1:${port}/__tanstack-devtools-mcp/bridge` }
  }
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })

  it('accepts the page it serves and leaves every other path alone', async () => {
    const { hub, port, others, url } = await host()
    const page = await open(url, `http://127.0.0.1:${port}`)
    page.send(JSON.stringify({ kind: 'hello', session }))
    await expect.poll(() => hub.sessions.get('page-1')?.connected).toBe(true)
    page.close()

    await expect(open(`ws://127.0.0.1:${port}/@vite/hmr`, `http://127.0.0.1:${port}`)).rejects.toThrow(/404/)
    expect(others).toEqual(['/@vite/hmr'])
  })

  it('refuses another site, and a site rebound to this machine under its own name', async () => {
    const { url } = await host()
    await expect(open(url, 'https://evil.example')).rejects.toThrow(/403/)
    // DNS rebinding: Host and Origin agree with each other, but name a host
    // this server was never served under.
    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { origin: 'http://evil.example:5173', headers: { host: 'evil.example:5173' } })
        socket.once('open', resolve)
        socket.once('error', reject)
      }),
    ).rejects.toThrow(/403/)
  })

  it('accepts a page under a host name the dev server allows', async () => {
    const { url, hub } = await host({ allowHost: (name) => name === 'app.test:5173' })
    const page = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, { origin: 'http://app.test:5173', headers: { host: 'app.test:5173' } })
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
    page.send(JSON.stringify({ kind: 'hello', session }))
    await expect.poll(() => hub.sessions.size).toBe(1)
    page.close()
    // Allowed host, but a page from somewhere else.
    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { origin: 'https://evil.example', headers: { host: 'app.test:5173' } })
        socket.once('open', resolve)
        socket.once('error', reject)
      }),
    ).rejects.toThrow(/403/)
  })
})
