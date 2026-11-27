import { QUERY_MESSAGES, QUERY_RULES } from './advice-query.js'
import { ROUTER_MESSAGES, ROUTER_RULES } from './advice-router.js'
import { START_MESSAGES, START_RULES } from './advice-start.js'
import type { KnownMessage, Rule } from './rules.js'

export { HYDRATION_FIX } from './advice-start.js'

/**
 * Every rule comes from a library's own documentation or shipped skills, and
 * says which. A check that cannot be tied to one does not belong here.
 */
export const RULES: Array<Rule> = [...QUERY_RULES, ...ROUTER_RULES, ...START_RULES]

export const KNOWN_MESSAGES: Array<KnownMessage> = [
  ...QUERY_MESSAGES,
  ...ROUTER_MESSAGES,
  ...START_MESSAGES,
]
