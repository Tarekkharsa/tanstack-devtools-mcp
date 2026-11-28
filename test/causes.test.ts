import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { hydrationMismatch } from '@loopsight/core/page'
import { Hub, createMcpServer, partition } from '@loopsight/core/server'
import { SOURCES, check, recorded } from './support.js'
import type { Connection, EntrySource, Finding, LogEntry } from '@loopsight/core/server'
import type { PageMessage } from '@loopsight/core/protocol'
import type { QueryFact } from '@loopsight/tanstack-query'

/** What React 19 prints in development when hydration fails. */
const REACT_SAYS = `Hydration failed because the server rendered HTML didn't match the client. As a result this tree will be regenerated on the client. This can happen if a SSR-ed Client Component used:

- A server/client branch \`if (typeof window !== 'undefined')\`.
- Variable input such as \`Date.now()\` or \`Math.random()\` which changes each time it's called.

https://react.dev/link/hydration-mismatch

  ...
    <ProductsWhenSeen list={{...}}>
      <div className="when-seen" ref={function watch}>
        <ProductGrid list={{...}}>
          <Suspense fallback={null}>
            <ProductCard product={{id:"p-1", ...}} view="grid">
              <Tile as="article" data-kind="tile">
                <article
+                 data-kind="tile"
-                 data-kind="tile-skeleton"
                  data-size="default"
+                 className="group relative flex"
-                 className="group relative animate-pulse"
`

function log() {
  const entries: Array<LogEntry> = []
  const add = (
    t: number,
    source: EntrySource,
    type: string,
    summary: string,
    extra: Partial<LogEntry> = {},
  ) => {
    entries.push(recorded({ n: entries.length + 1, t, source, type, summary, ...extra }))
    return add
  }
  return { entries, add }
}

const query = (queryHash: string, over: Partial<QueryFact> = {}): QueryFact => ({
  queryHash,
  family: 'x',
  status: 'success',
  fetchStatus: 'idle',
  stale: false,
  disabled: false,
  hasData: true,
  hasQueryFn: true,
  failures: 0,
  preloaded: false,
  fetches: 0,
  options: {},
  observers: [{}],
  ...over,
})

describe('a hydration failure', () => {
  it('keeps what React said differed, which sits at the end of its message', () => {
    expect(hydrationMismatch(REACT_SAYS)).toEqual({
      element: '<article',
      client: ['data-kind="tile"', 'className="group relative flex"'],
      server: ['data-kind="tile-skeleton"', 'className="group relative animate-pulse"'],
      within: ['ProductsWhenSeen', 'ProductGrid', 'Suspense', 'ProductCard', 'Tile'],
    })
    expect(hydrationMismatch('Hydration failed, and no tree was printed')).toBeUndefined()
    expect(hydrationMismatch('- not about rendering\n+ at all')).toBeUndefined()
  })

  it('reports the element and both sides, not the generic text', () => {
    const { entries, add } = log()
    add(1000, 'console', 'uncaught', 'Error: Hydration failed because the server rendered HTML…', {
      detail: { mismatch: hydrationMismatch(REACT_SAYS) },
    })
    const [finding] = check('start/hydration-mismatch', entries)
    expect(finding!.evidence).toEqual([
      'on <article inside ProductsWhenSeen > ProductGrid > Suspense > ProductCard > Tile',
      'browser rendered: data-kind="tile"',
      'browser rendered: className="group relative flex"',
      'server had sent: data-kind="tile-skeleton"',
      'server had sent: className="group relative animate-pulse"',
    ])
    // A loading state on the server side points at data, not at dates or locale.
    expect(finding!.hint).toMatch(/was not in the server render/)
  })

  it('falls back to the message when the page kept no tree', () => {
    const { entries, add } = log()
    add(1000, 'console', 'error', 'Hydration failed because the server rendered HTML did not match')
    const [finding] = check('core/hydration-mismatch', entries)
    expect(finding!.evidence).toEqual(['Hydration failed because the server rendered HTML did not match'])
    expect(finding!.hint).toBeUndefined()
  })
})

