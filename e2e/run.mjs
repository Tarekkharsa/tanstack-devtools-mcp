// Drives the example app in a real Chrome and reads it back through MCP.
// Run with `pnpm e2e`. Needs Google Chrome installed.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const MCP_PORT = 4791
process.env.MCP_PORT = String(MCP_PORT)

const root = fileURLToPath(new URL('../example', import.meta.url))
const homeFile = fileURLToPath(new URL('../example/src/Home.tsx', import.meta.url))
const homeSource = readFileSync(homeFile, 'utf8')

const vite = await createServer({ root, server: { port: 5191, strictPort: true } })
await vite.listen()
const appUrl = vite.resolvedUrls.local[0]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const client = new Client({ name: 'e2e', version: '0.0.0' })
let failed = false

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content[0].text
  if (result.isError) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}

async function step(name, run) {
  try {
    await run()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed = true
    console.log(`FAIL  ${name}\n      ${error.message.split('\n').join('\n      ')}`)
  }
}

const kinds = (entries) => entries.map((e) => `${e.source}/${e.type}`)
const mark = async () => (await call('count_events')).lastEntry

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(appUrl)
  await page.getByRole('link', { name: 'Posts' }).click()
  await page.getByRole('link', { name: 'Routes are state' }).waitFor()

  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${MCP_PORT}/mcp`),
    ),
  )

  await step("Vite's client carries the import, for apps with no index.html", async () => {
    const viteClient = await (await fetch(new URL('@vite/client', appUrl))).text()
    assert.match(viteClient, /@id\/__x00__loopsight:entry/)
    const entry = await fetch(new URL('@id/__x00__loopsight:entry', appUrl))
    assert.equal(entry.status, 200)
    const code = await entry.text()
    // Through the dev server the page came from, not the tool's own port.
    assert.match(code, /url: \(location\.protocol === 'https:' \? 'wss:\/\/' : 'ws:\/\/'\) \+ location\.host \+ "\/__loopsight\/bridge",/)
    // The example has the router and Query, and neither Start nor the
    // Devtools event bus, so two of the four built-in sources are sent.
    // They and the core come from the plugin: the app installs nothing.
    assert.match(code, /sources: \[source0, source1\],/)
    assert.match(code, /tanstack-router\/dist\/page\.js"[\s\S]*tanstack-query\/dist\/page\.js"/)
    const core = /from "(\/@id\/__x00__loopsight:[^"]+\/page\/index\.js)"/.exec(code)
    assert.ok(core, 'the core page module is served by the plugin')
    assert.equal((await fetch(new URL(core[1], appUrl))).status, 200)
  })

  await step('the page connected with no code in the app', async () => {
    const { sessions, actions } = await call('list_sessions')
    assert.equal(actions, true)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].connected, true)
    // The router is found on window, the QueryClient in the router context.
    assert.deepEqual(sessions[0].has, { query: true, router: true })
    assert.equal(sessions[0].tools, 2)
  })

  await step('overview answers "what is this page doing" in one call', async () => {
    const overview = await call('overview')
    assert.match(overview.url, /\/posts$/)
    assert.equal(overview.idle, true)
    assert.deepEqual(overview.router, {
      status: 'idle',
      href: '/posts',
      matches: ['__root__', '/posts'],
    })
    assert.deepEqual(overview.query.byStatus, { success: 1 })
    assert.equal(overview.problems.total, 0)
  })

  await step('list_queries and get_query read the cache', async () => {
    const { queries } = await call('list_queries')
    assert.deepEqual(
      queries.map((q) => [q.queryHash, q.status, q.observers]),
      [['["posts"]', 'success', 1]],
    )
    const query = await call('get_query', { queryHash: '["posts"]' })
    assert.equal(query.data.length, 3)
    assert.equal(query.data[1].title, 'Routes are state')
    assert.deepEqual(
      (await call('get_query', { queryHash: '["posts"]', path: [2, 'title'] })).data,
      'Agents need eyes',
    )
  })

  await step('get_query says where in the source the query is used', async () => {
    const query = await call('get_query', { queryHash: '["posts"]' })
    // Created by the route loader, observed by the Posts component: original
    // lines of main.tsx, mapped back through Vite's source maps.
    const source = readFileSync(new URL('../example/src/main.tsx', import.meta.url), 'utf8').split('\n')
    const lineOf = (text) => source.findIndex((line) => line.includes(text)) + 1
    const places = query.usedAt.join('\n')
    assert.match(places, new RegExp(`src/main\\.tsx:${lineOf("ensureQueryData({ queryKey: ['posts']")}:`), places)
    assert.match(places, new RegExp(`Posts src/main\\.tsx:${lineOf("useQuery({ queryKey: ['posts']")}:`), places)
    assert.doesNotMatch(places, /served code|node_modules/)
  })

  await step('get_router_state and list_routes read the router', async () => {
    const state = await call('get_router_state')
    assert.equal(state.location.pathname, '/posts')
    assert.deepEqual(
      state.matches.map((m) => m.routeId),
      ['__root__', '/posts'],
    )
    const { routes } = await call('list_routes', { contains: 'postId' })
    assert.deepEqual(routes, [{ id: '/posts/$postId', has: ['loader'] }])
  })

  let before = 0
  await step('navigate drives the router and the page follows', async () => {
    before = await mark()
    const result = await call('navigate', {
      to: '/posts/$postId',
      params: { postId: '2' },
    })
    assert.equal(result.location.pathname, '/posts/2')
    await page.getByRole('heading', { name: 'Routes are state' }).waitFor()
  })

  await step('one timeline: navigation, query, request, with timings and sources', async () => {
    const result = await call('wait_for_idle', { after: before })
    assert.equal(result.idle, true)
    const seen = kinds(result.entries)
    for (const kind of ['router/onBeforeNavigate', 'query/fetch', 'network/ok', 'query/success', 'router/onResolved']) {
      assert.ok(seen.includes(kind), `${kind} missing from ${seen.join(' ')}`)
    }
    const request = result.entries.find((e) => e.source === 'network')
    assert.equal(request.summary, 'GET /api/posts/2 → 200')
    assert.ok(request.ms >= 70, `request took ${request.ms} ms`)
    assert.match(request.from, /^request src\/main\.tsx:\d+:\d+$/)
    const fetched = result.entries.find((e) => e.source === 'query' && e.type === 'success')
    assert.equal(fetched.summary, '["post",2] success')
    assert.ok(fetched.ms >= 70)
    const resolved = result.entries.find((e) => e.type === 'onResolved')
    assert.ok(resolved.ms >= 70)
  })

  await step('a click in the page shows up as a mutation, and diff_query shows its effect', async () => {
    before = await mark()
    await page.getByRole('button', { name: /Like/ }).click()
    await page.getByRole('button', { name: 'Like (6)' }).waitFor()
    const waited = await call('wait_for_idle', { after: before })
    const like = waited.entries.find((e) => e.source === 'network' && e.summary.startsWith('POST'))
    assert.equal(like.summary, 'POST /api/posts/2/like → 200')
    const { mutations } = await call('list_mutations')
    assert.equal(mutations.at(-1).status, 'success')
    assert.deepEqual(mutations.at(-1).mutationKey, ['like', 2])
    const { counts } = await call('count_events', { after: before })
    assert.ok(counts['mutation/success'] >= 1, JSON.stringify(counts))
    assert.ok(counts['query/invalidate'] >= 2, JSON.stringify(counts))

    const diff = await call('diff_query', { queryHash: '["post",2]' })
    assert.deepEqual(diff.changes, [
      { path: 'likes', kind: 'changed', before: 5, after: 6 },
    ])
  })

  await step('set_query_data changes what the page renders', async () => {
    const query = await call('get_query', { queryHash: '["post",2]' })
    await call('set_query_data', {
      queryHash: '["post",2]',
      data: { ...query.data, title: 'Set by an agent' },
    })
    await page.getByRole('heading', { name: 'Set by an agent' }).waitFor()
  })

  await step('tools registered with @tanstack/devtools-webmcp are served', async () => {
    const { tools } = await call('list_page_tools')
    assert.deepEqual(
      tools.map((t) => [t.name, t.readOnly, t.callable]),
      [
        ['example.getPosts', true, true],
        ['example.likePost', false, true],
      ],
    )
    const listed = await call('call_page_tool', { name: 'example.getPosts' })
    assert.equal(listed[1].likes, 6)
    const liked = await call('call_page_tool', {
      name: 'example.likePost',
      input: { id: 3 },
    })
    assert.equal(liked.likes, 9)
  })

  await step('a failing loader is visible as an error, and diagnose explains it', async () => {
    const healthy = await call('diagnose')
    assert.equal(healthy.ok, true, JSON.stringify(healthy.findings, null, 1))
    before = await mark()
    await call('navigate', { to: '/posts/$postId', params: { postId: '99' } })
    await page.getByRole('alert').waitFor()
    await call('wait_for_idle', { after: before })

    const { entries } = await call('list_events', { problems: true, after: before })
    const seen = kinds(entries)
    assert.ok(seen.includes('network/error'), seen.join(' '))
    assert.ok(seen.includes('query/error'), seen.join(' '))
    const request = entries.find((e) => e.source === 'network')
    assert.equal(request.summary, 'GET /api/posts/99 → 404')

    const result = await call('diagnose', { after: before })
    assert.equal(result.ok, false)
    const titles = result.findings.map((f) => f.title)
    assert.ok(titles.includes('A matched route is showing an error'), titles.join(' | '))
    assert.ok(titles.includes('1 query is in the error state'), titles.join(' | '))
    assert.ok(titles.includes('1 failed requests'), titles.join(' | '))
    const route = result.findings.find((f) => f.title.startsWith('A matched route'))
    assert.match(route.evidence[0], /\/posts\/\$postId: Error: Post 99 not found/)
  })

  await step('after an edit: a hot update, and the page shows the new code', async () => {
    await page.getByRole('link', { name: 'Home' }).click()
    await page.getByText('Open Posts, then ask your agent').waitFor()
    await call('wait_for_idle')
    before = await mark()
    writeFileSync(homeFile, homeSource.replace('Open Posts, then ask', 'Edited by a test, then ask'))
    const result = await call('wait_for_update', { after: before })
    assert.equal(result.update, 'hmr-update', JSON.stringify(result, null, 1))
    assert.deepEqual(result.files, ['src/Home.tsx'])
    assert.equal(result.idle, true)
    assert.deepEqual(result.problems, [])
    assert.deepEqual(kinds(result.entries).slice(0, 2), ['vite/change', 'vite/hmr-update'])
    await page.getByText('Edited by a test, then ask').waitFor()
  })

  await step('after a broken edit: the build error, with its place and code frame', async () => {
    await page.waitForTimeout(300)
    before = await mark()
    writeFileSync(homeFile, 'export function Home() {\n  return <p>unclosed\n}\n')
    const result = await call('wait_for_update', { after: before })
    assert.equal(result.update, 'error', JSON.stringify(result, null, 1))
    assert.equal(result.problems.length, 1)
    assert.match(result.problems[0].summary, /^build error in src\/Home\.tsx.*PARSE_ERROR.*Unexpected token/)
    assert.match(result.problems[0].detail.message, /Home\.tsx:3:1/)
    const diagnosis = await call('diagnose', { after: before })
    assert.match(diagnosis.findings[0].title, /The dev server reports a build error/)
  })

  await step('after the fix: the update goes through and the error is gone', async () => {
    // The file watcher drops a change that lands within 50 ms of the last.
    await page.waitForTimeout(300)
    before = await mark()
    writeFileSync(homeFile, homeSource)
    const result = await call('wait_for_update', { after: before })
    assert.ok(['hmr-update', 'full-reload'].includes(result.update), result.update)
    assert.deepEqual(result.problems, [])
    await page.getByText('Open Posts, then ask your agent').waitFor()
    // The whole log this time: the build error is in it, and no longer counts.
    const diagnosis = await call('diagnose', { session: result.session })
    assert.ok(
      !diagnosis.findings.some((f) => /build error/.test(f.title)),
      JSON.stringify(diagnosis.findings),
    )
  })

  await step('a component file with another export defeats Fast Refresh, and diagnose cites the fix', async () => {
    await page.waitForTimeout(300)
    before = await mark()
    writeFileSync(homeFile, `${homeSource}\nexport const helpers = { now: () => Date.now() }\n`)
    const first = await call('wait_for_update', { after: before })
    await page.waitForTimeout(300)
    writeFileSync(homeFile, `${homeSource}\nexport const helpers = { later: () => Date.now() + 1 }\n`)
    const second = await call('wait_for_update', { after: first.lastEntry, session: first.session })
    const seen = [...first.entries, ...second.entries].filter((e) => e.source === 'vite')
    const diagnosis = await call('diagnose', { session: second.session })
    const finding = diagnosis.findings.find((f) => f.rule === 'vite/fast-refresh-defeated')
    assert.ok(finding, `no finding; vite said: ${JSON.stringify(seen.map((e) => e.type + ' ' + e.summary))}`)
    assert.match(finding.evidence[0], /src\/Home\.tsx could not be updated in place: Could not Fast Refresh/)
    assert.match(finding.fix, /exporting only React components/)
    assert.match(finding.docs.at, /consistent-components-exports/)
    await page.waitForTimeout(300)
    writeFileSync(homeFile, homeSource)
    await call('wait_for_update', { after: second.lastEntry, session: second.session })
  })

  await step('an uncaught error carries the source line that threw', async () => {
    before = await mark()
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('thrown on purpose')
      }, 0)
    })
    await page.waitForTimeout(150)
    const { entries } = await call('list_events', { source: 'console', after: before })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'uncaught')
    assert.equal(entries[0].summary, 'Error: thrown on purpose')
    pageErrors.length = 0
  })

  await step('the log outlives the page; live reads say why they cannot', async () => {
    const { session } = await call('overview')
    await page.close()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const overview = await call('overview', { session })
    assert.equal(overview.connected, false)
    assert.match(overview.note, /page is closed/)
    const { entries } = await call('list_events', { session, source: 'router', limit: 3 })
    assert.equal(entries.length, 3)
    await assert.rejects(call('list_queries', { session }), /no open page/)
  })

  assert.deepEqual(pageErrors, [], 'the page threw')
} catch (error) {
  failed = true
  console.error(error)
} finally {
  writeFileSync(homeFile, homeSource)
  await client.close().catch(() => {})
  await browser.close()
  await vite.close()
}

// Second run: Vite DevTools on, this package's own endpoint off. The tools
// are served from Vite DevTools' MCP route only, and the page connects
// through the dev server itself.
console.log('\nthrough Vite DevTools')
process.env.VITE_DEVTOOLS = '1'
process.env.MCP_STANDALONE = '0'
const hosted = await createServer({ root, server: { port: 5192, strictPort: true } })
await hosted.listen()
const hostedUrl = hosted.resolvedUrls.local[0]
const hostedOrigin = new URL(hostedUrl).origin
const route = new URL('__devtools/__mcp', hostedUrl)
const hostedBrowser = await chromium.launch({ channel: 'chrome', headless: true })
const viaDevtools = new Client({ name: 'e2e-devtools', version: '0.0.0' })

async function callHosted(name, args = {}) {
  const result = await viaDevtools.callTool({ name, arguments: args })
  const text = result.content[0].text
  if (result.isError) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}

try {
  const page = await hostedBrowser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(hostedUrl)
  await page.getByRole('link', { name: 'Posts' }).click()
  await page.getByRole('link', { name: 'Routes are state' }).waitFor()

  // The route wants a loopback Origin, as an MCP client is configured to send.
  await viaDevtools.connect(
    new StreamableHTTPClientTransport(route, {
      requestInit: { headers: { Origin: hostedOrigin } },
    }),
  )

  await step("the tools are on Vite DevTools' route, next to its own", async () => {
    const { tools } = await viaDevtools.listTools()
    const ours = tools.filter((tool) => tool.name.startsWith('loopsight_'))
    assert.equal(ours.length, 21, ours.map((tool) => tool.name).join(' '))
    assert.ok(tools.length > ours.length, 'Vite DevTools serves tools of its own')
    const navigate = ours.find((tool) => tool.name === 'loopsight_navigate')
    assert.deepEqual(navigate.inputSchema.required, ['to'])
    assert.equal(navigate.annotations.readOnlyHint, false)
    assert.equal(ours.find((tool) => tool.name === 'loopsight_overview').annotations.readOnlyHint, true)
  })

  await step('no second port is open', async () => {
    await assert.rejects(fetch(`http://127.0.0.1:${MCP_PORT}/`), /fetch failed/)
  })

  await step('the page connected through the dev server, with nothing in the app', async () => {
    const overview = await callHosted('loopsight_overview')
    assert.equal(overview.connected, true)
    assert.match(overview.url, /\/posts$/)
    assert.deepEqual(overview.router.matches, ['__root__', '/posts'])
    assert.deepEqual(overview.query.byStatus, { success: 1 })
  })

  await step('reads, an action and the timeline work through the route', async () => {
    const { lastEntry } = await callHosted('loopsight_count_events')
    const moved = await callHosted('loopsight_navigate', { to: '/posts/$postId', params: { postId: '2' } })
    assert.equal(moved.location.pathname, '/posts/2')
    await page.getByRole('heading', { name: 'Routes are state' }).waitFor()
    const waited = await callHosted('loopsight_wait_for_idle', { after: lastEntry })
    assert.equal(waited.idle, true)
    const seen = kinds(waited.entries)
    for (const kind of ['router/onBeforeNavigate', 'query/fetch', 'network/ok', 'query/success', 'router/onResolved']) {
      assert.ok(seen.includes(kind), `${kind} missing from ${seen.join(' ')}`)
    }
    const request = waited.entries.find((e) => e.source === 'network')
    assert.match(request.from, /^request src\/main\.tsx:\d+:\d+$/)
    const query = await callHosted('loopsight_get_query', { queryHash: '["post",2]' })
    assert.equal(query.data.title, 'Routes are state')
    assert.ok(query.usedAt.length > 0)
  })

  await step('after an edit, wait_for_update reports the hot update through the route', async () => {
    await page.getByRole('link', { name: 'Home' }).click()
    await page.getByText('Open Posts, then ask your agent').waitFor()
    await callHosted('loopsight_wait_for_idle')
    const { lastEntry } = await callHosted('loopsight_count_events')
    writeFileSync(homeFile, homeSource.replace('Open Posts, then ask', 'Edited through DevTools, then ask'))
    const result = await callHosted('loopsight_wait_for_update', { after: lastEntry })
    assert.equal(result.update, 'hmr-update', JSON.stringify(result).slice(0, 400))
    assert.deepEqual(result.files, ['src/Home.tsx'])
    await page.getByText('Edited through DevTools, then ask').waitFor()
  })

  await step('a tool failure reaches the agent as an error', async () => {
    const result = await viaDevtools.callTool({ name: 'loopsight_get_query', arguments: { queryHash: 'nope' } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /No query with hash nope/)
  })

  await step('the route refuses a request with no Origin, unlike the standalone endpoint', async () => {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(response.status, 403)
  })

  assert.deepEqual(pageErrors, [], 'the page threw')
} catch (error) {
  failed = true
  console.error(error)
} finally {
  writeFileSync(homeFile, homeSource)
  await viaDevtools.close().catch(() => {})
  await hostedBrowser.close()
  await hosted.close()
}

process.exit(failed ? 1 : 0)
