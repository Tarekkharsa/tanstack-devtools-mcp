# tanstack-devtools-mcp

An MCP server that lets a coding agent see inside a running TanStack app, and see what each of its edits did.

One Vite plugin, no code in the app. The agent gets the Query cache, the Router, network calls, console errors and Vite's own hot updates and build errors on a single numbered timeline, with each entry traced back to the source line it came from.

Unofficial and experimental. Not affiliated with TanStack. Not on npm yet.

The idea comes from [`@effect/ui-devtools`](https://github.com/Effect-TS/ui/tree/main/packages/ui-devtools), which gives agents a local MCP endpoint over an app's message log. This brings that to apps already written with React, TanStack and Vite, and adds the half of the loop that sits in the dev server.

## What an agent can do with it

**Know what an edit did.** After saving a file, one call says whether it compiled, whether it hot-updated or reloaded, and what the page did next:

```
wait_for_update
→ update: "hmr-update"
  files: ["src/Cart.tsx"]
  idle: true
  problems: [ query/error  ["cart"] error: Error: 500   from useCart src/hooks/cart.ts:12:20 ]
```

A broken edit comes back as the build error, with its file, line and code frame, instead of a page that silently kept the old code.

**Find the code behind what it sees.** Entries carry `from`, resolved through Vite's source maps to the line the developer wrote:

```
get_query { "queryHash": "[\"posts\"]" }
→ usedAt: [ "loader src/routes/posts.tsx:8:17",
            "Posts src/routes/posts.tsx:21:26" ]
```

**Read one timeline instead of five panels.**

```
 41  router/onBeforeNavigate        /posts → /posts/2
 42  query/fetch                    ["post",2] fetching              from loader src/routes/post.tsx:9:17
 43  network/ok              84 ms  GET /api/posts/2 → 200           from request src/api.ts:6:26
 44  query/success           86 ms  ["post",2] success
 45  router/onResolved       91 ms  /posts → /posts/2
```

**Ask what is wrong.** `diagnose` reads the log and the live page and returns findings with evidence: build errors, uncaught errors, failed requests, failed queries and routes, a query refetching in a loop, the same request in flight twice, hydration mismatches, and the slowest queries, requests and navigations.

## Try it

```sh
git clone https://github.com/Tarekkharsa/tanstack-devtools-mcp
cd tanstack-devtools-mcp
pnpm install
pnpm example
```

Open the URL Vite prints, then connect your agent to `http://127.0.0.1:4777/mcp`. For Claude Code:

```sh
claude mcp add --transport http tanstack http://127.0.0.1:4777/mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "tanstack": { "type": "http", "url": "http://127.0.0.1:4777/mcp" }
  }
}
```

## Use it in an app

```ts
// vite.config.ts
import { tanstackDevtoolsMcp } from 'tanstack-devtools-mcp/vite'

export default defineConfig({
  plugins: [tanstackDevtoolsMcp()],
})
```

That is the whole setup. The plugin runs with `vite dev` only, and:

- connects every page the dev server serves, through `index.html` for a single-page app and through Vite's own client for a framework that renders the document on the server, such as TanStack Start
- finds the router on `window.__TSR_ROUTER__`, where TanStack Router puts it
- finds the `QueryClient` in the router context (`context.queryClient`) or on `window.__TANSTACK_QUERY_CLIENT__`

If your `QueryClient` is in neither place, hand it over:

```ts
if (import.meta.env.DEV) {
  const { connect } = await import('tanstack-devtools-mcp/client')
  connect({ queryClient })
}
```

## Tools

| Tool | Does |
| --- | --- |
| `overview` | the page in one call: URL, matched routes, the cache by status, what is fetching or failed, pending requests, the latest problems |
| `diagnose` | findings with evidence, as above |
| `wait_for_update` | after an edit: what Vite did, then what the page did; follows the page across a reload |
| `wait_for_idle` | waits for queries, mutations, the router and requests to settle, and returns what happened since an entry |
| `list_events` | the timeline, filtered by source, type, key, text, or `problems: true` |
| `get_event` | one event in full, with its app stack frames |
| `count_events` | events counted by source and type |
| `list_queries` | the query cache as compact rows, with counts by status and by key family |
| `get_query` | one query: data, error, and where in the source it is used; `path` reads a subtree in full |
| `diff_query` | what the last change to a query's data changed, by path |
| `list_mutations` | the last 100 mutations with status, variables and error |
| `get_router_state` | status, location, and each matched route's params, search, error and loader data |
| `list_routes` | the routes, with a `contains` filter for large apps |
| `list_sessions` | the pages that connected and whether each is still open |
| `list_page_tools` | the tools libraries registered in the page |
| `call_page_tool` | runs one of them |

With `actions: true`:

| Tool | Does |
| --- | --- |
| `query_action` | invalidates, refetches, resets or removes matching queries |
| `set_query_data` | replaces a query's cached data |
| `navigate` | navigates with the router |
| `invalidate_router` | reruns the matched routes' loaders |

### The timeline

| Source | Records |
| --- | --- |
| `query`, `mutation` | cache events, with the time each fetch took and the code that started it |
| `router` | navigation events, with the time to resolve and any route error |
| `network` | `fetch` and `XMLHttpRequest`: method, URL, status and time. Bodies and headers are never read. TanStack Start server functions are shown by name |
| `console` | `console.error`, `console.warn`, uncaught errors and unhandled rejections. A message repeated within five seconds is recorded once, then once more with the count |
| `vite` | a module changed, a hot update, a full reload, a build error, an error the dev server logged |
| `bus` | TanStack Devtools event-bus events, when that panel is mounted |

The server keeps its own copy, 1,000 entries per session by default (`size`). `list_events`, `get_event`, `count_events` and `diagnose` answer from that copy, so they still work after a reload or a closed tab. A page that loads after a reload starts its log with the Vite event that caused it.

Outputs are sized for an agent's context. Rows leave out fields at their usual value, summaries are cut at 200 characters, and data is cut at a depth, 50 items per container and 2,000 characters per string, with a note of how much was left out. `path` and `get_event` reach the rest.

### Actions are off by default

The read tools cannot change your app. The four action tools are registered only with `tanstackDevtoolsMcp({ actions: true })` or `--actions`. `call_page_tool` runs a registered tool without that flag only when the tool declares `readOnlyHint: true`.

### Tools from other libraries

TanStack Devtools has a registry for agent tools, [`@tanstack/devtools-webmcp`](https://github.com/TanStack/devtools/tree/main/packages/devtools-webmcp). A library calls `registerDevtoolsTools` and the tools land in the browser's WebMCP API, `document.modelContext`. Today that reaches only agents driving a browser that ships WebMCP.

This package serves the same tools over the Node MCP endpoint, so any agent can call them:

```ts
import { registerDevtoolsTools } from '@tanstack/devtools-webmcp'

registerDevtoolsTools({
  pluginId: 'cart',
  tools: [
    {
      name: 'getCart',
      description: 'The cart as the store holds it.',
      annotations: { readOnlyHint: true },
      execute: () => cartStore.state,
    },
  ],
})
```

```
call_page_tool { "name": "cart.getCart" }
```

In a browser without WebMCP, the page-side code defines a minimal `document.modelContext` so the registration has somewhere to go. In a browser with it, `registerTool` is wrapped and the browser still gets every tool.

## Without Vite

Run the server on its own and connect the page yourself:

```sh
tanstack-devtools-mcp [--port <n>] [--size <n>] [--actions] [--origin <url>]...
```

```ts
connect({ url: 'ws://127.0.0.1:4777/bridge', queryClient, router })
```

Without the plugin there are no `vite` entries, `wait_for_update` has nothing to wait for, and source places keep the served file's line numbers, marked `(served code)`.

## Security

The server listens on `127.0.0.1` only and has no option to listen elsewhere.

- `/mcp` refuses any request with an `Origin` header, so a web page cannot call the tools.
- Both routes refuse a `Host` header that is not a loopback name, which stops DNS rebinding.
- `/bridge` accepts WebSocket connections from loopback origins and the ones you list in `origins`.

There is no token. Any process on your machine can connect, as it can to the Vite dev server. Query data, loader data and request URLs are sent to whoever connects, so do not run it against data you would not show a local process.

## Status and limits

Verified: React 19, TanStack Query 5, TanStack Router 1.170, Vite 8 and Chrome, on a single-page app and on a production-sized TanStack Start app under Vite+. `pnpm test` runs the unit and HTTP tests and `pnpm e2e` drives the example in headless Chrome through the MCP endpoint, including a hot update, a build error and its fix.

Not verified: the Vue, Solid, Svelte and Angular adapters, and Vite below 8. The page-side code reads Query and Router by shape, not by import, so they may work.

Known limits:

- **Server-rendered apps connect a moment late.** With no `index.html` to put a script in, the page connects through Vite's client, after the first modules have run. What it missed is summarised in an `attached` entry, and queries a server render sent along have no `usedAt` until a component reads them again.
- **Nothing from the server side of an SSR app.** Loaders and server functions that run in Node are seen only as the requests the browser made.
- **No time travel.** Effect UI can repaint the page at any past entry because its state is one message log. Query and Router have no equivalent to replay; `diff_query` shows the last change only.
- **No panel.** This has no UI of its own.
- **TanStack Form, Table, Store, Pacer and DB have no built-in tools.** They can register their own through `@tanstack/devtools-webmcp`.
- `diagnose` reports what the log shows. Its loop and duplicate-request rules are thresholds, not proofs.

## Development

```sh
pnpm test        # unit and HTTP tests
pnpm e2e         # the example in headless Chrome; needs Google Chrome
pnpm typecheck
```

## License

MIT
