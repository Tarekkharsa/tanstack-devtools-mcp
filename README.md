# loopsight

Lets a coding agent see a running web app, and see what each of its edits did.

After the agent saves a file, one call tells it whether the edit compiled, whether the page hot-updated or reloaded, and what the app did next, on a single numbered timeline where each entry is traced back to the source line it came from. It is served over MCP, so any agent can use it.

It is built from small parts. A **core** that knows no library, **sources** that each teach it one library, and a **host** that connects it to a dev server. TanStack Query, Router and Start on Vite work with one line of config and no code in the app; anything else can be added as a source without changing the core.

Unofficial and experimental. Not affiliated with TanStack or Vite. Not on npm yet.

The idea comes from [`@effect/ui-devtools`](https://github.com/Effect-TS/ui/tree/main/packages/ui-devtools), which gives agents a local MCP endpoint over an app's message log. This brings that to apps already written with other libraries, and adds the half of the loop that sits in the dev server.

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

**Ask what is wrong, and get the documented fix.** `diagnose` reads the log and the live page. Besides plain failures (build errors, uncaught errors, failed requests, queries and routes), it checks for the mistakes the libraries' own documentation names, and answers each with the recommended way and where it says so:

```
diagnose
→ [warning] 3 queries sent by the server render fetched again as the page loaded
    fix:  Set a default `staleTime` above 0 on the QueryClient (the docs use `60 * 1000`). With the
          default of 0, data the server just rendered counts as stale and is fetched again on page load.
    docs: TanStack Query docs: Server Rendering & Hydration
          https://tanstack.com/query/latest/docs/framework/react/guides/ssr
```

## Try it

```sh
git clone https://github.com/Tarekkharsa/loopsight
cd loopsight
pnpm install
pnpm example
```

Open the URL Vite prints, then connect your agent to `http://127.0.0.1:4777/mcp`. For Claude Code:

```sh
claude mcp add --transport http loopsight http://127.0.0.1:4777/mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "loopsight": { "type": "http", "url": "http://127.0.0.1:4777/mcp" }
  }
}
```

## Use it in an app

```ts
// vite.config.ts
import { loopsight } from 'loopsight/vite'

export default defineConfig({
  plugins: [loopsight()],
})
```

That is the whole setup. The plugin runs with `vite dev` only, and:

- connects every page the dev server serves, through `index.html` for a single-page app and through Vite's own client for a framework that renders the document on the server, such as TanStack Start
- turns on each built-in source whose library the app has installed, and leaves the others out, tools and all
- finds the router on `window.__TSR_ROUTER__`, where TanStack Router puts it
- finds the `QueryClient` in the router context (`context.queryClient`) or on `window.__TANSTACK_QUERY_CLIENT__`

The dev server prints which sources are on, next to the MCP address. A library counts as installed when it is in a `node_modules` folder at or above the app, including pnpm's shared one. If yours is somewhere else and its source is missing, pass `loopsight({ detect: false })` to turn on every source listed.

If your `QueryClient` is in neither place, hand it over:

```ts
if (import.meta.env.DEV) {
  const { connect } = await import('loopsight/client')
  connect({ queryClient })
}
```

## How it is put together

| Package | What it is |
| --- | --- |
| `@loopsight/core` | The page bridge, the session log, the rule engine and the ten tools that need no library: the timeline, `diagnose`, the waits, sessions and page tools. It records the console and the network by itself. |
| `@loopsight/vite` | The host for Vite. Connects every page, records hot updates, reloads and build errors, maps stack frames to source lines, and registers the tools with Vite DevTools when it is on. |
| `@loopsight/tanstack-query` | A source: cache and mutation events, four read tools, two actions, 15 rules. |
| `@loopsight/tanstack-router` | A source: navigation events, two read tools, two actions, 12 rules. |
| `@loopsight/tanstack-start` | A source: names server functions in the network log, and adds five rules. |
| `@loopsight/tanstack-devtools` | A source: the TanStack Devtools event bus. |
| `loopsight` | The preset: the Vite host with the four sources above, plus the `loopsight` command. |

To choose the sources yourself, pass them. This is `loopsight()` spelled out:

```ts
import { loopsightVite } from '@loopsight/vite'
import { tanstackQuery } from '@loopsight/tanstack-query'
import { tanstackRouter } from '@loopsight/tanstack-router'

loopsightVite({ sources: [tanstackRouter(), tanstackQuery(), myStore()] })
```

With `sources: []` you get the core alone: console, network, the dev server and the page tools, for any app Vite serves.

### Adding a library

A source has two halves. The page half records what the library does and answers questions about it; the server half says which tools an agent gets and which rules judge it. Neither half touches the core.

```ts
// my-store/page.ts: runs in the browser
import type { PageSource } from '@loopsight/core/page'

const source: PageSource<Store> = {
  key: 'cart',
  instance: {
    label: 'cart store',
    accepts: (value): value is Store => typeof (value as Store)?.subscribe === 'function',
    globals: ['__CART_STORE__'], // watched, so it attaches the moment the app sets it
    find: ({ global }) => global.__CART_STORE__,
    missing: 'No cart store on this page. Pass it to connect({ instances: { cart } }).',
  },
  attach: (store, { record }) => ({
    stop: store.subscribe(({ item, quantity }) =>
      record({ source: 'cart', type: 'set', key: item, summary: `${item} = ${quantity}`, detail: { quantity } }),
    ),
    handlers: { 'cart.state': () => store.getState() },
    overview: () => ({ lines: Object.keys(store.getState().items).length }),
    facts: () => ({ max: 99 }),
  }),
}
export default source
```

```ts
// my-store/index.ts: runs in Node
import { fileURLToPath } from 'node:url'
import type { ServerSource, SourceDescriptor } from '@loopsight/core/server'

const server: ServerSource = {
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
  ],
  rules: [
    {
      id: 'cart/over-limit',
      fix: 'Clamp the quantity to the limit before writing it to the store.',
      docs: { label: 'Cart docs: Limits', at: 'https://example.com/cart/limits' },
      check: ({ by, facts }) => {
        const max = facts<{ max: number }>('cart')?.max ?? Infinity
        const over = by('cart', 'set').filter((entry) => (entry.detail as { quantity: number }).quantity > max)
        return over.length === 0
          ? []
          : [{ severity: 'warning', title: `An item was set above the limit of ${max}`, entries: over.map((e) => e.n), evidence: over.map((e) => e.summary) }]
      },
    },
  ],
}

export function myStore(): SourceDescriptor {
  return {
    key: 'cart',
    server,
    page: fileURLToPath(new URL('./page.js', import.meta.url)),
    detect: ['my-store'], // left out of apps that do not have the library
  }
}
```

What that buys: `get_cart` next to the other tools, the store's changes on the same timeline as navigations and requests, `overview.cart`, the rule's finding in `diagnose` with its fix and source, and `wait_for_idle` holding while the source says it is busy. A tool marked `action: true` is registered only when actions are on. [`test/custom-source.test.ts`](test/custom-source.test.ts) is this example, running.

A rule reads recorded facts (`detail`, the `facts` a page half reports), never the wording of a summary, so a source can reword what it shows without breaking a rule.

A host is the other kind of part: whatever serves the page and can see the dev server. Vite is the one that exists. One for another bundler would use the same pieces the Vite host does, all exported from `@loopsight/core/server`: `startServer` or `createBridge` to accept pages, `hub.recordServer` for what the dev server does, a `resolveFrame` function for source maps, and `registerOnAgentHost` to put the tools on a shared MCP route.

## Tools

From the core, in every setup:

| Tool | Does |
| --- | --- |
| `overview` | the page in one call: URL, each source's summary, pending requests, the latest problems |
| `diagnose` | what is wrong and what the libraries document as a mistake, each with evidence, the documented fix and its source |
| `wait_for_update` | after an edit: what the dev server did, then what the page did; follows the page across a reload |
| `wait_for_idle` | waits for every source and the network to settle, and returns what happened since an entry |
| `list_events` | the timeline, filtered by source, type, key, text, or `problems: true` |
| `get_event` | one event in full, with its app stack frames |
| `count_events` | events counted by source and type |
| `list_sessions` | the pages that connected, what each has, and whether it is still open |
| `list_page_tools` | the tools libraries registered in the page |
| `call_page_tool` | runs one of them |

From the TanStack Query and Router sources:

| Tool | Does |
| --- | --- |
| `list_queries` | the query cache as compact rows, with counts by status and by key family |
| `get_query` | one query: data, error, and where in the source it is used; `path` reads a subtree in full |
| `diff_query` | what the last change to a query's data changed, by path |
| `list_mutations` | the last 100 mutations with status, variables and error |
| `get_router_state` | status, location, and each matched route's params, search, error and loader data |
| `list_routes` | the routes, with a `contains` filter for large apps |

With `actions: true`:

| Tool | Does |
| --- | --- |
| `query_action` | invalidates, refetches, resets or removes matching queries |
| `set_query_data` | replaces a query's cached data |
| `navigate` | navigates with the router |
| `invalidate_router` | reruns the matched routes' loaders |

### What `diagnose` checks

The core reports plain failures by itself: a build error, an uncaught error, a failed request, the same request in flight twice. Each source adds its own, and every finding names its rule (`query/hydrated-refetch`, `vite/fast-refresh-defeated`).

Every rule below comes from a library's own material, and each finding carries a `fix` restating it and a `docs` reference: a URL, or the path of an agent skill the library ships inside its npm package, which an agent can open in `node_modules`. The thresholds (how many fetches, how many milliseconds) are this project's; the sources give none.

From the TanStack Query guides:

- data sent by the server render fetched again as the page loads
- a prefetch or loader fetch followed by a second fetch when the component mounts
- a failed HTTP response inside a query that ended as a success
- a query with no `staleTime` fetching again and again
- refetch triggers switched off while `staleTime` is 0
- an invalidation of a query that cannot refetch (disabled, or `staleTime: 'static'`)
- queries paused while other requests succeed
- an infinite query holding many pages with no `maxPages`
- `gcTime: 0` on server-rendered queries
- a `QueryClient` recreated during one page load
- a query that starts only when another finishes
- a request cancelled and sent again as its component mounts, which is React StrictMode's double mount in development and not a production cost

From the skills shipped in `@tanstack/react-router` and `@tanstack/router-core`:

- Router's preload cache left on while the app uses Query
- no not-found component, no error component, or the deprecated `notFoundRoute`
- `loaderDeps` returning the whole search object
- a router recreated during one page load
- React Router loaded next to TanStack Router
- a page that renders and then redirects at once, with no `beforeLoad` on its routes
- queries that start only after the route has rendered
- a loader refetching data it already had, holding up the navigation
- a background query whose failure became an unhandled rejection

From the skills shipped in the TanStack Start packages, the `@vitejs/plugin-react` README and Vite's troubleshooting guide:

- a hydration mismatch
- a child route setting `ssr: true` under a parent that turned it down
- a loader fetching the app's own `/api/...` over HTTP instead of calling a server function
- server functions running one after another
- a slow navigation with no pending component
- a component file whose other exports defeat Fast Refresh
- a component file that reloads the whole page on every edit
- requests rejected with 431

From the page itself, with no library involved:

- a page the server answered with an error status, even though something rendered
- images that did not load
- links and controls with no accessible name, which is often content that failed to render
- a request that has been in flight for over ten seconds

It also recognises 25 warnings and errors that TanStack Query, Router, Start and Vite print themselves, such as "Query data cannot be undefined" or "Mocked import used in dev client", and pairs each with its documented fix.

Findings of severity `info` are judgment calls: a waterfall can be a real dependency, a late query can be data the page does not need at first. Their hint says when to ignore them. What can only be seen in source code is left to the linters: `@tanstack/eslint-plugin-query`, `@tanstack/eslint-plugin-router` and `eslint-plugin-react-refresh`.

### The timeline

| Source | Records |
| --- | --- |
| `query`, `mutation` | cache events, with the time each fetch took and the code that started it |
| `router` | navigation events, with the time to resolve and any route error |
| `network` | `fetch` and `XMLHttpRequest`: method, URL, status and time. Bodies and headers are never read. A source can name the requests it understands; the Start source shows server functions by name |
| `console` | `console.error`, `console.warn`, uncaught errors and unhandled rejections. A message repeated within five seconds is recorded once, then once more with the count |
| `vite` | from the Vite host: a module changed, a hot update, a full reload, a module that could not be updated in place and why, a build error, an error the dev server logged |
| `bus` | TanStack Devtools event-bus events, when that panel is mounted |

The server keeps its own copy, 1,000 entries per session by default (`size`). `list_events`, `get_event`, `count_events` and `diagnose` answer from that copy, so they still work after a reload or a closed tab. A page that loads after a reload starts its log with the Vite event that caused it.

Outputs are sized for an agent's context. Rows leave out fields at their usual value, summaries are cut at 200 characters, and data is cut at a depth, 50 items per container and 2,000 characters per string, with a note of how much was left out. `path` and `get_event` reach the rest.

### Actions are off by default

The read tools cannot change your app. A source's action tools are registered only with `loopsight({ actions: true })` or `--actions`. `call_page_tool` runs a registered tool without that flag only when the tool declares `readOnlyHint: true`.

### Tools from other libraries

TanStack Devtools has a registry for agent tools, [`@tanstack/devtools-webmcp`](https://github.com/TanStack/devtools/tree/main/packages/devtools-webmcp). A library calls `registerDevtoolsTools` and the tools land in the browser's WebMCP API, `document.modelContext`. Today that reaches only agents driving a browser that ships WebMCP.

loopsight serves the same tools over the Node MCP endpoint, so any agent can call them:

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

## With Vite DevTools

If the app runs [Vite DevTools](https://github.com/vitejs/devtools), the same tools are also served from its MCP route, next to its own and other plugins'. Nothing to configure in this plugin: Vite DevTools calls it when enabled.

```ts
// vite.config.ts
export default defineConfig({
  devtools: true,
  plugins: [loopsight()],
})
```

```sh
pnpm add -D @vitejs/devtools @devframes/agentic
```

Vite DevTools mounts its MCP route only when `@devframes/agentic` is installed. The tools appear there as `loopsight_overview`, `loopsight_diagnose` and so on, at `/__devtools/__mcp` on the dev server's own port.

That route is stricter than this package's endpoint in one way that matters when connecting: it refuses any request without a loopback `Origin` header. Claude Code does not send one by itself, and reports the refusal as "needs authentication", so set it:

```json
{
  "mcpServers": {
    "vite": {
      "type": "http",
      "url": "http://localhost:5173/__devtools/__mcp",
      "headers": { "Origin": "http://localhost:5173" }
    }
  }
}
```

A client that cannot set headers can go through `npx devframe connect` instead, a stdio server that finds running dev servers by itself. It exposes two tools, one to list the instances and their tools and one to call a tool by name, so the tools are one step removed and the listing is large.

To have that route as the only endpoint, turn this package's own off:

```ts
loopsight({ standalone: false })
```

No second port opens then. The page connects through the dev server it was served from in both modes, so an app with a strict `connect-src` in its content security policy needs no exception and an https page gets a secure socket. In Vite's middleware mode the dev server has no HTTP server of its own, so pass your app's server as `server.hmr.server`, which is where Vite puts its own WebSocket too.

| | This package's endpoint | Vite DevTools' route |
| --- | --- | --- |
| Address | `http://127.0.0.1:4777/mcp`, fixed | `/__devtools/__mcp` on the dev server's port |
| `Origin` header | must be absent | must be a loopback origin |
| Tool names | `overview` | `loopsight_overview` |
| Needs | nothing else | Vite DevTools enabled, `@devframes/agentic` installed |

## Without Vite

Run the server on its own and connect the page yourself:

```sh
loopsight [--port <n>] [--size <n>] [--actions] [--origin <url>]...
```

```ts
import { connect } from 'loopsight/client'

connect({ url: 'ws://127.0.0.1:4777/bridge', queryClient, router })
```

Without the plugin there are no `vite` entries, `wait_for_update` has nothing to wait for, and source places keep the served file's line numbers, marked `(served code)`.

## Security

The server listens on `127.0.0.1` only and has no option to listen elsewhere.

- `/mcp` refuses any request with an `Origin` header, so a web page cannot call the tools.
- Both routes refuse a `Host` header that is not a loopback name, which stops DNS rebinding.
- `/bridge` accepts WebSocket connections from loopback origins and the ones you list in `origins`.

With the Vite plugin the page's WebSocket goes to the dev server, which accepts it from loopback origins, from the page's own origin when the `Host` is one the Vite config allows (`server.allowedHosts`), and from the origins you list.

With `standalone: false` there is no server of this package's own, and who may call the tools is decided by Vite DevTools' route.

There is no token. Any process on your machine can connect, as it can to the Vite dev server. Query data, loader data and request URLs are sent to whoever connects, so do not run it against data you would not show a local process.

## Status and limits

Verified: React 19, TanStack Query 5, TanStack Router 1.170, Vite 8 and Chrome, on a single-page app and on a production-sized TanStack Start app under Vite+. `pnpm test` runs the unit and HTTP tests and `pnpm e2e` drives the example in headless Chrome through the MCP endpoint, including a hot update, a build error and its fix. The packages were also packed and installed into a fresh project, to check they work from `node_modules` and not only from this workspace. The Vite DevTools route is driven the same way with `@vitejs/devtools` 0.8.3. By hand: a Claude Code run was connected to that route, and the tools were called through it with `standalone: false` on a server-rendered app under Vite+ with `@vitejs/devtools` 0.8.0. Those two hand checks were made before the split into packages; after it, the standalone endpoint was run again on that app (connection, reads, `diagnose`, a reported reload).

Not verified: the Vue, Solid, Svelte and Angular adapters, and Vite below 8. The page-side code reads Query and Router by shape, not by import, so they may work.

Known limits:

- **Server-rendered apps connect a moment late.** With no `index.html` to put a script in, the page connects through Vite's client, after the first modules have run. What it missed is summarised in an `attached` entry, and queries a server render sent along have no `usedAt` until a component reads them again.
- **Nothing from the server side of an SSR app.** Loaders and server functions that run in Node are seen only as the requests the browser made.
- **No time travel.** Effect UI can repaint the page at any past entry because its state is one message log. Query and Router have no equivalent to replay; `diff_query` shows the last change only.
- **No panel.** This has no UI of its own.
- **Four built-in sources, all TanStack, and one host, Vite.** TanStack Form, Table, Store, Pacer and DB have none; nor do other state or data libraries. A library can register tools through `@tanstack/devtools-webmcp`, or be given a source as shown above. No source from outside this repository exists yet, so the contracts have been tried by one author only and may still change.
- **`diagnose` reads what happened; it does not read your code.** Its rules are tied to documented mistakes, but their thresholds are heuristics, and a quiet result means nothing matched, not that nothing is wrong. TanStack Form and Table have no rules yet.

## Development

```sh
pnpm build       # every package, in dependency order
pnpm test        # unit and HTTP tests, run on the source
pnpm e2e         # builds, then drives the example in headless Chrome; needs Google Chrome
pnpm typecheck
```

## License

MIT
