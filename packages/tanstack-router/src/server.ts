import { z } from 'zod'
import { ROUTER_MESSAGES, ROUTER_RULES, ROUTER_SLOW } from './rules.js'
import type { ServerSource, SourceTool } from '@loopsight/core/server'

const tools: Array<SourceTool> = [
  {
    name: 'get_router_state',
    description:
      'TanStack Router state: status, location, and each matched route with its params, search, status, error and loader data.',
    input: {
      depth: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe('Levels of loader data to keep. Default 3.'),
    },
    run: (args, { call }) => call('router.state', args),
  },
  {
    name: 'list_routes',
    description:
      'The routes the router knows: id, full path where it differs, and `has` listing loader, beforeLoad or search validation. Use `contains` on a large app.',
    input: {
      contains: z.string().optional().describe('Substring of the route id or full path.'),
      limit: z.number().int().min(1).max(1000).optional().describe('Default 100.'),
    },
    run: (args, { call }) => call('router.routes', args),
  },
  {
    name: 'navigate',
    action: true,
    description:
      'Navigates with the router, as router.navigate does, and returns the new location once the navigation settles.',
    input: {
      to: z.string().describe('A path such as /posts/$postId or /posts/3.'),
      params: z.record(z.string(), z.unknown()).optional(),
      search: z.record(z.string(), z.unknown()).optional(),
      hash: z.string().optional(),
      replace: z.boolean().optional(),
    },
    run: (args, { call }) => call('router.navigate', args),
  },
  {
    name: 'invalidate_router',
    action: true,
    description: 'Reruns the loaders of the matched routes.',
    input: {},
    run: (_args, { call }) => call('router.invalidate'),
  },
]

/** TanStack Router, seen from the server: its tools and the rules that judge it. */
export const routerServerSource: ServerSource = {
  key: 'router',
  title: 'TanStack Router',
  about: 'For TanStack Router, get_router_state reads the matched routes and list_routes the route tree.',
  writes: {
    router: 'navigation events: onBeforeNavigate, onBeforeLoad, onLoad, onResolved',
  },
  tools,
  rules: ROUTER_RULES,
  messages: ROUTER_MESSAGES,
  slow: ROUTER_SLOW,
}
