# tanstack-devtools-mcp

An MCP server that lets a coding agent see inside a running TanStack app: the Query cache, the Router, a log of what happened, and any tool a library registered for agents.

Unofficial and experimental. Not affiliated with TanStack. Not on npm yet.

The idea comes from [`@effect/ui-devtools`](https://github.com/Effect-TS/ui/tree/main/packages/ui-devtools), which gives agents a local MCP endpoint over an app's message log. This does the same for TanStack Query and Router.

## Why

An agent editing a TanStack app can read your code but not your app. To know whether a query refetched, which route matched, or why a loader failed, it has to drive a browser and read the DOM.

With this running, it asks:

```
navigate            { "to": "/posts/$postId", "params": { "postId": "2" } }
wait_for_idle       { "after": 14 }
→ router/onBeforeNavigate  /posts → /posts/2
  query/fetch              ["post",2] → pending/fetching
  query/success            ["post",2] → success/idle
  router/onResolved        /posts → /posts/2
```

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

Add the Vite plugin. It starts the server with `vite dev` only and connects the page.

```ts
// vite.config.ts
import { tanstackDevtoolsMcp } from 'tanstack-devtools-mcp/vite'

export default defineConfig({
  plugins: [tanstackDevtoolsMcp()],
})
```

Then hand over your `QueryClient`. The router needs nothing: TanStack Router puts itself on `window.__TSR_ROUTER__` and the page picks it up.

```ts
if (import.meta.env.DEV) {
  const { connect } = await import('tanstack-devtools-mcp/client')
  connect({ queryClient })
}
```

If you already set `window.__TANSTACK_QUERY_CLIENT__` for the Query browser extension, skip this step; that is found too.

## Tools

| Tool | Does |
| --- | --- |
| `list_sessions` | the pages that connected, whether each is still open, and what it has |
| `list_queries` | the query cache as rows: hash, key, status, fetch status, stale, observers, error |
| `get_query` | one query with its data, cut to a bounded size |
| `list_mutations` | the last 100 mutations with status, variables and error |
| `get_router_state` | status, location, and each matched route's params, search, error and loader data |
| `list_routes` | every route, its parent, and whether it has a loader, `beforeLoad` or search validation |
| `list_events` | the recorded log, filtered by source, type, key or text |
| `get_event` | one event with its detail |
| `count_events` | events counted by source and type |
| `wait_for_idle` | waits for queries, mutations and the router to settle, and returns what happened since an entry |
| `list_page_tools` | the tools libraries registered in the page |
| `call_page_tool` | runs one of them |

With `actions: true`:

| Tool | Does |
| --- | --- |
| `query_action` | invalidates, refetches, resets or removes matching queries |
| `set_query_data` | replaces a query's cached data |
| `navigate` | navigates with the router |
| `invalidate_router` | reruns the matched routes' loaders |

### The log

The page records query and mutation cache events, router navigation events, `console.error`, `console.warn`, uncaught errors, and events on the TanStack Devtools event bus when that panel is mounted. Observer bookkeeping is left out.

The server keeps its own copy, 1,000 entries per session by default (`size`). `list_events`, `get_event` and `count_events` answer from that copy, so they still work after a reload or a closed tab. Every other tool reads the live page and needs it open.

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

In a browser without WebMCP, the client module defines a minimal `document.modelContext` so the registration has somewhere to go. In a browser with it, `registerTool` is wrapped and the browser still gets every tool. Import the client before the code that registers tools; the Vite plugin does this for you.

## Without Vite, or with an SSR framework

Run the server on its own:

```sh
tanstack-devtools-mcp [--port <n>] [--size <n>] [--actions] [--origin <url>]...
```

and connect the page from your client entry:

```ts
connect({ url: 'ws://127.0.0.1:4777/bridge', queryClient, router })
```

The plugin connects the page through a script it adds to `index.html`. A framework that renders its own document, such as TanStack Start, has no `index.html` to add it to, so put the `connect` call above in your client code.

## Security

The server listens on `127.0.0.1` only and has no option to listen elsewhere.

- `/mcp` refuses any request with an `Origin` header, so a web page cannot call the tools.
- Both routes refuse a `Host` header that is not a loopback name, which stops DNS rebinding.
- `/bridge` accepts WebSocket connections from loopback origins and the ones you list in `origins`.

There is no token. Any process on your machine can connect, as it can to the Vite dev server. Query data and loader data are sent to whoever connects, so do not run it against data you would not show a local process.

## Status and limits

Verified: React, TanStack Query 5, TanStack Router 1.170, Vite 8, Chrome. `pnpm test` runs 26 tests and `pnpm e2e` drives the example in headless Chrome through the MCP endpoint.

Not verified: the Vue, Solid, Svelte and Angular adapters, TanStack Start, and Vite below 8. The client reads Query and Router by shape, not by import, so they may work.

Not there:

- No time travel. Effect UI can repaint the page at any past entry because its state is one message log; Query and Router have no equivalent to replay.
- No panel. This has no UI of its own.
- State is read live. Only the event log survives a reload, not the cache contents.
- TanStack Form, Table, Store, Pacer and DB have no built-in tools. They can register their own through `@tanstack/devtools-webmcp`.

## Development

```sh
pnpm test        # unit and HTTP tests
pnpm e2e         # the example in headless Chrome; needs Google Chrome
pnpm typecheck
```

## License

MIT