describe('a query the server render did not carry', () => {
  const GUEST = '["products","list",{}]'
  const MEMBER = '["products","list",{"segment":"trade"}]'
  const setup = {
    queryFacts: {
      defaults: {},
      queries: [
        // Sent by the server, and no component reads it.
        query(GUEST, { preloaded: true, observers: [] }),
        query(MEMBER, { fetches: 1 }),
        query('["profile"]', { preloaded: true }),
      ],
    },
  }

  function loaded() {
    const { entries, add } = log()
    add(1000, 'query', 'attached', '2 queries already in the cache: 2 success')
    add(1200, 'query', 'added', `${MEMBER} added`, { key: MEMBER })
    add(1200, 'query', 'fetch', `${MEMBER} fetching`, { key: MEMBER, at: ['ProductGrid src/products.tsx:12:5'] })
    add(1500, 'query', 'success', `${MEMBER} success`, { key: MEMBER, dur: 300 })
    return { entries, add }
  }

  it('prefetched-under-another-key: the server loaded one key and the page reads another', () => {
    const { entries } = loaded()
    expect(check('query/prefetched-under-another-key', entries, setup)).toMatchObject([
      {
        severity: 'warning',
        subject: MEMBER,
        evidence: [
          `sent by the server, read by no component: ${GUEST}`,
          `read by the page, fetched in the browser: ${MEMBER} — from ProductGrid src/products.tsx:12:5`,
        ],
        hint: 'Right as it is if the two keys are different data on purpose.',
      },
    ])
  })

  it('prefetched-under-another-key: also when the server cache reached the page after it connected', () => {
    const { entries, add } = log()
    add(1000, 'query', 'added', `${GUEST} added with its data`, { key: GUEST, detail: { sent: true } })
    add(1200, 'query', 'fetch', `${MEMBER} fetching`, { key: MEMBER })
    add(1500, 'query', 'success', `${MEMBER} success`, { key: MEMBER, dur: 300 })
    expect(check('query/prefetched-under-another-key', entries, setup)).toHaveLength(1)
  })

  it('prefetched-under-another-key: two keys that differ in a name are two things, not one read twice', () => {
    const { entries, add } = log()
    add(1000, 'query', 'attached', '1 queries already in the cache: 1 success')
    add(1200, 'query', 'fetch', '["member","preferences"] fetching', { key: '["member","preferences"]' })
    add(1500, 'query', 'success', '["member","preferences"] success', { key: '["member","preferences"]', dur: 300 })
    const names = {
      queryFacts: {
        defaults: {},
        queries: [
          query('["member","shell"]', { preloaded: true, observers: [] }),
          query('["member","preferences"]', { fetches: 1 }),
        ],
      },
    }
    expect(check('query/prefetched-under-another-key', entries, names)).toEqual([])
  })

  it('prefetched-under-another-key: says so when the page also failed hydration', () => {
    const { entries, add } = loaded()
    add(2500, 'console', 'uncaught', 'Error: Hydration failed because the server rendered HTML…')
    const [finding] = check('query/prefetched-under-another-key', entries, setup)
    expect(finding!.hint).toMatch(/also failed hydration/)
  })

  it('prefetched-under-another-key: quiet when the sent query is read, or the other came on a later navigation', () => {
    const { entries } = loaded()
    const read = { queryFacts: { defaults: {}, queries: [query(GUEST, { preloaded: true }), query(MEMBER, { fetches: 1 })] } }
    expect(check('query/prefetched-under-another-key', entries, read)).toEqual([])

    const later = log()
    later.add(1000, 'query', 'attached', '1 queries already in the cache: 1 success')
    later.add(40_000, 'query', 'fetch', `${MEMBER} fetching`, { key: MEMBER })
    later.add(40_300, 'query', 'success', `${MEMBER} success`, { key: MEMBER, dur: 300 })
    expect(check('query/prefetched-under-another-key', later.entries, setup)).toEqual([])
  })

  it('missing-from-document: names the queries that loaded in the browser before hydration failed', () => {
    const { entries, add } = loaded()
    add(2500, 'console', 'uncaught', 'Error: Hydration failed because the server rendered HTML…')
    // Fetched after the failure: it cannot be what the failing part rendered.
    add(3000, 'query', 'fetch', '["late"] fetching', { key: '["late"]' })
    add(3100, 'query', 'success', '["late"] success', { key: '["late"]', dur: 100 })
    const facts = {
      queryFacts: { defaults: {}, queries: [...setup.queryFacts.queries, query('["late"]', { fetches: 1 })] },
    }
    // The key pair says it better, so this rule leaves it to that one.
    expect(check('query/missing-from-document', entries, facts)).toEqual([])
    const alone = {
      queryFacts: { defaults: {}, queries: facts.queryFacts.queries.filter((q) => q.queryHash !== GUEST) },
    }
    expect(check('query/missing-from-document', entries, alone)).toMatchObject([
      {
        subject: MEMBER,
        evidence: [
          `${MEMBER} — from ProductGrid src/products.tsx:12:5`,
          'fetched in the browser in 300 ms, 1000 ms before the hydration error',
        ],
      },
    ])
  })

  it('missing-from-document: says nothing on a page that hydrated', () => {
    const alone = { queryFacts: { defaults: {}, queries: setup.queryFacts.queries.slice(1) } }
    expect(check('query/missing-from-document', loaded().entries, alone)).toEqual([])
  })
})

