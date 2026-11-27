import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer, instructions } from './mcp.js'
import type { Hub } from './hub.js'
import type { McpOptions } from './mcp.js'

/**
 * The part of Devframe's agent host this adapter uses. Devframe is what
 * Vite DevTools is built on; typing it by shape keeps it an optional peer.
 */
export interface AgentHostLike {
  registerTool: (tool: {
    id: string
    title?: string
    description: string
    safety?: 'read' | 'action' | 'destructive'
    inputSchema?: unknown
    handler: (args: any) => unknown
  }) => unknown
}

/**
 * Registers this package's tools on a Devframe agent host, so they are
 * served from the host's own MCP route next to every other plugin's tools.
 *
 * The tools are not defined a second time: they are read from the same
 * server the standalone endpoint uses, over an in-memory connection.
 */
export async function registerOnAgentHost(
  agent: AgentHostLike,
  hub: Hub,
  options: McpOptions = {},
): Promise<Array<string>> {
  const server = createMcpServer(hub, options)
  const client = new Client({ name: 'tanstack-devtools-mcp/devframe', version: '0.0.0' })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])

  const { tools } = await client.listTools()
  for (const tool of tools) {
    agent.registerTool({
      id: `tanstack:${tool.name}`,
      ...(tool.title ? { title: tool.title } : {}),
      // A shared route has no place for this server's own instructions, so
      // the tool an agent is told to start with carries them.
      description:
        tool.name === 'overview'
          ? `${tool.description ?? ''} How to use the tanstack tools: ${instructions}`
          : (tool.description ?? tool.name),
      safety: tool.annotations?.readOnlyHint === true ? 'read' : 'action',
      inputSchema: tool.inputSchema,
      handler: async (args) => {
        const result = (await client.callTool({
          name: tool.name,
          arguments: args ?? {},
        })) as { isError?: boolean; content: Array<{ text: string }> }
        const text = result.content[0]?.text ?? ''
        if (result.isError) throw new Error(text)
        return JSON.parse(text)
      },
    })
  }
  return tools.map((tool) => `tanstack:${tool.name}`)
}
