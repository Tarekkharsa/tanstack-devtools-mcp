// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { documentFacts } from '@loopsight/core/page'
import { diagnose } from '@loopsight/core/server'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('what the page says about itself', () => {
  it('finds links and controls nobody can name, and leaves the named ones', () => {
    document.body.innerHTML = `
      <footer data-slot="brands">
        <a href="/brands/one" class="tile"></a>
        <a href="/brands/two"><img alt="Brand two" src="/two.png"></a>
        <a href="/brands/three"><img alt="" src="/three.png"></a>
      </footer>
      <button><svg></svg></button>
      <button aria-label="Close"><svg></svg></button>
      <button><svg><title>Share</title></svg></button>
      <button title="Save"></button>
      <button>Send</button>
      <span id="lbl">Dates</span><button aria-labelledby="lbl"></button>
      <input type="text">
      <input type="text" placeholder="Search">
      <label>Email <input type="email"></label>
      <label for="pw">Password</label><input id="pw" type="password">
      <input type="hidden" name="token">
      <input type="submit">
      <div hidden><a href="/hidden"></a></div>
      <div aria-hidden="true"><button></button></div>
      <div style="display: none"><button></button></div>
    `
    const facts = documentFacts()!
    expect(facts.unnamedCount).toBe(4)
    expect(facts.unnamed).toEqual([
      '<a href="/brands/one" class="tile"> in [data-slot="brands"]',
      '<a href="/brands/three"> in [data-slot="brands"]',
      '<button>',
      '<input type="text">',
    ])
  })

  it('says the same control once however often it repeats', () => {
    document.body.innerHTML = '<ul id="list">' + '<li><a href="/x"></a></li>'.repeat(12) + '</ul>'
    const facts = documentFacts()!
    expect(facts.unnamedCount).toBe(12)
    expect(facts.unnamed).toEqual(['<a href="/x"> in #list'])
  })
})

describe('the rules that read it', () => {
  const page = (document: Record<string, unknown>) => ({
    facts: {
      document: { brokenImages: [], brokenImageCount: 0, unnamed: [], unnamedCount: 0, ...document },
    },
  })

  it('reports a page served with an error status, broken images and unnamed controls', () => {
    const found = diagnose(
      [],
      page({
        status: 404,
        brokenImages: ['https://cdn.example/logo.png'],
        brokenImageCount: 3,
        unnamed: ['<a href="/brands/one"> in [data-slot="brands"]'],
        unnamedCount: 1,
      }),
    ).findings
    expect(found.map((finding) => [finding.rule, finding.severity, finding.title])).toEqual([
      ['core/document-status', 'warning', 'The server answered this page with 404'],
      ['core/broken-images', 'warning', '3 images did not load'],
      ['core/unnamed-controls', 'warning', '1 link or control has no accessible name'],
    ])
    expect(found[2]!.evidence).toEqual(['<a href="/brands/one"> in [data-slot="brands"]'])
  })

  it('names a request the page has stopped waiting for', () => {
    const found = diagnose([], {
      waitingOn: [
        { request: 'GET /api/slow', forMs: 42_300 },
        { request: 'GET /api/quick', forMs: 800 },
      ],
    }).findings
    expect(found).toMatchObject([
      {
        rule: 'core/stalled-requests',
        title: '1 request has been in flight for over 10 s',
        evidence: ['42 s and counting: GET /api/slow'],
      },
    ])
  })

  it('says nothing about a healthy page, or one that has closed', () => {
    expect(diagnose([], page({ status: 200 })).findings).toEqual([])
    expect(diagnose([], null).findings).toEqual([])
  })
})