describe('same-request-two-keys', () => {
  const price = (id: string) => `GET /_serverFn/getPrice?id=${id}`
  const basket = (...ids: Array<string>) => JSON.stringify(['prices', 'basket', ids])

  /** One fetch of a "basket" query that asks the server for the price of each thing in it. */
  function pick(add: ReturnType<typeof log>['add'], t: number, ...ids: Array<string>) {
    const key = basket(...ids)
    add(t, 'query', 'fetch', `${key} fetching`, { key, at: ['useBasket src/basket.ts:8:3'] })
    for (const id of ids) {
      add(t + 100, 'network', 'ok', `${price(id)} → 200`, { key: 'serverFn:getPrice', dur: 98, detail: { id: price(id) } })
    }
    add(t + 110, 'query', 'success', `${key} success`, { key, dur: 110 })
  }

  it('finds one request repeated by queries under different keys', () => {
    const { entries, add } = log()
    pick(add, 1000, 'a')
    pick(add, 5000, 'a', 'b')
    pick(add, 9000, 'a', 'b', 'c')
    const findings = check('query/same-request-two-keys', entries)
    expect(findings.map((finding) => finding.title)).toEqual([
      'One request was sent 3 times, by queries under 3 different keys',
      'One request was sent 2 times, by queries under 2 different keys',
    ])
    expect(findings[0]).toMatchObject({
      severity: 'warning',
      evidence: [
        `${price('a')}`,
        `while fetching ${basket('a')} — from useBasket src/basket.ts:8:3`,
        `while fetching ${basket('a', 'b')} — from useBasket src/basket.ts:8:3`,
        `while fetching ${basket('a', 'b', 'c')} — from useBasket src/basket.ts:8:3`,
      ],
    })
  })

  it('shows long keys by their shape, so two that differ can be told apart', () => {
    const { entries, add } = log()
    const line = (n: number) => ({ sku: `a-long-product-code-${n}`, quantity: 2, unit: 'box', gift: false })
    const key = (...lines: Array<number>) => JSON.stringify(['prices', 'basket', lines.map(line)])
    const fetchUnder = (t: number, ...lines: Array<number>) => {
      add(t, 'query', 'fetch', `${key(...lines)} fetching`, { key: key(...lines) })
      add(t + 100, 'network', 'ok', `${price('1')} → 200`, { key: 'serverFn:getPrice', dur: 98, detail: { id: price('1') } })
      add(t + 110, 'query', 'success', `${key(...lines)} success`, { key: key(...lines), dur: 110 })
    }
    fetchUnder(1000, 1)
    fetchUnder(5000, 1, 2)
    expect(check('query/same-request-two-keys', entries)[0]!.evidence.slice(1)).toEqual([
      'while fetching ["prices","basket",[1 item]]',
      'while fetching ["prices","basket",[2 items]]',
    ])
  })

  it('leaves a refetch of one key alone', () => {
    const { entries, add } = log()
    pick(add, 1000, 'a')
    pick(add, 5000, 'a')
    expect(check('query/same-request-two-keys', entries)).toEqual([])
  })

  it('leaves alone a request no query was fetching for', () => {
    const { entries, add } = log()
    pick(add, 1000, 'a')
    add(6000, 'network', 'ok', `${price('a')} → 200`, { key: 'serverFn:getPrice', dur: 90, detail: { id: price('a') } })
    expect(check('query/same-request-two-keys', entries)).toEqual([])
  })
})

