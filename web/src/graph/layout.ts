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

/** Above this many nodes, only nearby nodes are compared, so the work grows with the graph's size and not its square. */
const LARGE = 150
const CELL = 260

/**
 * Call `visit(a, b)` for pairs of points that may be close together.
 *
 *   small graph: every pair                       (exact, n² / 2 visits)
 *   large graph: pairs in the same or a touching   (about 10 visits per node)
 *                260px square of a grid
 */
function closePairs(x: ArrayLike<number>, y: ArrayLike<number>, count: number, visit: (a: number, b: number) => void) {
  if (count <= LARGE) {
    for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) visit(a, b)
    return
  }
  const cells = new Map<number, number[]>()
  const cellOf = (cx: number, cy: number) => (cx + 50000) * 100003 + (cy + 50000)
  for (let i = 0; i < count; i++) {
    const key = cellOf(Math.floor(x[i] / CELL), Math.floor(y[i] / CELL))
    const cell = cells.get(key)
    if (cell) cell.push(i)
    else cells.set(key, [i])
  }
  for (let a = 0; a < count; a++) {
    const cx = Math.floor(x[a] / CELL)
    const cy = Math.floor(y[a] / CELL)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = cells.get(cellOf(cx + dx, cy + dy))
        if (cell) for (const b of cell) if (b > a) visit(a, b)
      }
    }
  }
}

