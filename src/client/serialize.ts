/**
 * Turns any value into JSON-safe data of a bounded size, so one large query
 * result cannot fill an agent's context or a WebSocket frame.
 */

export interface Bounds {
  /** Levels of nesting kept before a value is replaced with a placeholder. */
  depth: number
  /** Array items and object keys kept per container. */
  items: number
  /** Characters kept per string. */
  chars: number
}

export const defaultBounds: Bounds = { depth: 6, items: 50, chars: 2000 }

export function bounded(value: unknown, bounds: Partial<Bounds> = {}): unknown {
  return walk(value, { ...defaultBounds, ...bounds }, 0, new Set())
}

function clip(text: string, chars: number): string {
  return text.length <= chars
    ? text
    : `${text.slice(0, chars)}…(+${text.length - chars} chars)`
}

function walk(
  value: unknown,
  bounds: Bounds,
  level: number,
  path: Set<object>,
): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
      return clip(value, bounds.chars)
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return `${value}n`
    case 'symbol':
      return value.toString()
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`
  }

  const object = value as object
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString()
  }
  if (object instanceof Error) {
    return {
      name: object.name,
      message: clip(object.message, bounds.chars),
      ...(object.stack ? { stack: clip(object.stack, bounds.chars) } : {}),
    }
  }
  if (path.has(object)) return '[Circular]'
  if (level >= bounds.depth) {
    return Array.isArray(object) ? `[Array(${object.length})]` : '[Object]'
  }

  path.add(object)
  try {
    if (Array.isArray(object)) return list(object, bounds, level, path)
    if (object instanceof Map) {
      return { '[Map]': list([...object.entries()], bounds, level, path) }
    }
    if (object instanceof Set) {
      return { '[Set]': list([...object.values()], bounds, level, path) }
    }
    const out: Record<string, unknown> = {}
    const keys = Object.keys(object)
    for (const key of keys.slice(0, bounds.items)) {
      let child: unknown
      try {
        child = (object as Record<string, unknown>)[key]
      } catch (error) {
        child = `[Threw ${String(error)}]`
      }
      if (child === undefined) continue
      out[key] = walk(child, bounds, level + 1, path)
    }
    if (keys.length > bounds.items) {
      out['…'] = `+${keys.length - bounds.items} more keys`
    }
    return out
  } finally {
    path.delete(object)
  }
}

function list(
  items: Array<unknown>,
  bounds: Bounds,
  level: number,
  path: Set<object>,
): Array<unknown> {
  const out = items
    .slice(0, bounds.items)
    .map((item) => walk(item, bounds, level + 1, path))
  if (items.length > bounds.items) {
    out.push(`…(+${items.length - bounds.items} more)`)
  }
  return out
}

/** A one-line description of a value, for log summaries. */
export function brief(value: unknown, chars = 200): string {
  if (typeof value === 'string') return clip(value, chars)
  if (value instanceof Error) return clip(`${value.name}: ${value.message}`, chars)
  try {
    return clip(
      JSON.stringify(bounded(value, { depth: 3, items: 10, chars })) ?? 'null',
      chars,
    )
  } catch {
    return '[Unserializable]'
  }
}