describe('findings every page shares', () => {
  const finding = (over: Partial<Finding>): Finding => ({
    severity: 'warning',
    title: 'x',
    evidence: [],
    rule: 'core/x',
    ...over,
  })

  it('names them apart from what is about this page', () => {
    const logo = finding({ rule: 'core/broken-images', title: '1 image did not load', evidence: ['/logo.png'] })
    const both = finding({ rule: 'core/broken-images', title: '2 images did not load', evidence: ['/logo.png', '/hero.jpg'] })
    const thirdParty = finding({ rule: 'core/uncaught', title: 'Uncaught error (3 times)', evidence: ['Script error.'] })
    const crash = finding({ rule: 'core/uncaught', severity: 'error', title: 'Uncaught error', evidence: ['TypeError: x is undefined'] })
    const elsewhere = [
      logo,
      finding({ rule: 'core/uncaught', title: 'Uncaught error', evidence: ['Script error. — from vendor.js:1:1'] }),
      crash,
    ]
    expect(partition([logo, thirdParty], elsewhere)).toEqual({
      own: [],
      standing: [
        { severity: 'warning', rule: 'core/broken-images', title: '1 image did not load' },
        { severity: 'warning', rule: 'core/uncaught', title: 'Uncaught error (3 times)' },
      ],
    })
    // Part of it is new here: that part is shown, the rest counted.
    expect(partition([both], elsewhere).own).toEqual([
      { ...both, evidence: ['/hero.jpg', '(1 more that other pages of the app report too)'] },
    ])
    // What another page's finding left out for length still counts as seen.
    const long = finding({ rule: 'core/broken-images', evidence: ['/a.png'], more: ['/hero.jpg'] })
    expect(partition([finding({ rule: 'core/broken-images', evidence: ['/hero.jpg'] })], [long]).own).toEqual([])
    // An error stays, however many pages share it.
    expect(partition([crash], elsewhere).own).toEqual([crash])
    // Nothing to compare with: nothing is folded away.
    expect(partition([logo], []).own).toEqual([logo])
  })

  it('diagnose folds them away by default and lists them with `all`', async () => {
    const hub = new Hub()
    const open = (id: string, url: string, said: Array<[type: string, summary: string]>) => {
      const listeners: Array<(text: string) => void> = []
      const connection: Connection = {
        send: () => {},
        onMessage: (listener) => listeners.push(listener),
        onClose: () => {},
      }
      hub.attach(connection)
      const send = (message: PageMessage) => listeners.forEach((listener) => listener(JSON.stringify(message)))
      send({ kind: 'hello', session: { id, url, title: '', startedAt: 0, has: {}, tools: [] } })
      send({
        kind: 'entries',
        entries: said.map(([type, summary], index) => ({ seq: index + 1, t: index, source: 'console', type, summary })),
      })
    }
    // A third-party script throws on every page; only the cart logs its own error.
    open('home', 'http://localhost/', [['uncaught', 'Script error.']])
    await new Promise((resolve) => setTimeout(resolve, 5))
    open('cart', 'http://localhost/cart', [
      ['uncaught', 'Script error.'],
      ['error', 'cart total does not match its lines'],
    ])
    for (const session of hub.sessions.values()) session.connected = false

    const client = new Client({ name: 'test', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(hub, { sources: SOURCES }).connect(a)
    await client.connect(b)
    const call = async (args: Record<string, unknown>) => {
      const result = (await client.callTool({ name: 'diagnose', arguments: args })) as {
        content: Array<{ text: string }>
      }
      return JSON.parse(result.content[0]!.text)
    }

    const folded = await call({ session: 'cart' })
    expect(folded.findings.map((f: Finding) => f.rule)).toEqual(['core/console-errors'])
    expect(folded.standing.findings).toEqual([
      { severity: 'warning', rule: 'core/uncaught', title: 'Uncaught error' },
    ])
    expect(folded.ok).toBe(false)
    // The page it is compared with has nothing of its own.
    expect((await call({ session: 'home' })).findings).toEqual([])
    const all = await call({ session: 'cart', all: true })
    expect(all.standing).toBeUndefined()
    expect(all.findings.map((f: Finding) => f.rule)).toEqual(['core/console-errors', 'core/uncaught'])
  })
})
