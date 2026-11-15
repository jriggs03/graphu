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

/** Search concept names, quotes, the student's comments, and the text of cited slides. */
export function search(notebook: Notebook, query: string): Match[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const pages = new Map(notebook.sources.map(source => [source.id, source.pages]))
  const around = (text: string) => {
    const at = text.toLowerCase().indexOf(q)
    const start = Math.max(0, at - 30)
    return (start ? '…' : '') + text.slice(start, at + q.length + 40).trim() + (at + q.length + 40 < text.length ? '…' : '')
  }
  const matches: Match[] = []
  for (const concept of notebook.concepts) {
    if (concept.label.toLowerCase().includes(q) || concept.symbol.toLowerCase().includes(q)) {
      matches.push({ id: concept.id, why: 'Name' })
      continue
    }
    if (concept.snippet?.text.toLowerCase().includes(q)) {
      matches.push({ id: concept.id, why: `Formula · ${concept.snippet.text}` })
      continue
    }
    if (concept.heading.toLowerCase().includes(q)) {
      matches.push({ id: concept.id, why: `AI summary · ${around(concept.heading)}` })
      continue
    }
    const quote = concept.evidence.find(item => item.quote.toLowerCase().includes(q))
    if (quote) {
      matches.push({ id: concept.id, why: `Quote · “${around(quote.quote)}”` })
      continue
    }
    if (concept.comment.toLowerCase().includes(q)) {
      matches.push({ id: concept.id, why: `Your note · ${around(concept.comment)}` })
      continue
    }
    const slide = concept.evidence.find(item => pages.get(item.source_id)?.[item.page - 1]?.toLowerCase().includes(q))
    if (slide) {
      matches.push({
        id: concept.id,
        why: `${slide.source} p. ${slide.page} · ${around(pages.get(slide.source_id)![slide.page - 1])}`,
      })
    }
  }
  return matches
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
