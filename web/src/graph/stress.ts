/**
 * A made-up graphbook of any size, for checking that large graphs stay fast.
 * Open `#/n/stress-800` to see one with 800 concepts. Nothing here is stored or sent anywhere.
 */
import type { Concept, Edge, Notebook } from '../api'

export function stressNotebook(id: string): Notebook | null {
  const count = Number(/^stress-(\d+)$/.exec(id)?.[1])
  if (!count) return null
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const perLayer = Math.max(4, Math.round(Math.sqrt(count) * 0.9))
  const evidence = (n: number) => [{
    claim_id: n, batch_id: '1', source_id: 'stress', source: 'Stress test.pdf', page: n % 40 + 1,
    quote: `Topic ${n} is introduced on this slide and builds on the earlier topics.`, status: 'approved' as const,
  }]
  const concepts: Concept[] = Array.from({ length: count }, (_, n) => ({
    id: `topic ${n}`, label: `Topic ${n}`, symbol: `T${n}`, status: 'approved', user_added: false,
    evidence: evidence(n), comment: '', visual: null, heading: `Topic ${n} is a made-up concept for testing.`, snippet: null,
  }))
  const edges: Edge[] = []
  for (let n = perLayer; n < count; n++) {
    const layer = Math.floor(n / perLayer)
    const links = 1 + Math.floor(random() * 2)
    const used = new Set<number>()
    for (let k = 0; k < links; k++) {
      const to = (layer - 1) * perLayer + Math.floor(random() * perLayer)
      if (used.has(to)) continue
      used.add(to)
      edges.push({
        id: `topic ${n}→topic ${to}`, from: `topic ${n}`, to: `topic ${to}`, relation: 'relies on',
        status: 'approved', user_added: false, evidence: evidence(n),
      })
    }
  }
  return {
    id, title: `Stress test (${count} concepts)`, concepts, edges, claims: [], target: null,
    batches: [{ id: '1', kind: 'sample', name: 'Stress test.pdf', context: '', created_at: '', undone: false, dropped: 0, note: '' }],
    sources: [{ id: 'stress', name: 'Stress test.pdf', batch_id: '1', pages: Array.from({ length: 40 }, (_, n) => `Slide ${n + 1} of the stress test.`) }],
  }
}
