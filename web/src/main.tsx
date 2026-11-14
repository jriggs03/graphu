import { useEffect, useState } from 'react'
import type { FormEvent, PointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

type Evidence = { source_id: string; source: string; page: number; quote: string }
type Concept = { id: string; label: string; evidence: Evidence[] }
type Link = { id: number; source: string; target: string; label: string; evidence: Evidence[] }
type Proposal = {
  id: number; title: string; target: string; relation: string
  title_key: string; target_key: string; evidence: Evidence
}
type State = { nodes: Concept[]; edges: Link[]; pending: Proposal[]; ai_enabled: boolean }
type Point = { x: number; y: number }

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, options)
  const data = await response.json()
  if (!response.ok) {
    throw new Error(typeof data.detail === 'string' ? data.detail : 'The request failed.')
  }
  return data
}

function Sources({ evidence }: { evidence: Evidence[] }) {
  return <div className="sources">{evidence.map(item =>
    <figure key={JSON.stringify([item.source_id, item.page, item.quote])}>
      <figcaption>{item.source} · Page {item.page}</figcaption>
      <blockquote>“{item.quote}”</blockquote>
    </figure>,
  )}</div>
}

function Graph({ nodes, edges, select }: {
  nodes: Concept[]; edges: Link[]; select: (item: Concept | Link) => void
}) {
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [zoom, setZoom] = useState(1)
  const width = 720
  const height = Math.max(350, Math.ceil(nodes.length / 4) * 100 + 70)
  const points = new Map(nodes.map((node, index) => {
    const columns = Math.min(nodes.length, 4)
    const x = (index % columns + 1) * width / (columns + 1)
    const y = 95 + Math.floor(index / columns) * 100 + (index % 2) * 35
    return [node.id, positions[node.id] ?? { x, y }]
  }))

  function move(event: PointerEvent<SVGGElement>, id: string) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const matrix = event.currentTarget.ownerSVGElement?.getScreenCTM()
    if (!matrix) return
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    setPositions(prior => ({ ...prior, [id]: {
      x: Math.min(width - 78, Math.max(78, point.x)),
      y: Math.min(height - 25, Math.max(25, point.y)),
    } }))
  }

  return <>
    <div className="graph-tools">
      <button aria-label="Zoom out" disabled={zoom <= 0.75} onClick={() => setZoom(zoom - 0.25)}>−</button>
      <button aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(zoom + 0.25)}>+</button>
    </div>
    <div className="canvas">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: `${zoom * 100}%` }} aria-label="Approved concept map">
        {edges.map(edge => {
          const start = points.get(edge.source)
          const end = points.get(edge.target)
          if (!start || !end) return null
          return <line key={edge.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="connector" />
        })}
        {nodes.map(node => {
          const point = points.get(node.id)!
          return <g key={node.id} className="concept" tabIndex={0} role="button" aria-label={node.label}
            onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={event => move(event, node.id)}
            onClick={() => select(node)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                select(node)
              }
            }}>
            <title>{node.label}</title>
            <rect x={point.x - 76} y={point.y - 21} width={152} height={42} rx={12} />
            <text x={point.x} y={point.y} textAnchor="middle" dominantBaseline="central">
              {node.label.length > 20 ? node.label.slice(0, 19) + '…' : node.label}
            </text>
          </g>
        })}
      </svg>
    </div>
  </>
}

