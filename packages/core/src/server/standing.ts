import type { Finding } from './rules.js'

/**
 * What one line of evidence says, without what varies from page to page:
 * counts, entry numbers and where in the source it came from.
 */
function fingerprint(finding: Finding, line: string): string {
  return `${finding.rule}|${line.replace(/ — from .*$/, '').replace(/\d+/g, '#').slice(0, 240)}`
}

/** A finding as it is listed once it is known not to be about this page. */
export interface StandingFinding {
  severity: Finding['severity']
  rule: string
  title: string
}

/**
 * Splits findings into those about this page and those other pages of the
 * app report too: a third-party script that throws, a logo that never
 * loads, a warning the server logs on every request. Such a finding is true
 * on every page, so it is rarely what an agent looking at one page is after.
 *
 * A finding is standing when every line of its evidence was also found, by
 * the same rule, on a page at another path; when only some lines were, those
 * are counted and the rest shown. Errors always stay whole: a real bug that
 * every page shares must not be folded away.
 */
export function partition(
  findings: Array<Finding>,
  elsewhere: Array<Finding>,
): { own: Array<Finding>; standing: Array<StandingFinding> } {
  const seen = new Set(
    elsewhere.flatMap((finding) =>
      finding.rule
        ? [...finding.evidence, ...(finding.more ?? [])].map((line) => fingerprint(finding, line))
        : [],
    ),
  )
  const own: Array<Finding> = []
  const standing: Array<StandingFinding> = []
  for (const finding of findings) {
    if (finding.rule === undefined || finding.severity === 'error' || finding.evidence.length === 0) {
      own.push(finding)
      continue
    }
    const fresh = finding.evidence.filter((line) => !seen.has(fingerprint(finding, line)))
    if (fresh.length === 0) {
      standing.push({ severity: finding.severity, rule: finding.rule, title: finding.title })
    } else if (fresh.length === finding.evidence.length) {
      own.push(finding)
    } else {
      // Partly shared: the lines other pages have too are counted, not shown.
      const shared = finding.evidence.length - fresh.length
      own.push({
        ...finding,
        evidence: [...fresh, `(${shared} more that other pages of the app report too)`],
      })
    }
  }
  return { own, standing }
}

/** The path of a page address, which is what tells two pages apart here. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
