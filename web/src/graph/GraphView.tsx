import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Point } from './model'

export type GraphNode = {
  id: string; label: string; symbol: string; r: number; tier: number
  pending: boolean; unsourced: boolean; newEvidence: boolean
  /** Set when other concepts sit inside this one: how many. Drawn with a dotted ring and the number. */
  inside?: number
  /** Set on a stand-in for a concept that lives in another topic: where it lives. */
  ghost?: string
}
export type GraphEdge = {
  id: string; from: string; to: string; pending: boolean; unsourced: boolean; linked?: boolean
  /** Set when this line stands for several links between two topics: how many. */
  count?: number
  /** One end is a stand-in for a concept in another topic. */
  out?: boolean
  /** Whether the line is on the "need to know" path. Worked out from its two ends when left unset. */
  path?: boolean
}
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
  /** Double-click on a node. Return true when it was handled (a topic was opened). */
  onOpen?: (id: string) => boolean
  /** Where the student was looking last time. Used once, in place of fitting the whole map. */
  startView?: View | null
  /** Called whenever the student pans or zooms, so the spot can be remembered. */
  onView?: (view: View) => void
  /** Bring this node to the middle of the map. A new `n` asks again for the same node. */
  focus?: { id: string; n: number } | null
}

export type View = { x: number; y: number; k: number }
const MIN_ZOOM = 0.05
const MAX_ZOOM = 3
/** Zoomed out further than this, node names are hidden and only symbols are drawn. */
const FAR = 0.4
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

/**
 * One node. Redrawn only when its own place or look changes, so dragging one node in a graph
 * of a thousand redraws that node (and whatever it pushes), not the other 999.
 */
const NodeMark = memo(function NodeMark({ node, x, y, look, halo, step }: {
  node: GraphNode; x: number; y: number; look: string; halo: boolean; step: number | undefined
}) {
  const text = useMemo(() => lines(node.label), [node.label])
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
  const flag = node.ghost ? `↗ ${node.ghost}` : node.pending ? 'new' : node.unsourced ? 'not in slide !' : ''
  const inside = node.inside ? `, a topic with ${node.inside} concept${node.inside === 1 ? '' : 's'} inside` : ''
  return <g data-node={node.id} className={look} tabIndex={0} role="button"
    aria-label={`${node.label}${inside}${flag ? `, ${flag}` : ''}`} transform={`translate(${x} ${y})`}>
    {halo && <circle className="halo" r={node.r + 7} />}
    {node.inside !== undefined && <circle className="ring" r={node.r + 6} />}
    <circle className="body" r={node.r} />
    {node.symbol && <text className="sym" y={top + symbolSize * 0.82} fontSize={symbolSize.toFixed(1)}>{node.symbol}</text>}
    {text.map((line, index) =>
      <text key={index} className="name" y={top + symbolSize + labelSize * (1.15 * index + 0.95)} fontSize={labelSize.toFixed(1)}>{line}</text>)}
    {flag && <text className="flag" y={-node.r - 8}>{flag}</text>}
    {node.newEvidence && !node.pending && <circle className="dot" cx={node.r * 0.72} cy={-node.r * 0.72} r={6}>
      <title>New evidence waiting for review</title>
    </circle>}
    {node.inside !== undefined && <g className="count" transform={`translate(${node.r * 0.76} ${node.r * 0.76})`}>
      <circle r={11} /><text y={4}>{node.inside}</text>
    </g>}
    {step !== undefined && <g className="step" transform={`translate(${-node.r * 0.72} ${-node.r * 0.72})`}>
      <circle r={11} /><text y={4}>{step}</text>
    </g>}
  </g>
})

