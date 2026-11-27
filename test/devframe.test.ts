import { describe, expect, it } from 'vitest'
import { registerOnAgentHost } from '../src/server/devframe.js'
import { Hub } from '../src/server/hub.js'
import type { AgentHostLike } from '../src/server/devframe.js'

type Registered = Parameters<AgentHostLike['registerTool']>[0]

function fakeHost() {
  const tools = new Map<string, Registered>()
  const host: AgentHostLike = { registerTool: (tool) => tools.set(tool.id, tool) }
  return { host, tools }
}

describe('the Vite DevTools adapter', () => {
  it('registers the same tools the standalone endpoint serves, with schema and safety', async () => {
    const { host, tools } = fakeHost()
    const ids = await registerOnAgentHost(host, new Hub())
    expect(ids).toHaveLength(16)
    expect(ids).toEqual([...tools.keys()])
    expect(ids).toContain('tanstack:wait_for_update')
    expect(ids).not.toContain('tanstack:navigate')

    const getQuery = tools.get('tanstack:get_query')!
    expect(getQuery.safety).toBe('read')
    expect(getQuery.description).toMatch(/usedAt/)
    expect(getQuery.inputSchema).toMatchObject({
      type: 'object',
      required: ['queryHash'],
      properties: { queryHash: { type: 'string' }, depth: { type: 'integer' } },
    })
    // Not marked read-only: it can run a tool the page registered.
    expect(tools.get('tanstack:call_page_tool')!.safety).toBe('action')
  })

  it('adds the action tools only when actions are on', async () => {
    const { host, tools } = fakeHost()
    const ids = await registerOnAgentHost(host, new Hub(), { actions: true })
    expect(ids).toHaveLength(20)
    expect(tools.get('tanstack:navigate')!.safety).toBe('action')
  })

  it('runs a tool against the shared hub and returns its value, not MCP framing', async () => {
    const hub = new Hub()
    const { host, tools } = fakeHost()
    await registerOnAgentHost(host, hub)
    expect(await tools.get('tanstack:list_sessions')!.handler({})).toEqual({
      actions: false,
      sessions: [],
    })
    // Devframe may call with no arguments at all.
    expect(await tools.get('tanstack:list_sessions')!.handler(undefined)).toMatchObject({ sessions: [] })
  })

  it('turns a tool error into a thrown error, which the host reports to the agent', async () => {
    const { host, tools } = fakeHost()
    await registerOnAgentHost(host, new Hub())
    await expect(tools.get('tanstack:overview')!.handler({})).rejects.toThrow(
      /No page has connected yet/,
    )
  })
})
