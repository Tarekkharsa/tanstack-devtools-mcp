import { createServer } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { WebSocketServer } from 'ws'
import { BRIDGE_PATH, DEFAULT_PORT, MCP_PATH, NAME } from '../protocol.js'
import { Hub } from './hub.js'
import { createMcpServer } from './mcp.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { HubOptions } from './hub.js'
import type { McpOptions } from './mcp.js'

export interface ServerOptions extends HubOptions, McpOptions {
  /** Default 4777. Pass 0 for any free port. */
  port?: number
  /**
   * Extra page origins allowed to open the bridge, such as
   * `https://myapp.test`. Loopback origins are always allowed.
   */
  origins?: Array<string>
  /** A hub made by the caller, to share it with another way of serving the tools. */
  hub?: Hub
}

export interface RunningServer {
  port: number
  /** The MCP endpoint agents connect to. */
  mcpUrl: string
  /** The WebSocket URL pages connect to. */
  bridgeUrl: string
  hub: Hub
  close: () => Promise<void>
}

const HOST = '127.0.0.1'
const MAX_BODY = 4 * 1024 * 1024
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackName(hostname: string): boolean {
  return loopback.has(hostname) || hostname.endsWith('.localhost')
}

/** The `Host` header must name this machine, which stops DNS rebinding. */
function hostAllowed(host: string | undefined): boolean {
  if (host === undefined) return false
  try {
    return isLoopbackName(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function rpcError(response: ServerResponse, status: number, message: string) {
  json(response, status, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  })
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Request body is not JSON'))
      }
    })
    request.on('error', reject)
  })
}

export interface BridgeOptions {
  /** The path pages connect to. */
  path: string
  /** Extra page origins allowed to connect. Loopback origins always are. */
  origins?: Array<string>
  /**
   * Whether a `Host` header names this server. Defaults to loopback names
   * only. A dev server that is reached under another name passes its own rule.
   */
  hostAllowed?: (host: string | undefined) => boolean
  /**
   * Also accept a page whose origin is the host it connected to, for a bridge
   * that lives on the dev server the page itself came from.
   */
  sameOrigin?: boolean
}

export interface Bridge {
  /**
   * Handles an HTTP upgrade request. Returns false, having touched nothing,
   * when the request is for another path, so other listeners can take it.
   */
  handle: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  close: () => void
}

/** The page side of the hub, as an upgrade handler for any Node HTTP server. */
export function createBridge(hub: Hub, options: BridgeOptions): Bridge {
  const extraOrigins = new Set(options.origins ?? [])
  const isHost = options.hostAllowed ?? hostAllowed
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })

  const originAllowed = (origin: string | undefined, host: string | undefined) => {
    if (origin === undefined) return true
    if (extraOrigins.has(origin)) return true
    try {
      const url = new URL(origin)
      if (isLoopbackName(url.hostname)) return true
      return options.sameOrigin === true && host !== undefined && url.host === host
    } catch {
      return false
    }
  }

  return {
    handle(request, socket, head) {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path !== options.path) return false
      const host = request.headers.host
      if (!isHost(host) || !originAllowed(request.headers.origin, host)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return true
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        hub.attach({
          send: (text) => ws.send(text),
          onMessage: (listener) => ws.on('message', (data) => listener(String(data))),
          onClose: (listener) => ws.on('close', listener),
        })
      })
      return true
    },
    close() {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
    },
  }
}

/**
 * Starts the server on loopback: `/mcp` for agents (MCP over Streamable HTTP)
 * and `/bridge` for pages (WebSocket).
 *
 * It listens on 127.0.0.1 only and has no option to listen elsewhere. `/mcp`
 * refuses any request that carries an `Origin` header, so a web page cannot
 * call the tools, and `/bridge` accepts only loopback origins and the ones in
 * `origins`. There is no token: any local process can connect, as it can to
 * the dev server itself.
 */
export function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const hub = options.hub ?? new Hub(options)
  const bridge = createBridge(hub, {
    path: BRIDGE_PATH,
    ...(options.origins ? { origins: options.origins } : {}),
  })

  const handleMcp = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.origin !== undefined) {
      rpcError(response, 403, 'Requests from a browser origin are refused.')
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      rpcError(response, 405, 'Method not allowed.')
      return
    }
    let body: unknown
    try {
      body = await readBody(request)
    } catch (error) {
      rpcError(response, 400, error instanceof Error ? error.message : 'Bad request')
      return
    }
    // Stateless: each request gets its own server over the shared hub.
    const mcp = createMcpServer(hub, options)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    response.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(request, response, body)
  }

  const server = createServer((request, response) => {
    if (!hostAllowed(request.headers.host)) {
      json(response, 403, { error: 'Host not allowed' })
      return
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === MCP_PATH) {
      handleMcp(request, response).catch((error) => {
        if (response.headersSent) response.end()
        else rpcError(response, 500, String(error))
      })
      return
    }
    if (path === '/' && request.method === 'GET') {
      json(response, 200, {
        name: NAME,
        mcp: MCP_PATH,
        actions: options.actions === true,
        sessions: [...hub.sessions.values()].filter((s) => s.connected).length,
      })
      return
    }
    json(response, 404, { error: 'Not found' })
  })

  server.on('upgrade', (request, socket, head) => {
    // Nothing else lives on this server, so any other path is refused.
    if (!bridge.handle(request, socket, head)) socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DEFAULT_PORT, HOST, () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        mcpUrl: `http://${HOST}:${port}${MCP_PATH}`,
        bridgeUrl: `ws://${HOST}:${port}${BRIDGE_PATH}`,
        hub,
        close: () =>
          new Promise((done) => {
            bridge.close()
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}
