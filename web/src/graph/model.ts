/**
 * Graph maths, all in memory in the browser. No server round trip on click, drag or search.
 * An edge [from, to] means "from relies on to": from is the dependent, to is the prerequisite.
 */
import type { Notebook } from '../api'

export type Pair = [from: string, to: string]
export type Point = { x: number; y: number }

/** PageRank on dependent → prerequisite edges: what many concepts rely on scores high. */
export function pagerank(ids: string[], edges: Pair[], damping = 0.85, iterations = 100) {
  const n = ids.length
  const out = new Map(ids.map(id => [id, [] as string[]]))
  const inc = new Map(ids.map(id => [id, [] as string[]]))
  for (const [from, to] of edges) {
    out.get(from)?.push(to)
    inc.get(to)?.push(from)
  }
  let rank = new Map(ids.map(id => [id, 1 / n]))
  for (let step = 0; step < iterations; step++) {
    const dangling = ids.reduce((sum, id) => sum + (out.get(id)!.length ? 0 : rank.get(id)!), 0)
    const next = new Map<string, number>()
    for (const id of ids) {
      const flow = inc.get(id)!.reduce((sum, other) => sum + rank.get(other)! / out.get(other)!.length, 0)
      next.set(id, (1 - damping) / n + damping * dangling / n + damping * flow)
    }
    rank = next
  }
  return rank
}

export const RADIUS = [0, 38, 46, 56] as const

/** Three size tiers, as in the approved prototype. */
export function tiers(ids: string[], edges: Pair[]) {
  const rank = pagerank(ids, edges)
  const max = Math.max(...rank.values(), 0)
  return new Map(ids.map(id => {
    const share = max ? rank.get(id)! / max : 0
    return [id, share >= 0.6 ? 3 : share >= 0.25 ? 2 : 1] as const
  }))
}

/** Need(t) = every concept reachable from t along relies-on edges, plus t itself. */
export function need(target: string, edges: Pair[]) {
  const seen = new Set([target])
  const queue = [target]
  while (queue.length) {
    const current = queue.pop()!
    for (const [from, to] of edges) {
      if (from === current && !seen.has(to)) {
        seen.add(to)
        queue.push(to)
      }
    }
  }
  return seen
}

/** How many prerequisite steps sit below each concept (0 = relies on nothing). Cycle-safe. */
export function depths(ids: string[], edges: Pair[]) {
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!
    if (visiting.has(id)) return 0
    visiting.add(id)
    let value = 0
    for (const [from, to] of edges) if (from === id) value = Math.max(value, visit(to) + 1)
    visiting.delete(id)
    depth.set(id, value)
    return value
  }
  ids.forEach(visit)
  return depth
}

/** A learning order for Need(t): prerequisites always come before what relies on them. */
export function route(target: string, edges: Pair[], label: (id: string) => string) {
  const ids = [...need(target, edges)]
  const inside = edges.filter(([from, to]) => ids.includes(from) && ids.includes(to))
  const depth = depths(ids, inside)
  return ids.sort((a, b) => depth.get(a)! - depth.get(b)! || label(a).localeCompare(label(b)))
}

export type Match = { id: string; why: string }

/** Lower case, with accents removed and joined letters spelled out: "Poincaré" → "poincare". */
export const fold = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()

type Field = { kind: string; text: string; folded: string }
export type SearchIndex = { id: string; label: string; name: string; fields: Field[] }[]

/**
 * Everything searchable about each concept, prepared once per graphbook so that typing stays
 * fast on a large graph. Fields are in order of importance: a hit in the name beats a hit in
 * the formula, the AI summary, a quote, the student's note, and last the text of a cited slide.
 */
export function searchIndex(notebook: Notebook): SearchIndex {
  const pages = new Map(notebook.sources.map(source => [source.id, source.pages]))
  return notebook.concepts.map(concept => {
    const fields: Field[] = []
    const add = (kind: string, text: string | undefined) => { if (text) fields.push({ kind, text, folded: fold(text) }) }
    add('Name', concept.label)
    add('Symbol', concept.symbol)
    add('Formula', concept.snippet?.text)
    add('AI summary', concept.heading)
    for (const item of concept.evidence) add('Quote', item.quote)
    add('Your note', concept.comment)
    const seen = new Set<string>()
    for (const item of concept.evidence) {
      const key = `${item.source_id}:${item.page}`
      if (seen.has(key)) continue
      seen.add(key)
      add(`${item.source} p. ${item.page}`, pages.get(item.source_id)?.[item.page - 1])
    }
    return { id: concept.id, label: concept.label, name: fold(concept.label), fields }
  })
}

/**
 * Find concepts. Every word typed must appear somewhere in the concept (name, formula, summary,
 * quotes, notes or cited slides), in any order. Best matches come first:
 *
 *   "grad"            → Gradient (name starts with it), then concepts whose quotes mention it
 *   "double region"   → Double integrals (its quote has both words)
 */
export function search(index: SearchIndex, query: string): Match[] {
  const phrase = fold(query).trim().replace(/\s+/g, ' ')
  if (!phrase) return []
  const words = phrase.split(' ')
  const found: { id: string; label: string; score: number; why: string }[] = []
  for (const entry of index) {
    let score = entry.name === phrase ? 0 : entry.name.startsWith(phrase) ? 1
      : entry.name.includes(` ${phrase}`) ? 2 : entry.name.includes(phrase) ? 3 : -1
    let why = 'Name'
    if (score < 0) {
      // Each word may be in a different field. The concept ranks by its least important hit.
      let worst = -1
      let word = ''
      for (const part of words) {
        const place = entry.fields.findIndex(field => field.folded.includes(part))
        if (place < 0) { worst = -1; break }
        if (place > worst) { worst = place; word = part }
      }
      if (worst < 0) continue
      const field = entry.fields[worst]
      score = 4 + worst
      if (field.kind !== 'Name') {
        const at = field.folded.indexOf(word)
        const start = Math.max(0, at - 30)
        const end = at + word.length + 40
        const excerpt = (start ? '…' : '') + field.text.slice(start, end).trim() + (end < field.text.length ? '…' : '')
        why = field.kind === 'Quote' ? `Quote · “${excerpt}”` : `${field.kind} · ${excerpt}`
      }
    }
    found.push({ id: entry.id, label: entry.label, score, why })
  }
  return found.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label)).map(({ id, why }) => ({ id, why }))
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with'])

/**
 * A stand-in symbol for a concept that has none, so every node has something large to read:
 * the initials of its name ("Minimum Spanning Tree" → "MST"). One-word names get no stand-in.
 */
export function abbreviate(label: string) {
  const words = label.split(/[\s\-–/]+/).filter(word => word && !SMALL_WORDS.has(word.toLowerCase()))
  if (words.length < 2) return ''
  return words.map(word => word.match(/^\d+/)?.[0] ?? word[0].toUpperCase()).join('').slice(0, 6)
}
