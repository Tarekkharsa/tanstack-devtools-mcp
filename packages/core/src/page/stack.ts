import type { Frame } from '../protocol.js'

/** Frames from libraries, browser extensions and this package say nothing about the app. */
const NOT_APP =
  /node_modules|loopsight[:\/]|^(?:chrome|moz|safari-web)-extension:|^node:|<anonymous>/

/** More of the same, given by the host: the dev server's own modules. */
let hostFrames: Array<RegExp> = []

export function ignoreFrames(patterns: ReadonlyArray<string>): void {
  hostFrames = patterns.map((source) => new RegExp(source))
}

const CHROME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/
const GECKO = /^(.*?)@(.+?):(\d+):(\d+)$/

/** Reads the frames out of an `Error.stack` string from any browser. */
export function parseStack(stack: unknown): Array<Frame> {
  if (typeof stack !== 'string') return []
  const frames: Array<Frame> = []
  for (const line of stack.split('\n')) {
    const match = CHROME.exec(line) ?? GECKO.exec(line)
    if (!match) continue
    const fn = match[1]?.replace(/^async /, '').trim()
    frames.push({
      ...(fn ? { fn } : {}),
      url: match[2]!,
      line: Number(match[3]),
      column: Number(match[4]),
    })
  }
  return frames
}

/** The app's own frames, most recent call first. */
export function appFrames(stack: unknown, limit = 4): Array<Frame> {
  // A script from another origin (analytics, sign-in widgets) is not the app.
  const origin = typeof location === 'undefined' ? undefined : location.origin
  return parseStack(stack)
    .filter(
      (frame) =>
        /^https?:/.test(frame.url) &&
        !NOT_APP.test(frame.url) &&
        !hostFrames.some((pattern) => pattern.test(frame.url)) &&
        (origin === undefined || origin === 'null' || frame.url.startsWith(`${origin}/`)),
    )
    .slice(0, limit)
}

/** The app code that is running right now. */
export function here(limit = 4): Array<Frame> {
  const holder: { stack?: string } = {}
  const capture = (Error as any).captureStackTrace
  if (typeof capture === 'function') {
    const previous = (Error as any).stackTraceLimit
    ;(Error as any).stackTraceLimit = 40
    capture(holder, here)
    ;(Error as any).stackTraceLimit = previous
  } else {
    holder.stack = new Error().stack ?? ''
  }
  return appFrames(holder.stack, limit)
}