function App() {
  const [state, setState] = useState<State>()
  const [selected, setSelected] = useState<{ kind: 'concept' | 'link'; id: string | number }>()
  const [file, setFile] = useState<File>()
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')

  async function refresh() {
    setState(await api<State>('/state'))
  }

  useEffect(() => { refresh().catch(error => setError(error.message)) }, [])

  async function act(action: () => Promise<string>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const message = await action()
      await refresh()
      setNotice(message)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The request failed.')
    } finally {
      setBusy(false)
    }
  }

  async function importSource(document?: File) {
    await act(async () => {
      const result = await api<{ duplicate: boolean; count: number }>(
        document ? '/documents?' + new URLSearchParams({ name: document.name }) : '/demo',
        document ? { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: document }
          : { method: 'POST' },
      )
      if (result.duplicate) return 'This source is already in your workspace.'
      return result.count ? `${result.count} suggestions ready for review.` : 'No new grounded suggestions.'
    })
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (file && consent) void importSource(file)
  }

  const active = selected?.kind === 'concept' ? state?.nodes.find(node => node.id === selected.id)
    : state?.edges.find(edge => edge.id === selected?.id)
  const label = (id: string) => state?.nodes.find(node => node.id === id)?.label ?? id
  const nodes = state?.nodes.filter(node => node.label.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  const edges = state?.edges.filter(edge =>
    nodes.some(node => node.id === edge.source) && nodes.some(node => node.id === edge.target),
  ) ?? []
  const select = (item: Concept | Link) =>
    setSelected({ kind: 'target' in item ? 'link' : 'concept', id: item.id })

  return <>
    <header><div className="brand"><img src="/icon-192.png" alt="" />Graphu</div><a href="#review">Review suggestions</a></header>
    <main>
      <section className="intro">
        <div><h1>Map what you’re learning.</h1><p>Turn lecture PDFs into a concept map you can trace back to the page.</p></div>
        <button className="primary" disabled={busy} onClick={() => void importSource()}>Try sample notes</button>
      </section>
      {error && <p className="error" role="alert">{error} <button disabled={busy}
        onClick={() => void act(async () => '')}>Refresh workspace</button></p>}
      <div aria-live="polite">{busy ? <p className="notice">Working…</p> : notice && <p className="notice">{notice}</p>}</div>
      <div className="workspace">
        <section className="panel">
          <div className="panel-head"><h2>Concept map</h2>
            <input aria-label="Search concepts" placeholder="Search concepts" value={query}
              onChange={event => setQuery(event.target.value)} />
          </div>
          {nodes.length ? <Graph nodes={nodes} edges={edges} select={select} />
            : <div className="empty">{state?.nodes.length ? 'No concepts match your search.'
              : 'Approve a concept to add it to your map.'}</div>}
          {edges.length > 0 && <ul className="relationships" aria-label="Relationships">
            {edges.map(edge => <li key={edge.id}><button onClick={() => select(edge)}>
              {label(edge.source)} {edge.label} {label(edge.target)}
            </button></li>)}
          </ul>}
        </section>
        <aside>
          <section className="panel">
            <h2>Add a lecture PDF</h2>
            <form onSubmit={submit}>
              <input type="file" aria-label="Lecture PDF" accept=".pdf,application/pdf"
                onChange={event => { setFile(event.target.files?.[0]); setConsent(false) }} />
              <small>Text-based PDFs up to 8 MB and 30 pages.</small>
              <label className="consent"><input type="checkbox" checked={consent}
                onChange={event => setConsent(event.target.checked)} />
                Send extracted page text to OpenAI to generate suggestions.</label>
              <button className="primary" disabled={!state?.ai_enabled || !file || !consent || busy}>Extract concepts</button>
              {state && !state.ai_enabled && <small>Live extraction needs a server API key. Sample notes are available.</small>}
            </form>
          </section>
          <section className="panel">
            <h2>Source evidence</h2>
            {active ? <><h3>{'target' in active
              ? `${label(active.source)} ${active.label} ${label(active.target)}` : active.label}</h3>
              <Sources evidence={active.evidence} /></>
              : <p>Select a concept or relationship to see its supporting quote.</p>}
          </section>
        </aside>
      </div>
      <section className="panel review" id="review">
        <h2>Review suggestions {state?.pending.length ? <span>{state.pending.length}</span> : null}</h2>
        {!state?.pending.length && <p>Your review queue is empty.</p>}
        <div className="review-grid">
          {state?.pending.map(proposal => {
            const ready = !proposal.target || [proposal.title_key, proposal.target_key].every(
              id => state.nodes.some(node => node.id === id),
            )
            return <article key={proposal.id}>
              <small>{proposal.target ? 'Relationship' : 'Concept'}</small>
              <h3>{[proposal.title, proposal.relation, proposal.target].filter(Boolean).join(' ')}</h3>
              <Sources evidence={[proposal.evidence]} />
              {!ready && <small>Approve both concepts to enable this link.</small>}
              <div className="actions">{(['approved', 'rejected'] as const).map(status =>
                <button key={status} disabled={busy || (!ready && status === 'approved')}
                  onClick={() => void act(async () => {
                    await api(`/proposals/${proposal.id}`, {
                      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ status }),
                    })
                    return status === 'approved' ? 'Suggestion added to the map.' : 'Suggestion rejected.'
                  })}>{status === 'approved' ? 'Approve' : 'Reject'}</button>,
              )}</div>
            </article>
          })}
        </div>
      </section>
    </main>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => console.warn('PWA registration failed', error))
}
