/**
 * What the document shows that no event in the log records: how the server
 * answered it, images that never arrived, and controls nobody can name.
 * Read from the page as it is at the moment it is asked.
 */
export interface DocumentFacts {
  /** The HTTP status the document was served with, where the browser says. */
  status?: number
  /** Addresses of images that finished loading with nothing to show. */
  brokenImages: Array<string>
  brokenImageCount: number
  /** Links and controls with no accessible name, as short HTML. */
  unnamed: Array<string>
  unnamedCount: number
}

const SHOWN = 8

/**
 * Addresses of images whose `error` event was seen, newest last. An app may
 * swap a failed image for a placeholder, and then the page no longer shows
 * which address failed.
 */
const failed = new Map<string, number>()
const REMEMBERED = 200

const sourceOf = (image: HTMLImageElement) => image.currentSrc || image.getAttribute('src') || ''

/** Called by the network recorder when an image's request fails. */
export function noteFailedImage(image: Element): void {
  if (!(image instanceof HTMLImageElement)) return
  const source = sourceOf(image)
  if (!source || source.startsWith('data:')) return
  failed.set(source, (failed.get(source) ?? 0) + 1)
  if (failed.size > REMEMBERED) failed.delete(failed.keys().next().value!)
}

const CONTROLS =
  'a[href], button, summary, select, textarea, input:not([type="hidden"]), ' +
  '[role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="combobox"]'

const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()

/** Whether layout is real here; a test DOM has none, and then it is not asked. */
function laysOut(): boolean {
  try {
    const box = document.documentElement.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  } catch {
    return false
  }
}

function hidden(element: Element, layout: boolean): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return true
  if (typeof element.checkVisibility === 'function') {
    return !element.checkVisibility({ visibilityProperty: true })
  }
  if (layout) return element.getClientRects().length === 0
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return true
  }
  return false
}

/** A close enough reading of the accessible name rules to tell "none" apart. */
function named(element: Element): boolean {
  if (text(element.getAttribute('aria-label'))) return true
  const labelledBy = text(element.getAttribute('aria-labelledby'))
  if (labelledBy) {
    for (const id of labelledBy.split(' ')) {
      if (text(document.getElementById(id)?.textContent)) return true
    }
  }
  if (text(element.getAttribute('title'))) return true
  if (text(element.textContent)) return true
  // An image or icon inside, with a name of its own.
  for (const inner of element.querySelectorAll('img[alt], [aria-label], svg title')) {
    if (text(inner.getAttribute('alt') ?? inner.getAttribute('aria-label') ?? inner.textContent)) {
      return true
    }
  }
  if (element instanceof HTMLInputElement) {
    const kind = element.type
    if (kind === 'submit' || kind === 'reset') return true
    if ((kind === 'button' || kind === 'image') && text(element.value || element.alt)) return true
    if (text(element.placeholder)) return true
  }
  if (element instanceof HTMLTextAreaElement && text(element.placeholder)) return true
  if (text(element.closest('label')?.textContent)) return true
  const id = element.getAttribute('id')
  if (id) {
    for (const label of document.querySelectorAll('label[for]')) {
      if (label.getAttribute('for') === id && text(label.textContent)) return true
    }
  }
  return false
}

/** The opening tag, and where it sits: enough to find the element in code. */
function shown(element: Element): string {
  const html = element.cloneNode(false) as Element
  const tag = text(html.outerHTML).replace(/<\/[a-z0-9-]+>$/i, '')
  const anchor = element.parentElement?.closest('[id], [data-slot], [data-testid]')
  const place = anchor
    ? anchor.id
      ? `#${anchor.id}`
      : `[${anchor.hasAttribute('data-slot') ? 'data-slot' : 'data-testid'}="${anchor.getAttribute('data-slot') ?? anchor.getAttribute('data-testid')}"]`
    : ''
  return `${tag.length > 220 ? `${tag.slice(0, 220)}…` : tag}${place ? ` in ${place}` : ''}`
}

/** Finished with nothing to show: a failure from before anything listened. */
function brokenImage(image: HTMLImageElement): boolean {
  const source = sourceOf(image)
  // Inline data is not a request, and a vector image may have no size of
  // its own, which is not a failure.
  if (!source || source.startsWith('data:') || /\.svg(?:[?#]|$)/i.test(source)) return false
  return image.complete && image.naturalWidth === 0 && image.naturalHeight === 0
}

export function documentFacts(): DocumentFacts | undefined {
  if (typeof document === 'undefined') return undefined
  const facts: DocumentFacts = { brokenImages: [], brokenImageCount: 0, unnamed: [], unnamedCount: 0 }
  try {
    const navigation = performance.getEntriesByType?.('navigation')[0] as
      | (PerformanceEntry & { responseStatus?: number })
      | undefined
    if (typeof navigation?.responseStatus === 'number' && navigation.responseStatus > 0) {
      facts.status = navigation.responseStatus
    }
  } catch {
    // Not every browser says.
  }
  try {
    const layout = laysOut()
    const broken = new Set(failed.keys())
    for (const image of document.querySelectorAll('img')) {
      if (brokenImage(image)) broken.add(sourceOf(image))
    }
    facts.brokenImageCount = broken.size
    for (const source of broken) {
      if (facts.brokenImages.length >= SHOWN) break
      facts.brokenImages.push(source.length > 240 ? `${source.slice(0, 240)}…` : source)
    }
    const seenControls = new Set<string>()
    for (const control of document.querySelectorAll(CONTROLS)) {
      if (hidden(control, layout) || named(control)) continue
      facts.unnamedCount += 1
      const html = shown(control)
      if (!seenControls.has(html) && facts.unnamed.length < SHOWN) {
        seenControls.add(html)
        facts.unnamed.push(html)
      }
    }
  } catch {
    // Reading the page must never be what breaks it.
  }
  return facts
}