export function layout(
  nodes: { id: string; r: number }[], edges: Pair[], kept: Record<string, Point>,
): Record<string, Point> {
  const count = nodes.length
  const ids = nodes.map(node => node.id)
  const at = new Map(ids.map((id, index) => [id, index]))
  const present = edges.filter(([from, to]) => at.has(from) && at.has(to))
  const links = present.map(([from, to]) => [at.get(from)!, at.get(to)!] as const)
  const depthOf = depths(ids, present)
  const depth = ids.map(id => depthOf.get(id)!)
  const r = nodes.map(node => node.r)
  const fixed = ids.map(id => Boolean(kept[id]))
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  const neighbours: number[][] = ids.map(() => [])
  const reliesOnFixed = new Uint8Array(count)
  for (const [from, to] of links) {
    neighbours[from].push(to)
    neighbours[to].push(from)
    if (fixed[to]) reliesOnFixed[from] = 1
  }

  // Starting points: next to already-placed neighbours if there are any, else by column.
  const columns = new Map<number, number[]>()
  for (let i = 0; i < count; i++) columns.set(depth[i], [...(columns.get(depth[i]) ?? []), i])
  const row = new Int32Array(count)
  for (const column of columns.values()) column.forEach((i, place) => { row[i] = place })
  for (let i = 0; i < count; i++) {
    if (fixed[i]) {
      x[i] = kept[ids[i]].x
      y[i] = kept[ids[i]].y
      continue
    }
    const near = neighbours[i].filter(other => fixed[other]).map(other => kept[ids[other]])
    if (near.length) {
      const side = reliesOnFixed[i] ? 1 : -1
      x[i] = near.reduce((sum, point) => sum + point.x, 0) / near.length + side * COLUMN * 0.8
      y[i] = near.reduce((sum, point) => sum + point.y, 0) / near.length + jitter(ids[i], 7) * 160
    } else {
      const column = columns.get(depth[i])!
      x[i] = depth[i] * COLUMN + jitter(ids[i], 3) * 40
      y[i] = (row[i] - (column.length - 1) / 2) * 150 + jitter(ids[i], 5) * 40
    }
  }

  const anchored = fixed.some(Boolean)
  const large = count > LARGE
  // A large graph settles in fewer, cheaper rounds.
  const steps = large ? 90 : 300
  const fx = new Float64Array(count)
  const fy = new Float64Array(count)
  for (let step = 0; step < steps; step++) {
    const cooling = 1 - step / steps
    fx.fill(0)
    fy.fill(0)
    closePairs(x, y, count, (a, b) => {
      const dx = x[a] - x[b] || 0.01
      const dy = y[a] - y[b] || 0.01
      const distance = Math.max(Math.hypot(dx, dy), 20)
      const push = 14000 / (distance * distance)
      fx[a] += dx / distance * push
      fy[a] += dy / distance * push
      fx[b] -= dx / distance * push
      fy[b] -= dy / distance * push
    })
    for (const [from, to] of links) {
      const dx = x[to] - x[from]
      const dy = y[to] - y[from]
      const distance = Math.hypot(dx, dy) || 1
      const pull = 0.03 * (distance - (r[from] + r[to] + 110))
      fx[from] += dx / distance * pull
      fy[from] += dy / distance * pull
      fx[to] -= dx / distance * pull
      fy[to] -= dy / distance * pull
    }
    // Keep nodes off links they are not part of, so a link never runs through a label.
    // (Checked against every node on a small graph; a large one relies on spacing alone.)
    if (!large) {
      for (const [from, to] of links) {
        const dx = x[to] - x[from]
        const dy = y[to] - y[from]
        const lengthSq = dx * dx + dy * dy || 1
        for (let i = 0; i < count; i++) {
          if (i === from || i === to) continue
          const along = ((x[i] - x[from]) * dx + (y[i] - y[from]) * dy) / lengthSq
          if (along <= 0.05 || along >= 0.95) continue
          const offX = x[i] - (x[from] + dx * along) || 0.01
          const offY = y[i] - (y[from] + dy * along) || 0.01
          const off = Math.hypot(offX, offY)
          const room = r[i] + 26
          if (off >= room) continue
          const shove = (room - off) * 0.5
          fx[i] += offX / off * shove
          fy[i] += offY / off * shove
          for (const end of [from, to]) {
            fx[end] -= offX / off * shove * 0.5
            fy[end] -= offY / off * shove * 0.5
          }
        }
      }
    }
    for (let i = 0; i < count; i++) {
      if (fixed[i]) continue
      if (!anchored) {
        fx[i] += (depth[i] * COLUMN - x[i]) * 0.05
        fy[i] += -y[i] * 0.006
      }
      const size = Math.hypot(fx[i], fy[i]) || 1
      const limit = Math.min(size, 30 * cooling + 1)
      x[i] += fx[i] / size * limit
      y[i] += fy[i] / size * limit
    }
    untangle()
  }
  // A large graph gets extra rounds of the overlap check alone, until nothing touches.
  for (let pass = 0; large && pass < 40 && untangle(); pass++);
  return Object.fromEntries(ids.map((id, i) => [id, { x: x[i], y: y[i] }]))

  /** Circles never overlap. Returns true when something had to move. */
  function untangle() {
    let moved = false
    closePairs(x, y, count, (a, b) => {
      const dx = x[b] - x[a] || 0.01
      const dy = y[b] - y[a] || 0.01
      const distance = Math.hypot(dx, dy)
      const overlap = r[a] + r[b] + GAP - distance
      if (overlap <= 0) return
      const moveA = fixed[a] ? 0 : fixed[b] ? 1 : 0.5
      const moveB = fixed[b] ? 0 : fixed[a] ? 1 : 0.5
      x[a] -= dx / distance * overlap * moveA
      y[a] -= dy / distance * overlap * moveA
      x[b] += dx / distance * overlap * moveB
      y[b] += dy / distance * overlap * moveB
      if (overlap > 0.5) moved = true
    })
    return moved
  }
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
  const count = placed.length
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  placed.forEach((node, i) => {
    x[i] = positions[node.id].x
    y[i] = positions[node.id].y
  })
  const changed = new Uint8Array(count)
  let any = false
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    closePairs(x, y, count, (a, b) => {
      const dx = x[b] - x[a] || 0.01
      const dy = y[b] - y[a] || 0.01
      const distance = Math.hypot(dx, dy)
      const overlap = placed[a].r + placed[b].r + GAP / 2 - distance
      if (overlap <= 0.01) return
      // The pinned node keeps its place; otherwise both give way equally.
      const shareA = placed[a].id === pinned ? 0 : placed[b].id === pinned ? 1 : 0.5
      x[a] -= dx / distance * overlap * shareA
      y[a] -= dy / distance * overlap * shareA
      x[b] += dx / distance * overlap * (1 - shareA)
      y[b] += dy / distance * overlap * (1 - shareA)
      changed[a] = changed[b] = 1
      moved = true
    })
    if (!moved) break
    any = true
  }
  if (!any) return positions
  const next = { ...positions }
  // Only nodes that moved get a new point, so the rest are not redrawn.
  placed.forEach((node, i) => { if (changed[i]) next[node.id] = { x: x[i], y: y[i] } })
  return next
}
