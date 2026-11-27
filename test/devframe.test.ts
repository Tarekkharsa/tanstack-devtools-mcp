import { describe, expect, it } from 'vitest'
import { Hub, registerOnAgentHost } from '@loopsight/core/server'
import { SOURCES } from './support.js'
import type { AgentHostLike } from '@loopsight/core/server'

type Registered = Parameters<AgentHostLike['registerTool']>[0]

function fakeHost() {
  const tools = new Map<string, Registered>()
  const host: AgentHostLike = { registerTool: (tool) => tools.set(tool.id, tool) }
  return { host, tools }
}

describe('the Vite DevTools adapter', () => {
  it('registers the same tools the standalone endpoint serves, with schema and safety', async () => {
    const { host, tools } = fakeHost()
    const ids = await registerOnAgentHost(host, new Hub(), { sources: SOURCES })
    expect(ids).toHaveLength(17)
    expect(ids).toEqual([...tools.keys()])
    expect(ids).toContain('loopsight:wait_for_update')
    expect(ids).not.toContain('loopsight:navigate')

    const getQuery = tools.get('loopsight:get_query')!
    expect(getQuery.safety).toBe('read')
    expect(getQuery.description).toMatch(/usedAt/)
    expect(getQuery.inputSchema).toMatchObject({
      type: 'object',
      required: ['queryHash'],
      properties: { queryHash: { type: 'string' }, depth: { type: 'integer' } },
    })
    // The shared route cannot deliver this server's instructions, so the
    // tool an agent starts with carries them. No other tool repeats them.
    expect(tools.get('loopsight:overview')!.description).toMatch(
      /Start here\. How to use the loopsight tools: .*call wait_for_update/,
    )
    expect(getQuery.description).not.toMatch(/How to use the loopsight tools/)
    // Not marked read-only: it can run a tool the page registered.
    expect(tools.get('loopsight:call_page_tool')!.safety).toBe('action')
  })

  it('adds the action tools only when actions are on', async () => {
    const { host, tools } = fakeHost()
    const ids = await registerOnAgentHost(host, new Hub(), { actions: true, sources: SOURCES })
    expect(ids).toHaveLength(21)
    expect(tools.get('loopsight:navigate')!.safety).toBe('action')
  })

  it('runs a tool against the shared hub and returns its value, not MCP framing', async () => {
    const hub = new Hub()
    const { host, tools } = fakeHost()
    await registerOnAgentHost(host, hub, { sources: SOURCES })
    expect(await tools.get('loopsight:list_sessions')!.handler({})).toEqual({
      actions: false,
      sessions: [],
    })
    // Devframe may call with no arguments at all.
    expect(await tools.get('loopsight:list_sessions')!.handler(undefined)).toMatchObject({ sessions: [] })
  })

  it('turns a tool error into a thrown error, which the host reports to the agent', async () => {
    const { host, tools } = fakeHost()
    await registerOnAgentHost(host, new Hub(), { sources: SOURCES })
    await expect(tools.get('loopsight:overview')!.handler({})).rejects.toThrow(
      /No page has connected yet/,
    )
  })
})

describe('the Vite DevTools adapter with no sources', () => {
  it('registers only the tools the core has by itself', async () => {
    const { host } = fakeHost()
    const ids = await registerOnAgentHost(host, new Hub(), { actions: true })
    expect(ids).toEqual(
      [
        'list_sessions',
        'overview',
        'diagnose',
        'list_events',
        'get_event',
        'count_events',
        'wait_for_idle',
        'wait_for_update',
        'list_page_tools',
        'call_page_tool',
      ].map((name) => `loopsight:${name}`),
    )
  })
})
