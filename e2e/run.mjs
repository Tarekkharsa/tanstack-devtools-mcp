// Drives the example app in a real Chrome and reads it back through MCP.
// Run with `pnpm e2e`. Needs Google Chrome installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const MCP_PORT = 4791
process.env.MCP_PORT = String(MCP_PORT)

const root = fileURLToPath(new URL('../example', import.meta.url))
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

  await step('the page connected with Query, Router and its tools', async () => {
    const { sessions, actions } = await call('list_sessions')
    assert.equal(actions, true)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].connected, true)
    assert.deepEqual(sessions[0].has, { query: true, router: true })
    assert.equal(sessions[0].tools, 2)
    assert.match(sessions[0].url, /\/posts$/)
  })

  await step('list_queries and get_query read the cache', async () => {
    const { queries } = await call('list_queries')
    assert.deepEqual(
      queries.map((q) => [q.queryHash, q.status]),
      [['["posts"]', 'success']],
    )
    const query = await call('get_query', { queryHash: '["posts"]' })
    assert.equal(query.data.length, 3)
    assert.equal(query.data[1].title, 'Routes are state')
  })

  await step('get_router_state and list_routes read the router', async () => {
    const state = await call('get_router_state')
    assert.equal(state.location.pathname, '/posts')
    assert.deepEqual(
      state.matches.map((m) => m.routeId),
      ['__root__', '/posts'],
    )
    const { routes } = await call('list_routes')
    const post = routes.find((r) => r.id === '/posts/$postId')
    assert.equal(post.fullPath, '/posts/$postId')
    assert.equal(post.hasLoader, true)
  })

  let mark = 0
  await step('navigate drives the router and the page follows', async () => {
    mark = (await call('list_events', { limit: 1 })).lastEntry
    const result = await call('navigate', {
      to: '/posts/$postId',
      params: { postId: '2' },
    })
    assert.equal(result.location.pathname, '/posts/2')
    await page.getByRole('heading', { name: 'Routes are state' }).waitFor()
  })

  await step('wait_for_idle returns what the navigation caused', async () => {
    const result = await call('wait_for_idle', { after: mark })
    assert.equal(result.idle, true)
    const seen = result.entries.map((e) => `${e.source}/${e.type}`)
    assert.ok(seen.includes('router/onBeforeNavigate'), seen.join(' '))
    assert.ok(seen.includes('router/onResolved'), seen.join(' '))
    assert.ok(seen.includes('query/fetch'), seen.join(' '))
    assert.ok(seen.includes('query/success'), seen.join(' '))
    const fetched = result.entries.find(
      (e) => e.source === 'query' && e.type === 'success',
    )
    assert.equal(fetched.key, '["post",2]')
  })

  await step('a click in the page shows up as a mutation', async () => {
    const before = (await call('list_events', { limit: 1 })).lastEntry
    await page.getByRole('button', { name: /Like/ }).click()
    await page.getByRole('button', { name: 'Like (6)' }).waitFor()
    await call('wait_for_idle', { after: before })
    const { mutations } = await call('list_mutations')
    assert.equal(mutations.at(-1).status, 'success')
    assert.deepEqual(mutations.at(-1).mutationKey, ['like', 2])
    const { counts } = await call('count_events', { after: before })
    assert.ok(counts['mutation/success'] >= 1, JSON.stringify(counts))
    assert.ok(counts['query/invalidate'] >= 2, JSON.stringify(counts))
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

  await step('a failing loader is visible as an error', async () => {
    const before = (await call('list_events', { limit: 1 })).lastEntry
    await call('navigate', { to: '/posts/$postId', params: { postId: '99' } })
    await page.getByRole('alert').waitFor()
    await call('wait_for_idle', { after: before })
    const { entries } = await call('list_events', {
      source: 'query',
      type: 'error',
      after: before,
    })
    assert.equal(entries.length, 1)
    assert.match(entries[0].summary, /Post 99 not found/)
    const { queries } = await call('list_queries', { status: 'error' })
    assert.equal(queries[0].queryHash, '["post",99]')
  })

  await step('the log outlives the page; live reads say why they cannot', async () => {
    await page.close()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { sessions } = await call('list_sessions')
    assert.equal(sessions[0].connected, false)
    const { entries } = await call('list_events', { source: 'router', limit: 3 })
    assert.equal(entries.length, 3)
    await assert.rejects(call('list_queries'), /no open page/)
  })

  assert.deepEqual(pageErrors, [], 'the page threw')
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await client.close().catch(() => {})
  await browser.close()
  await vite.close()
}

process.exit(failed ? 1 : 0)
