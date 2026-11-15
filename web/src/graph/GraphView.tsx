import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Point } from './model'

export type GraphNode = {
  id: string; label: string; symbol: string; r: number; tier: number
  pending: boolean; unsourced: boolean; newEvidence: boolean
}
export type GraphEdge = { id: string; from: string; to: string; pending: boolean; unsourced: boolean; linked?: boolean }
export type Selection = { kind: 'concept' | 'edge'; id: string } | null

type Props = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  positions: Record<string, Point>
  selected: Selection
  /** Search hits. `null` means no search is active. */
  matches: Set<string> | null
  /** Need(target): the concepts on the "need to know" path, and the order to learn them in. */
  need: Set<string>
  steps: Map<string, number>
  target: string | null
  /** Changing this re-fits the view (a different notebook was opened). */
  fitKey: string
  onSelect: (selection: Selection) => void
  onMove: (id: string, point: Point) => void
  onMoveEnd: () => void
  /** Double-click or right-click: where on screen, where on the map, and which node if any. */
  onMenu: (at: { x: number; y: number; world: Point; node?: string }) => void
}

type View = { x: number; y: number; k: number }
type Gesture =
  | { kind: 'node'; id: string; startX: number; startY: number; origin: Point; moved: boolean }
  | { kind: 'edge'; id: string; startX: number; startY: number; moved: boolean }
  | { kind: 'pan'; startX: number; startY: number; origin: View; moved: boolean }

/** Break a label over up to three lines of similar length, so it fits inside a circle. */
function lines(label: string) {
  const words = label.split(' ')
  if (words.length === 1 || label.length <= 9) return [label]
  const join = (from: number, to: number) => words.slice(from, to).join(' ')
  let best = [label]
  let bestWidth = label.length
  const consider = (candidate: string[]) => {
    const width = Math.max(...candidate.map(line => line.length))
    if (width < bestWidth) {
      best = candidate
      bestWidth = width
    }
  }
  for (let cut = 1; cut < words.length; cut++) consider([join(0, cut), join(cut, words.length)])
  if (label.length > 22) {
    for (let first = 1; first < words.length - 1; first++) {
      for (let second = first + 1; second < words.length; second++) {
        consider([join(0, first), join(first, second), join(second, words.length)])
      }
    }
  }
  return best
}

