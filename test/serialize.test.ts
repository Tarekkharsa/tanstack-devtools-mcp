import { describe, expect, it } from 'vitest'
import { bounded, brief } from '../src/client/serialize.js'

describe('bounded', () => {
  it('keeps plain JSON as it is', () => {
    const value = { a: 1, b: ['x', true, null], c: { d: 'e' } }
    expect(bounded(value)).toEqual(value)
  })

  it('cuts strings, arrays, keys and depth, and says how much it cut', () => {
    expect(bounded('abcdef', { chars: 3 })).toBe('abc…(+3 chars)')
    expect(bounded([1, 2, 3, 4], { items: 2 })).toEqual([1, 2, '…(+2 more)'])
    expect(bounded({ a: 1, b: 2, c: 3 }, { items: 1 })).toEqual({
      a: 1,
      '…': '+2 more keys',
    })
    expect(bounded({ a: { b: { c: 1 } }, list: [[1]] }, { depth: 1 })).toEqual({
      a: '[Object]',
      list: '[Array(1)]',
    })
  })

  it('marks a cycle but keeps a value that only repeats', () => {
    const shared = { n: 1 }
    const value: Record<string, unknown> = { first: shared, second: shared }
    value.self = value
    expect(bounded(value)).toEqual({
      first: { n: 1 },
      second: { n: 1 },
      self: '[Circular]',
    })
  })

  it('turns values JSON cannot hold into readable ones', () => {
    const out = bounded({
      big: 10n,
      nan: Number.NaN,
      when: new Date('2026-01-02T03:04:05.000Z'),
      fn: function load() {},
      map: new Map([['k', 1]]),
      set: new Set([1]),
      missing: undefined,
      error: new TypeError('nope'),
    }) as Record<string, any>
    expect(out.big).toBe('10n')
    expect(out.nan).toBe('NaN')
    expect(out.when).toBe('2026-01-02T03:04:05.000Z')
    expect(out.fn).toBe('[Function load]')
    expect(out.map).toEqual({ '[Map]': [['k', 1]] })
    expect(out.set).toEqual({ '[Set]': [1] })
    expect('missing' in out).toBe(false)
    expect(out.error).toMatchObject({ name: 'TypeError', message: 'nope' })
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('survives a getter that throws', () => {
    const value = {
      get bad(): never {
        throw new Error('boom')
      },
      ok: 1,
    }
    expect(bounded(value)).toEqual({ bad: '[Threw Error: boom]', ok: 1 })
  })
})

describe('brief', () => {
  it('gives one line for errors, strings and objects', () => {
    expect(brief(new RangeError('too far'))).toBe('RangeError: too far')
    expect(brief('x'.repeat(10), 4)).toBe('xxxx…(+6 chars)')
    expect(brief({ a: [1, 2] })).toBe('{"a":[1,2]}')
  })
})
