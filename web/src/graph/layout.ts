/**
 * Places nodes so that learning flows left to right: a concept sits to the right of what it
 * relies on. Positions the student already has (from dragging, or from an earlier layout)
 * are kept, so adding a batch never reshuffles the map.
 */
import { depths } from './model'
import type { Pair, Point } from './model'

const COLUMN = 210
const GAP = 34

function jitter(id: string, salt: number) {
  let hash = salt
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) | 0
  return ((hash >>> 0) % 1000) / 1000 - 0.5
}

export function layout(
  nodes: { id: string; r: number }[], edges: Pair[], kept: Record<string, Point>,
): Record<string, Point> {
  const ids = nodes.map(node => node.id)
  const present = edges.filter(([from, to]) => ids.includes(from) && ids.includes(to))
  const depth = depths(ids, present)
  const radius = new Map(nodes.map(node => [node.id, node.r]))
  const fixed = new Set(ids.filter(id => kept[id]))
  const pos = new Map<string, Point>()
  for (const id of fixed) pos.set(id, { ...kept[id] })

  // Starting points: next to already-placed neighbours if there are any, else by column.
  const columns = new Map<number, string[]>()
  for (const id of ids) columns.set(depth.get(id)!, [...(columns.get(depth.get(id)!) ?? []), id])
  for (const id of ids) {
    if (fixed.has(id)) continue
    const near = present.flatMap(([from, to]) => (from === id ? [to] : to === id ? [from] : []))
      .filter(other => fixed.has(other)).map(other => kept[other])
    if (near.length) {
      const side = present.some(([from, to]) => from === id && fixed.has(to)) ? 1 : -1
      pos.set(id, {
        x: near.reduce((sum, point) => sum + point.x, 0) / near.length + side * COLUMN * 0.8,
        y: near.reduce((sum, point) => sum + point.y, 0) / near.length + jitter(id, 7) * 160,
      })
    } else {
      const column = columns.get(depth.get(id)!)!
      pos.set(id, {
        x: depth.get(id)! * COLUMN + jitter(id, 3) * 40,
        y: (column.indexOf(id) - (column.length - 1) / 2) * 150 + jitter(id, 5) * 40,
      })
    }
  }

  const anchored = fixed.size > 0
  for (let step = 0; step < 300; step++) {
    const cooling = 1 - step / 300
    const force = new Map(ids.map(id => [id, { x: 0, y: 0 }]))
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const p = pos.get(ids[a])!
        const q = pos.get(ids[b])!
        const dx = p.x - q.x || 0.01
        const dy = p.y - q.y || 0.01
        const distance = Math.max(Math.hypot(dx, dy), 20)
        const push = 14000 / (distance * distance)
        force.get(ids[a])!.x += dx / distance * push
        force.get(ids[a])!.y += dy / distance * push
        force.get(ids[b])!.x -= dx / distance * push
        force.get(ids[b])!.y -= dy / distance * push
      }
    }
    for (const [from, to] of present) {
      const p = pos.get(from)!
      const q = pos.get(to)!
      const dx = q.x - p.x
      const dy = q.y - p.y
      const distance = Math.hypot(dx, dy) || 1
      const pull = 0.03 * (distance - (radius.get(from)! + radius.get(to)! + 110))
      force.get(from)!.x += dx / distance * pull
      force.get(from)!.y += dy / distance * pull
      force.get(to)!.x -= dx / distance * pull
      force.get(to)!.y -= dy / distance * pull
    }
    // Keep nodes off links they are not part of, so a link never runs through a label.
    for (const [from, to] of present) {
      const p = pos.get(from)!
      const q = pos.get(to)!
      const dx = q.x - p.x
      const dy = q.y - p.y
      const lengthSq = dx * dx + dy * dy || 1
      for (const id of ids) {
        if (id === from || id === to) continue
        const point = pos.get(id)!
        const along = ((point.x - p.x) * dx + (point.y - p.y) * dy) / lengthSq
        if (along <= 0.05 || along >= 0.95) continue
        const offX = point.x - (p.x + dx * along) || 0.01
        const offY = point.y - (p.y + dy * along) || 0.01
        const off = Math.hypot(offX, offY)
        const room = radius.get(id)! + 26
        if (off >= room) continue
        const shove = (room - off) * 0.5
        force.get(id)!.x += offX / off * shove
        force.get(id)!.y += offY / off * shove
        for (const end of [from, to]) {
          force.get(end)!.x -= offX / off * shove * 0.5
          force.get(end)!.y -= offY / off * shove * 0.5
        }
      }
    }
    for (const id of ids) {
      if (fixed.has(id)) continue
      const point = pos.get(id)!
      const push = force.get(id)!
      if (!anchored) {
        push.x += (depth.get(id)! * COLUMN - point.x) * 0.05
        push.y += -point.y * 0.006
      }
      const size = Math.hypot(push.x, push.y) || 1
      const limit = Math.min(size, 30 * cooling + 1)
      point.x += push.x / size * limit
      point.y += push.y / size * limit
    }
    // Circles never overlap.
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const p = pos.get(ids[a])!
        const q = pos.get(ids[b])!
        const dx = q.x - p.x || 0.01
        const dy = q.y - p.y || 0.01
        const distance = Math.hypot(dx, dy)
        const overlap = radius.get(ids[a])! + radius.get(ids[b])! + GAP - distance
        if (overlap <= 0) continue
        const moveA = fixed.has(ids[a]) ? 0 : fixed.has(ids[b]) ? 1 : 0.5
        const moveB = fixed.has(ids[b]) ? 0 : fixed.has(ids[a]) ? 1 : 0.5
        p.x -= dx / distance * overlap * moveA
        p.y -= dy / distance * overlap * moveA
        q.x += dx / distance * overlap * moveB
        q.y += dy / distance * overlap * moveB
      }
    }
  }
  return Object.fromEntries(pos)
}

/**
 * Push overlapping circles apart. `pinned` (the node under the pointer) never moves, so
 * dragging one node into another shoves the other out of the way, and that one can shove
 * the next. Returns the same object when nothing overlapped.
 */
export function separate(
  positions: Record<string, Point>, nodes: { id: string; r: number }[], pinned?: string,
): Record<string, Point> {
  const placed = nodes.filter(node => positions[node.id])
  let next = positions
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) {
        const p = next[placed[a].id]
        const q = next[placed[b].id]
        const dx = q.x - p.x || 0.01
        const dy = q.y - p.y || 0.01
        const distance = Math.hypot(dx, dy)
        const overlap = placed[a].r + placed[b].r + GAP / 2 - distance
        if (overlap <= 0.01) continue
        if (next === positions) next = { ...positions }
        // The pinned node keeps its place; otherwise both give way equally.
        const shareA = placed[a].id === pinned ? 0 : placed[b].id === pinned ? 1 : 0.5
        next[placed[a].id] = { x: p.x - dx / distance * overlap * shareA, y: p.y - dy / distance * overlap * shareA }
        next[placed[b].id] = { x: q.x + dx / distance * overlap * (1 - shareA), y: q.y + dy / distance * overlap * (1 - shareA) }
        moved = true
      }
    }
    if (!moved) break
  }
  return next
}
