import type { Handlers, Recorder } from './types.js'

/**
 * What a source gets when it attaches. The helpers for building entries
 * (`bounded`, `brief`, `here`, `appFrames`) are plain exports of this module.
 */
export interface SourceContext {
  /** Appends an entry to the page's log. */
  record: Recorder
  /** The instance another source is attached to, by that source's key. */
  instanceOf: (key: string) => unknown
  /** Lets a source rename requests it understands, such as RPC calls. */
  network: { annotate: (annotator: RequestAnnotator) => () => void }
}

/** Returns how a request should be shown, or undefined to leave it alone. */
export type RequestAnnotator = (
  url: URL,
  sameOrigin: boolean,
) => { key: string; shown: string } | undefined

export interface FindEnv {
  global: Record<string, any>
  instanceOf: (key: string) => unknown
}

/** What a source hands back once attached. Every part is optional. */
export interface AttachedSource {
  /**
   * Methods the server can call, named `<namespace>.<operation>`. The
   * namespaces must be listed in the source's `methods`.
   */
  handlers?: Handlers
  /** A small summary, placed under the source's key in the page overview. */
  overview?: () => unknown
  /** How the library is set up. Sent to the server for its rules only. */
  facts?: () => unknown
  /** False while the library has work in flight. Holds up `wait_for_idle`. */
  idle?: () => boolean
  stop?: () => void
}

/**
 * One library, seen from inside the page: it records entries, answers reads
 * and actions, and says when it is idle.
 *
 * A source that needs an instance of its library (a client, a router, a
 * store) declares `instance`. One that only listens (console output, an event
 * bus) leaves it out and is attached as soon as the page connects.
 */
export interface PageSource<Instance = any> {
  /** Short and unique: `query`, `router`. Also the key in overview and facts. */
  key: string
  instance?: {
    /** What to call it in messages: "QueryClient", "router instance". */
    label: string
    accepts: (value: unknown) => value is Instance
    /** Finds the instance with no help from the app. Called repeatedly. */
    find?: (env: FindEnv) => Instance | undefined
    /**
     * Globals the library sets. They are watched, so the source attaches the
     * moment one appears instead of at the next check.
     */
    globals?: ReadonlyArray<string>
    /** Said when a tool needs this source and the page has no instance. */
    missing: string
  }
  /** Method namespaces this source answers, such as `['query', 'mutation']`. */
  methods?: ReadonlyArray<string>
  attach: (instance: Instance, context: SourceContext) => AttachedSource
}