/** One link. Redrawn only when an end moves or its look changes. */
const EdgeMark = memo(function EdgeMark({ id, x1, y1, x2, y2, look, arrow, onPath, label, dim }: {
  id: string; x1: number; y1: number; x2: number; y2: number
  look: string; arrow: string; onPath: boolean; label: string; dim: boolean
}) {
  const line = { x1, y1, x2, y2 }
  return <g data-edge={id} className="edge-hit">
    {onPath && <line {...line} className="need-path" />}
    <line {...line} className={look} markerEnd={`url(#arrow-${arrow})`} />
    <line {...line} className="hit" />
    {label && <text className={`edge-label${dim ? ' dim' : ''}`} x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle">{label}</text>}
  </g>
})

export function GraphView(props: Props) {
  const { nodes, edges, positions, selected, matches, need, steps, target, fitKey } = props
  const wrap = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const fitted = useRef('')
  // The node tapped last and when, to tell a double-click on a node from two separate taps.
  const tapped = useRef({ id: '', at: 0 })
  // True once the student has panned or zoomed. Their spot is then kept when the map is resized.
  const touched = useRef(false)
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
    touched.current = false
    return true
  }, [nodes, positions, size])

  useEffect(() => {
    const element = wrap.current!
    const measure = () => setSize(prior => (prior.w === element.clientWidth && prior.h === element.clientHeight
      ? prior : { w: element.clientWidth, h: element.clientHeight }))
    // Measure straight away: a tab opened in the background gets no resize callback until it is shown.
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!size.w) return
    const [doneKey, doneSize] = fitted.current.split('|')
    const sizeNow = `${size.w}x${size.h}`
    if (doneKey !== fitKey) {
      // A notebook opened (or was tidied). Go back to where the student was, or show all of it.
      if (!fitted.current && props.startView) {
        setView(props.startView)
        touched.current = true
        fitted.current = `${fitKey}|${sizeNow}`
      } else if (fit()) fitted.current = `${fitKey}|${sizeNow}`
    } else if (doneSize !== sizeNow) {
      // The space for the map changed size. Re-fit only if the student has not chosen a spot.
      if (touched.current || fit()) fitted.current = `${fitKey}|${sizeNow}`
    }
  }, [fitKey, fit, size, props.startView])

  const { onView, focus } = props
  useEffect(() => { if (fitted.current) onView?.(view) }, [view, onView])

  // Bring a node to the middle: after a search result or a step of the route is clicked.
  const focusedOn = useRef(0)
  useEffect(() => {
    const point = focus && positions[focus.id]
    if (!focus || !point || !size.w || focusedOn.current === focus.n) return
    focusedOn.current = focus.n
    touched.current = true
    setView(prior => {
      // Close enough to read, not so close that its neighbours fall off the screen.
      const k = Math.min(Math.max(prior.k, 0.8), 1.15)
      return { k, x: size.w / 2 - point.x * k, y: size.h / 2 - point.y * k }
    })
  }, [focus, positions, size])

  const zoom = useCallback((factor: number, cx: number, cy: number) => {
    touched.current = true
    setView(prior => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prior.k * factor))
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

  function menu(event: React.MouseEvent<SVGSVGElement>, known?: string) {
    event.preventDefault()
    const box = wrap.current!.getBoundingClientRect()
    props.onMenu({
      x: event.clientX, y: event.clientY,
      world: { x: (event.clientX - box.left - view.x) / view.k, y: (event.clientY - box.top - view.y) / view.k },
      node: known ?? (event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? undefined,
    })
  }

  /** Double-click: open a topic, or (anywhere else) show the menu. */
  function open(event: React.MouseEvent<SVGSVGElement>) {
    // The map captures the pointer, so the event does not say which node was hit. The tap just before does.
    const node = (event.target as Element).closest('[data-node]')?.getAttribute('data-node')
      ?? (Date.now() - tapped.current.at < 600 ? tapped.current.id : undefined)
    if (node && props.onOpen?.(node)) return
    menu(event, node)
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
    if (fingers.current.has(event.pointerId)) fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pinch.current && fingers.current.size >= 2) {
      const { origin, distance, middle } = pinch.current
      const now = twoFingers()
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, origin.k * now.distance / distance))
      touched.current = true
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
    if (current.kind === 'pan') touched.current = true
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
    const again = current.kind === 'node' && !current.moved && tapped.current.id === current.id && Date.now() - tapped.current.at < 600
    if (current.kind === 'node' && !current.moved && !again) {
      props.onSelect({ kind: 'concept', id: current.id })
      tapped.current = { id: current.id, at: Date.now() }
      return
    }
    if (again) return // the second tap of a double-click: already selected
    if (current.moved) {
      if (current.kind === 'node') props.onMoveEnd()
    } else if (current.kind === 'pan') props.onSelect(null)
    else props.onSelect({ kind: current.kind === 'node' ? 'concept' : 'edge', id: current.id })
  }

  /* ---------- what is on screen ---------- */
  // Only the part of the map near the screen is drawn. The drawn area is the screen plus a
  // wide margin, snapped to a coarse grid, so it changes every few hundred pixels of panning
  // and not on every frame. Small graphs are always drawn whole.
  const CULL_ABOVE = 200
  let area = ''
  if (nodes.length > CULL_ABOVE && size.w) {
    const snap = 2 ** Math.ceil(Math.log2(400 / view.k))
    const low = (value: number) => (Math.floor(value / snap) - 1) * snap
    const high = (value: number) => (Math.ceil(value / snap) + 1) * snap
    area = [low(-view.x / view.k), low(-view.y / view.k), high((size.w - view.x) / view.k), high((size.h - view.y) / view.k)].join(',')
  }

  /* ---------- the drawing: rebuilt when the graph or a highlight changes, not on pan or zoom ---------- */
  const scene = useMemo(() => {
    const [left, top, right, bottom] = area ? area.split(',').map(Number) : [-Infinity, -Infinity, Infinity, Infinity]
    const inArea = (point: Point, r: number) => point.x + r > left && point.x - r < right && point.y + r > top && point.y - r < bottom
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

    const edgeMarks = edges.map(edge => {
      const a = positions[edge.to]
      const b = positions[edge.from]
      if (!a || !b) return null
      // A link is drawn when the box around it touches the drawn area.
      if (Math.max(a.x, b.x) < left || Math.min(a.x, b.x) > right || Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) return null
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy) || 1
      // Drawn in learning direction (prerequisite → dependent), stopping at the circle edges.
      const padA = radius.get(edge.to)! + 3
      const padB = radius.get(edge.from)! + 4
      const isSelected = selected?.kind === 'edge' && selected.id === edge.id
      const incident = selected?.kind === 'concept' && (edge.from === selected.id || edge.to === selected.id)
      const onPath = edge.path ?? (!edge.pending && need.has(edge.from) && need.has(edge.to))
      const dim = matches ? !(matches.has(edge.from) && matches.has(edge.to))
        : selected ? !isSelected && !incident && !onPath : need.size ? !onPath && !edge.pending : false
      const look = ['edge', isSelected && 'sel', incident && 'inc', edge.pending && 'pending',
        edge.unsourced && 'unsourced', edge.out && 'out', dim && 'dim'].filter(Boolean).join(' ')
      const label = edge.count ? `${edge.count} link${edge.count === 1 ? '' : 's'}` : edge.linked ? '2 quotes' : ''
      return <EdgeMark key={edge.id} id={edge.id} look={look} onPath={onPath} label={label} dim={dim}
        x1={a.x + dx / length * padA} y1={a.y + dy / length * padA}
        x2={b.x - dx / length * padB} y2={b.y - dy / length * padB}
        arrow={isSelected ? 'accent' : onPath ? 'need' : edge.pending ? 'new' : edge.unsourced ? 'warn' : incident ? 'strong' : 'soft'} />
    })
    const nodeMarks = nodes.map(node => {
      const point = positions[node.id]
      if (!point || !inArea(point, node.r + 30)) return null
      const look = ['node', `tier${node.tier}`, node.symbol && 'has-sym',
        selected?.kind === 'concept' && selected.id === node.id && 'sel',
        related.has(node.id) && 'rel', need.has(node.id) && 'need', node.id === target && 'target',
        matches?.has(node.id) && 'match', node.pending && 'pending', node.unsourced && 'unsourced',
        node.inside !== undefined && 'topic', node.ghost && 'ghost',
        dimNode(node.id) && 'dim'].filter(Boolean).join(' ')
      return <NodeMark key={node.id} node={node} x={point.x} y={point.y} look={look}
        halo={need.has(node.id)} step={steps.get(node.id)} />
    })
    return <>{edgeMarks}{nodeMarks}</>
  }, [nodes, edges, positions, selected, matches, need, steps, target, area])

  /** Enter or Space on a focused node opens it, the same as a click. */
  function keyDown(event: React.KeyboardEvent<SVGSVGElement>) {
    const node = (event.target as Element).closest('[data-node]')?.getAttribute('data-node')
    if (node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      props.onSelect({ kind: 'concept', id: node })
    }
  }

  // The dotted or squared background moves and zooms with the map.
  let spacing = 28 * view.k
  while (spacing < 18) spacing *= 2 // zoomed far out: thin the pattern so it stays readable
  const paper = { '--gs': `${spacing}px`, '--gx': `${view.x}px`, '--gy': `${view.y}px` } as React.CSSProperties

  return <div className={view.k < FAR ? 'graph far' : 'graph'} ref={wrap}>
    <div className="paper" style={paper} />
    <svg width={size.w} height={size.h} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={up} onContextMenu={event => menu(event)} onDoubleClick={open} onKeyDown={keyDown} role="group" aria-label="Concept map">
      <defs>
        {/* One arrowhead per line style. Colors come from the stylesheet (.arrowhead.*). */}
        {['soft', 'strong', 'need', 'accent', 'new', 'warn'].map(kind =>
          <marker key={kind} id={`arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="13" markerHeight="13"
            orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L10,5 L0,10 z" className={`arrowhead ${kind}`} />
          </marker>)}
      </defs>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>{scene}</g>
    </svg>
    <div className="zoom">
      <button aria-label="Zoom out" onClick={() => zoom(1 / 1.25, size.w / 2, size.h / 2)}>−</button>
      <button aria-label="Fit the whole map" onClick={fit}>Fit</button>
      <button aria-label="Zoom in" onClick={() => zoom(1.25, size.w / 2, size.h / 2)}>+</button>
    </div>
  </div>
}
