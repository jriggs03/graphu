/**
 * Topics inside topics. Every concept (and every topic) has at most one parent, so a graphbook
 * is a tree of maps: the top level, and one map inside each topic.
 *
 *   Deep learning                      level = null shows:  Attention, Transformers
 *   ├─ Attention                       level = "transformers" shows:  Encoder, Positional encoding
 *   │  └─ Dot-product attention        level = "positional encoding" shows:  Sine waves
 *   └─ Transformers
 *      ├─ Encoder
 *      └─ Positional encoding
 *         └─ Sine waves
 *
 * Links are only ever between concepts. On a level, a link is drawn between whatever stands
 * for its two ends there (see `stand`), so links into a topic add up on that topic.
 */
import type { Notebook } from '../api'

/** The id of the topic whose map is on screen. `null` is the top level. */
export type Level = string | null

export type Tree = ReturnType<typeof tree>

export function tree(notebook: Notebook) {
  const parent = new Map<string, Level>()
  const label = new Map<string, string>()
  for (const item of [...notebook.concepts, ...notebook.topics]) {
    parent.set(item.id, item.parent)
    label.set(item.id, item.label)
  }
  // A parent that is not in the graphbook (its batch was undone, say) counts as the top level.
  for (const [id, up] of parent) if (up && !parent.has(up)) parent.set(id, null)
  const up = (id: string): Level => parent.get(id) ?? null

  const children = new Map<string, string[]>()
  for (const [id, above] of parent) {
    const key = above ?? ''
    if (!children.has(key)) children.set(key, [])
    children.get(key)!.push(id)
  }
  // How many concepts sit inside each topic, at any depth.
  const count = new Map<string, number>()
  for (const concept of notebook.concepts) {
    for (let above = up(concept.id), step = 0; above && step < 50; above = up(above), step++) {
      count.set(above, (count.get(above) ?? 0) + 1)
    }
  }

  return {
    parent: up,
    label: (id: string) => label.get(id) ?? id,
    has: (id: string) => parent.has(id),
    /** True when something sits inside it, so it has a map of its own. */
    isTopic: (id: string) => count.has(id),
    count: (id: string) => count.get(id) ?? 0,
    children: (level: Level) => children.get(level ?? '') ?? [],
    /** The topics around an item, outermost first: "sine waves" → ["transformers", "positional encoding"]. */
    path(id: string) {
      const out: string[] = []
      for (let above = up(id), step = 0; above && step < 50; above = up(above), step++) out.unshift(above)
      return out
    },
    /**
     * What stands for `id` on `level`: the item itself when it is on that level, the topic on
     * that level that holds it when it is deeper, or `null` when it is somewhere else.
     */
    stand(id: string, level: Level): string | null {
      for (let current = id, step = 0; step < 50; step++) {
        const above = up(current)
        if (above === level) return current
        if (above === null) return null
        current = above
      }
      return null
    },
  }
}
