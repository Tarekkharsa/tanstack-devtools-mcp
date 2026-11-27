import { createServer as createHttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'vite'
import { WebSocket } from 'ws'
import { loopsight } from 'loopsight/vite'
import type { AddressInfo } from 'node:net'
import type { AgentHostLike } from '@loopsight/core/server'

type Registered = Parameters<AgentHostLike['registerTool']>[0]

const closers: Array<() => unknown> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const hello = JSON.stringify({
  kind: 'hello',
  session: {
    id: 'page-1',
    url: 'http://localhost/',
    title: 'App',
    startedAt: 0,
    has: { query: true, router: true },
    tools: [],
  },
})

function open(url: string, origin: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { origin })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Runs the plugin's Vite DevTools hook against a stand-in for its agent host. */
async function asDevtools(plugin: ReturnType<typeof loopsight>) {
  const tools = new Map<string, Registered>()
  const hook = (plugin as unknown as { devtools: { setup: (context: unknown) => Promise<void> } }).devtools
  await hook.setup({ agent: { registerTool: (tool: Registered) => tools.set(tool.id, tool) } })
  return tools
}

describe('standalone: false', () => {
  it('puts the page connection on the app server in middleware mode, and opens no port', async () => {
    // An app that owns the HTTP server and mounts Vite as middleware.
    const app = createHttpServer()
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
    const port = (app.address() as AddressInfo).port
    closers.push(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve) }))

    const plugin = loopsight({ standalone: false, port: 47990 })
    const vite = await createServer({
      configFile: false,
      root: import.meta.dirname,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: { server: app }, ws: false },
      plugins: [plugin],
    })
    closers.push(() => vite.close())
    expect(vite.httpServer).toBeNull()

    const tools = await asDevtools(plugin)
    expect(tools.size).toBe(16)

    const page = await open(
      `ws://127.0.0.1:${port}/__loopsight/bridge`,
      `http://127.0.0.1:${port}`,
    )
    closers.push(() => page.close())
    page.send(hello)
    await expect
      .poll(async () => ((await tools.get('loopsight:list_sessions')!.handler({})) as any).sessions.length)
      .toBe(1)
    const listed = (await tools.get('loopsight:list_sessions')!.handler({})) as any
    expect(listed.sessions[0]).toMatchObject({ id: 'page-1', connected: true })

    // A page from elsewhere is refused on the app's server too.
    await expect(
      open(`ws://127.0.0.1:${port}/__loopsight/bridge`, 'https://evil.example'),
    ).rejects.toThrow(/403/)
    // The standalone endpoint was never started.
    await expect(fetch('http://127.0.0.1:47990/')).rejects.toThrow()
  })

  it('serves the page-side entry with a URL relative to the page, not a fixed port', async () => {
    const app = createHttpServer()
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve) }))
    const vite = await createServer({
      configFile: false,
      root: import.meta.dirname,
      logLevel: 'silent',
      appType: 'custom',
      base: '/app/',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: { server: app }, ws: false },
      plugins: [loopsight({ standalone: false })],
    })
    closers.push(() => vite.close())
    const entry = await vite.pluginContainer.load('\0loopsight:entry')
    const code = typeof entry === 'string' ? entry : (entry as { code: string }).code
    expect(code).toContain(
      `url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + "/app/__loopsight/bridge",`,
    )
    // The core is imported by name and each source by its place in the list;
    // the plugin resolves both to files on disk, so the app needs neither.
    expect(code).toContain('import { connect } from "@loopsight/core/page"')
    expect(code).toMatch(/import source0 from "loopsight-source:0"/)
    const core = await vite.pluginContainer.resolveId('@loopsight/core/page', '\0loopsight:entry')
    expect(core?.id).toMatch(/^\0loopsight:.*\/page\/index\.js$/)
    // Only this plugin's own modules may ask for them.
    expect(await vite.pluginContainer.resolveId('loopsight-source:0', '/src/main.tsx')).toBeNull()
  })

  it('leaves out a source whose library the app does not have', async () => {
    const plugin = loopsight({ standalone: false })
    const vite = await createServer({
      configFile: false,
      // Nothing is installed above the filesystem root.
      root: '/',
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, ws: false },
      plugins: [plugin],
    })
    closers.push(() => vite.close())
    const tools = await asDevtools(plugin)
    expect([...tools.keys()]).not.toContain('loopsight:list_queries')
    expect([...tools.keys()]).toContain('loopsight:list_events')
    expect(tools.size).toBe(10)
  })
})