export function GraphView(props: Props) {
  const { nodes, edges, positions, selected, matches, need, steps, target, fitKey } = props
  const wrap = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const fitted = useRef('')
  // Touch: every finger on the map, and the two-finger pinch in progress, if any.
  const fingers = useRef(new Map<number, Point>())
  const pinch = useRef<{ distance: number; middle: Point; origin: View } | null>(null)
  const twoFingers = () => {
    const [a, b] = [...fingers.current.values()]
    const box = wrap.current!.getBoundingClientRect()
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      middle: { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top },
    }
  }

  const fit = useCallback(() => {
    const placed = nodes.filter(node => positions[node.id])
    if (!placed.length || !size.w) return false
    const left = Math.min(...placed.map(node => positions[node.id].x - node.r))
    const right = Math.max(...placed.map(node => positions[node.id].x + node.r))
    const top = Math.min(...placed.map(node => positions[node.id].y - node.r - 18))
    // Extra room at the bottom keeps nodes clear of the zoom buttons.
    const bottom = Math.max(...placed.map(node => positions[node.id].y + node.r + 30))
    const k = Math.min((size.w - 48) / (right - left), (size.h - 48) / (bottom - top), 1.5)
    setView({ k, x: size.w / 2 - (left + right) / 2 * k, y: size.h / 2 - (top + bottom) / 2 * k })
    return true
  }, [nodes, positions, size])

  useEffect(() => {
    const element = wrap.current!
    const observer = new ResizeObserver(() => setSize({ w: element.clientWidth, h: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    // Fit when a notebook opens, and again whenever the space for the map changes size.
    const key = `${fitKey}:${size.w}x${size.h}`
    if (fitted.current !== key && fit()) fitted.current = key
  }, [fitKey, fit, size])

  const zoom = useCallback((factor: number, cx: number, cy: number) => {
    setView(prior => {
      const k = Math.min(3, Math.max(0.25, prior.k * factor))
      return { k, x: cx - (cx - prior.x) * k / prior.k, y: cy - (cy - prior.y) * k / prior.k }
    })
  }, [])

  useEffect(() => {
    const element = wrap.current!
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      zoom(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX - box.left, event.clientY - box.top)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [zoom])

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    // Capture keeps the gesture alive when the finger leaves the map. Some pointers cannot be captured.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* carry on without it */ }
    if (fingers.current.size === 2) {
      // A second finger turns whatever was happening into a pinch-zoom.
      gesture.current = null
      pinch.current = { ...twoFingers(), origin: view }
      return
    }
    const hit = event.target as Element
    const node = hit.closest('[data-node]')?.getAttribute('data-node')
    const edge = hit.closest('[data-edge]')?.getAttribute('data-edge')
    const start = { startX: event.clientX, startY: event.clientY, moved: false }
    gesture.current = node ? { kind: 'node', id: node, origin: positions[node], ...start }
      : edge ? { kind: 'edge', id: edge, ...start }
        : { kind: 'pan', origin: view, ...start }
  }

  function menu(event: React.MouseEvent<SVGSVGElement>) {
    event.preventDefault()
    const box = wrap.current!.getBoundingClientRect()
    props.onMenu({
      x: event.clientX, y: event.clientY,
      world: { x: (event.clientX - box.left - view.x) / view.k, y: (event.clientY - box.top - view.y) / view.k },
      node: (event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? undefined,
    })
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
    if (fingers.current.has(event.pointerId)) fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pinch.current && fingers.current.size >= 2) {
      const { origin, distance, middle } = pinch.current
      const now = twoFingers()
      const k = Math.min(3, Math.max(0.25, origin.k * now.distance / distance))
      // Keep the point between the fingers under the fingers, and follow them as they move.
      setView({ k, x: now.middle.x - (middle.x - origin.x) * k / origin.k, y: now.middle.y - (middle.y - origin.y) * k / origin.k })
      return
    }
    const current = gesture.current
    if (!current) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.moved && Math.hypot(dx, dy) < 5) return
    current.moved = true
    if (current.kind === 'node') props.onMove(current.id, { x: current.origin.x + dx / view.k, y: current.origin.y + dy / view.k })
    if (current.kind === 'pan') setView({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy })
  }

  function up(event: ReactPointerEvent<SVGSVGElement>) {
    fingers.current.delete(event.pointerId)
    if (pinch.current) {
      // Lifting a finger after a pinch must not count as a tap or start a drag.
      if (fingers.current.size === 0) pinch.current = null
      gesture.current = null
      return
    }
    const current = gesture.current
    gesture.current = null
    if (!current) return
    if (current.moved) {
      if (current.kind === 'node') props.onMoveEnd()
    } else if (current.kind === 'pan') props.onSelect(null)
    else props.onSelect({ kind: current.kind === 'node' ? 'concept' : 'edge', id: current.id })
  }

  /* ---------- what is highlighted ---------- */
  const related = new Set<string>()
  if (selected?.kind === 'concept') {
    related.add(selected.id)
    for (const edge of edges) {
      if (edge.from === selected.id) related.add(edge.to)
      if (edge.to === selected.id) related.add(edge.from)
    }
  } else if (selected) {
    const edge = edges.find(item => item.id === selected.id)
    if (edge) related.add(edge.from).add(edge.to)
  }
  // New suggestions stay visible even while a goal dims everything off the path.
  const pendingIds = new Set(nodes.filter(node => node.pending).map(node => node.id))
  const dimNode = (id: string) => matches ? !matches.has(id)
    : selected ? !related.has(id) && !need.has(id)
      : need.size ? !need.has(id) && !pendingIds.has(id) : false

  const radius = new Map(nodes.map(node => [node.id, node.r]))

  // The dotted or squared background moves and zooms with the map.
  let spacing = 28 * view.k
  while (spacing < 18) spacing *= 2 // zoomed far out: thin the pattern so it stays readable
  const paper = { '--gs': `${spacing}px`, '--gx': `${view.x}px`, '--gy': `${view.y}px` } as React.CSSProperties

  return <div className="graph" ref={wrap} style={paper}>
    <svg width={size.w} height={size.h} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={up} onContextMenu={menu} onDoubleClick={menu} role="group" aria-label="Concept map">
      <defs>
        {/* One arrowhead per line style. Colors come from the stylesheet (.arrowhead.*). */}
        {['soft', 'strong', 'need', 'accent', 'new', 'warn'].map(kind =>
          <marker key={kind} id={`arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="13" markerHeight="13"
            orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L10,5 L0,10 z" className={`arrowhead ${kind}`} />
          </marker>)}
      </defs>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {edges.map(edge => {
          const a = positions[edge.to]
          const b = positions[edge.from]
          if (!a || !b) return null
          const dx = b.x - a.x
          const dy = b.y - a.y
          const length = Math.hypot(dx, dy) || 1
          // Drawn in learning direction (prerequisite → dependent), stopping at the circle edges.
          const padA = radius.get(edge.to)! + 3
          const padB = radius.get(edge.from)! + 4
          const line = {
            x1: a.x + dx / length * padA, y1: a.y + dy / length * padA,
            x2: b.x - dx / length * padB, y2: b.y - dy / length * padB,
          }
          const isSelected = selected?.kind === 'edge' && selected.id === edge.id
          const incident = selected?.kind === 'concept' && (edge.from === selected.id || edge.to === selected.id)
          const onPath = !edge.pending && need.has(edge.from) && need.has(edge.to)
          const dim = matches ? !(matches.has(edge.from) && matches.has(edge.to))
            : selected ? !isSelected && !incident && !onPath : need.size ? !onPath && !edge.pending : false
          const classes = ['edge', isSelected && 'sel', incident && 'inc', edge.pending && 'pending',
            edge.unsourced && 'unsourced', dim && 'dim'].filter(Boolean).join(' ')
          return <g key={edge.id} data-edge={edge.id} className="edge-hit">
            {onPath && <line {...line} className="need-path" />}
            <line {...line} className={classes}
              markerEnd={`url(#arrow-${isSelected ? 'accent' : onPath ? 'need' : edge.pending ? 'new'
                : edge.unsourced ? 'warn' : incident ? 'strong' : 'soft'})`} />
            <line {...line} className="hit" />
            {edge.linked && <text className={`edge-label${dim ? ' dim' : ''}`} x={(line.x1 + line.x2) / 2}
              y={(line.y1 + line.y2) / 2 - 5} textAnchor="middle">2 quotes</text>}
          </g>
        })}
        {nodes.map(node => {
          const point = positions[node.id]
          if (!point) return null
          const text = lines(node.label)
          const longest = Math.max(...text.map(line => line.length))
          let symbolSize = node.symbol
            ? Math.min(node.tier === 3 ? 24 : 19, 1.6 * node.r / (node.symbol.length * 0.62)) : 0
          let labelSize = Math.max(8, Math.min(node.tier === 3 ? 15 : 13, (text.length > 2 ? 1.55 : 1.75) * node.r / (longest * 0.55)))
          // Keep symbol plus label inside the circle.
          const squeeze = Math.min(1, 1.4 * node.r / (symbolSize + text.length * labelSize * 1.15))
          symbolSize *= squeeze
          labelSize *= squeeze
          const block = symbolSize + text.length * labelSize * 1.15
          const top = -block / 2
          const classes = ['node', `tier${node.tier}`,
            selected?.kind === 'concept' && selected.id === node.id && 'sel',
            related.has(node.id) && 'rel', need.has(node.id) && 'need', node.id === target && 'target',
            matches?.has(node.id) && 'match', node.pending && 'pending', node.unsourced && 'unsourced',
            dimNode(node.id) && 'dim'].filter(Boolean).join(' ')
          const flag = node.pending ? 'new' : node.unsourced ? 'not in slide !' : ''
          const step = steps.get(node.id)
          return <g key={node.id} data-node={node.id} className={classes} tabIndex={0} role="button"
            aria-label={`${node.label}${flag ? `, ${flag}` : ''}`}
            transform={`translate(${point.x} ${point.y})`}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                props.onSelect({ kind: 'concept', id: node.id })
              }
            }}>
            {need.has(node.id) && <circle className="halo" r={node.r + 7} />}
            <circle className="body" r={node.r} />
            {node.symbol && <text className="sym" y={top + symbolSize * 0.82} fontSize={symbolSize.toFixed(1)}>{node.symbol}</text>}
            {text.map((line, index) =>
              <text key={index} y={top + symbolSize + labelSize * (1.15 * index + 0.95)} fontSize={labelSize.toFixed(1)}>{line}</text>)}
            {flag && <text className="flag" y={-node.r - 8}>{flag}</text>}
            {node.newEvidence && !node.pending && <circle className="dot" cx={node.r * 0.72} cy={-node.r * 0.72} r={6}>
              <title>New evidence waiting for review</title>
            </circle>}
            {step !== undefined && <g className="step" transform={`translate(${-node.r * 0.72} ${-node.r * 0.72})`}>
              <circle r={11} /><text y={4}>{step}</text>
            </g>}
          </g>
        })}
      </g>
    </svg>
    <div className="zoom">
      <button aria-label="Zoom out" onClick={() => zoom(1 / 1.25, size.w / 2, size.h / 2)}>−</button>
      <button aria-label="Fit the whole map" onClick={fit}>Fit</button>
      <button aria-label="Zoom in" onClick={() => zoom(1.25, size.w / 2, size.h / 2)}>+</button>
    </div>
  </div>
}
