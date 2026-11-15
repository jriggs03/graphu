import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { Claim, Notebook, SamplePack, Status } from './api'
import { GraphView } from './graph/GraphView'
import type { GraphEdge, GraphNode, Selection } from './graph/GraphView'
import { layout, separate } from './graph/layout'
import { RADIUS, abbreviate, need, route, search, tiers } from './graph/model'
import type { Pair, Point } from './graph/model'
import { ConceptPanel, EdgePanel, HistoryPanel, ReviewPanel, claimText } from './Panels'
import type { Tools } from './Panels'
import { ContextBox, Icon, Settings, describe, useFileDrop } from './ui'
import type { Toast } from './ui'

type Mode = 'detail' | 'review' | 'history'

const positionKey = (id: string) => `graphu.positions.${id}`
function savedPositions(id: string): Record<string, Point> {
  try { return JSON.parse(localStorage.getItem(positionKey(id)) ?? '{}') } catch { return {} }
}

export function NotebookScreen({ id, notify }: { id: string; notify: (toast: Toast) => void }) {
  const [notebook, setNotebook] = useState<Notebook>()
  const [missing, setMissing] = useState(false)
  const [selected, setSelected] = useState<Selection>(null)
  const [mode, setMode] = useState<Mode>('detail')
  const [query, setQuery] = useState('')
  const [positions, setPositions] = useState<Record<string, Point>>(() => savedPositions(id))
  const [fitCount, setFitCount] = useState(0)
  const [adding, setAdding] = useState<File[] | null>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; world: Point; node?: string } | null>(null)
  const [newName, setNewName] = useState('')
  /** Set while the student is picking the other end of a link they are drawing by hand. */
  const [linking, setLinking] = useState<{ from: string; as: 'dependent' | 'prerequisite' } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [ai, setAi] = useState(false)
  useEffect(() => { void api.info().then(info => setAi(info.ai_enabled)) }, [])

  useEffect(() => {
    api.getNotebook(id).then(loaded => {
      setNotebook(loaded)
      // On a phone the panel covers the map, so it only opens when asked for.
      if (loaded.claims.some(claim => claim.status === 'pending') && !matchMedia('(max-width: 900px)').matches) setMode('review')
    }).catch(() => setMissing(true))
  }, [id])

  const dragging = useFileDrop(files => setAdding(prior => [...(prior ?? []), ...files]))

  const act = useCallback(async (run: () => Promise<Notebook>) => {
    try {
      setNotebook(await run())
      return true
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : 'Something went wrong.' })
      return false
    }
  }, [notify])

  /* ---------- derive what the graph draws ---------- */
  const graph = useMemo(() => {
    if (!notebook) return null
    const approved = notebook.concepts.filter(concept => concept.status === 'approved').map(concept => concept.id)
    const pairs: Pair[] = notebook.edges.filter(edge => edge.status === 'approved').map(edge => [edge.from, edge.to])
    const tier = tiers(approved, pairs)
    const nodes: GraphNode[] = notebook.concepts.map(concept => ({
      id: concept.id, label: concept.label, symbol: concept.symbol || abbreviate(concept.label),
      tier: tier.get(concept.id) ?? 1, r: RADIUS[tier.get(concept.id) ?? 1],
      pending: concept.status === 'pending', unsourced: concept.user_added,
      newEvidence: concept.evidence.some(item => item.status === 'pending'),
    }))
    const edges: GraphEdge[] = notebook.edges.map(edge => ({
      id: edge.id, from: edge.from, to: edge.to, pending: edge.status === 'pending', unsourced: edge.user_added,
    }))
    const label = (key: string) => notebook.concepts.find(concept => concept.id === key)?.label ?? key
    const order = notebook.target ? route(notebook.target, pairs, label) : []
    return {
      nodes, edges, pairs, order, label,
      all: notebook.edges.map(edge => [edge.from, edge.to] as Pair),
      needSet: notebook.target ? need(notebook.target, pairs) : new Set<string>(),
      steps: new Map(order.map((key, index) => [key, index + 1])),
    }
  }, [notebook])

  // Place any node that has no position yet. Nodes that already have one stay where they are.
  useEffect(() => {
    if (!graph) return
    setPositions(prior => {
      // Sizes change as the graph grows, so nodes that now touch are nudged apart.
      const next = graph.nodes.every(node => prior[node.id]) ? separate(prior, graph.nodes) : layout(graph.nodes, graph.all, prior)
      if (next === prior) return prior
      localStorage.setItem(positionKey(id), JSON.stringify(next))
      return next
    })
  }, [graph, id])

  const matches = useMemo(() => (notebook && query.trim() ? search(notebook, query) : null), [notebook, query])
  const matchSet = useMemo(() => (matches ? new Set(matches.map(match => match.id)) : null), [matches])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((event.target as Element).tagName)) {
        event.preventDefault()
        searchBox.current?.focus()
      }
      if (event.key === 'Escape') {
        setQuery('')
        setAdding(null)
        setMenu(null)
        setLinking(null)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  if (missing) return <div className="lost"><p>That graphbook is not in this browser.</p><a href="#/">Back to home</a></div>
  if (!notebook || !graph) return <div className="lost"><p>Loading…</p></div>

  const select = (selection: Selection) => {
    if (linking && selection?.kind === 'concept' && selection.id !== linking.from) {
      // The second click of a hand-drawn link: join the two concepts.
      const [dependent, prerequisite] = linking.as === 'dependent' ? [linking.from, selection.id] : [selection.id, linking.from]
      setLinking(null)
      void act(() => api.addEdge(notebook.id, dependent, prerequisite))
      return
    }
    setSelected(selection)
    if (selection) setMode('detail')
  }
  const startLink = (from: string, as: 'dependent' | 'prerequisite') => {
    setMenu(null)
    setSelected({ kind: 'concept', id: from })
    setMode('detail')
    setLinking({ from, as })
  }

  const decide = (claim: Claim, status: Status) => {
    void act(() => api.reviewClaim(notebook.id, claim.id, status)).then(ok => {
      if (!ok) return
      const verb = status === 'approved' ? 'Added to your graph' : status === 'rejected' ? 'Rejected' : 'Back in review'
      notify({
        text: `${verb}: ${claimText(claim)}`,
        action: status === 'pending' ? undefined
          : { label: 'Undo', run: () => void act(() => api.reviewClaim(notebook.id, claim.id, 'pending')) },
      })
    })
  }

  const tools: Tools = { notebook, order: graph.order, select, act, decide, ai, startLink, notify }
  const pendingCount = notebook.claims.filter(claim => claim.status === 'pending'
    && !notebook.batches.find(batch => batch.id === claim.batch_id)?.undone).length
  const concept = selected?.kind === 'concept' ? notebook.concepts.find(item => item.id === selected.id) : undefined
  const edge = selected?.kind === 'edge' ? notebook.edges.find(item => item.id === selected.id) : undefined
  const approvedConcepts = notebook.concepts.filter(item => item.status === 'approved')

  /** Add a concept by hand at the spot that was double-clicked or right-clicked. */
  function addHere(at: Point) {
    const label = newName.trim().split(/\s+/).join(' ')
    if (!label) return
    const key = label.toLowerCase()
    setPositions(prior => (prior[key] ? prior : { ...prior, [key]: at }))
    setMenu(null)
    setNewName('')
    void act(() => api.addConcept(notebook!.id, label)).then(ok => { if (ok) select({ kind: 'concept', id: key }) })
  }

  /** Open a concept's panel with the cursor in its notes box. */
  function writeNote(key: string) {
    select({ kind: 'concept', id: key })
    setMenu(null)
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('.note textarea')?.focus(), 60)
  }

  function tidy() {
    const next = layout(graph!.nodes, graph!.all, {})
    localStorage.setItem(positionKey(id), JSON.stringify(next))
    setPositions(next)
    setFitCount(fitCount + 1)
  }

  return <div className="notebook">
    <nav className="rail" aria-label="Notebook tools">
      <a className="rail-button" href="#/" aria-label="Home"><Icon name="home" /><span className="rail-label">Home</span></a>
      <button className="rail-button" aria-label="Search" onClick={() => searchBox.current?.focus()}>
        <Icon name="search" /><span className="rail-label">Search</span>
      </button>
      <button className="rail-button" aria-label="Add material" onClick={() => setAdding([])}>
        <Icon name="add" /><span className="rail-label">Add</span>
      </button>
      <button className="rail-button" aria-label="Sources and history" aria-pressed={mode === 'history'}
        onClick={() => { setSelected(null); setMode('history') }}>
        <Icon name="sources" /><span className="rail-label">Sources</span>
      </button>
      <button className="rail-button" aria-label={`Review, ${pendingCount} waiting`} aria-pressed={mode === 'review'}
        onClick={() => { setSelected(null); setMode('review') }}>
        <Icon name="review" /><span className="rail-label">Review</span>
        {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
      </button>
      <button className="rail-button" aria-label="Tidy the map" onClick={tidy}>
        <Icon name="tidy" /><span className="rail-label">Tidy</span>
      </button>
      <span className="grow" />
      <Settings onReset={() => { localStorage.removeItem(positionKey(id)); location.reload() }} />
    </nav>

    <section className="stage">
      <header className="stage-head">
        <h1>{notebook.title}</h1>
        <div className="search">
          <input ref={searchBox} type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="Search names, slide text, quotes and your notes" aria-label="Search this graphbook" />
          {matches && <div className="results">
            <small>{matches.length ? `${matches.length} match${matches.length === 1 ? '' : 'es'} highlighted` : 'No matches'}</small>
            {matches.map(match => <button key={match.id} onClick={() => select({ kind: 'concept', id: match.id })}>
              <strong>{graph.label(match.id)}</strong><span>{match.why}</span>
            </button>)}
          </div>}
        </div>
      </header>

      <div className="goal">
        <label>I want to learn
          <select value={notebook.target ?? ''}
            onChange={event => void act(() => api.setTarget(notebook.id, event.target.value || null))}>
            <option value="">choose a concept…</option>
            {approvedConcepts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        {graph.order.length > 0 && <ol className="route" aria-label="What you need to know, in order">
          {graph.order.map((key, index) => <li key={key}>
            <button className={selected?.id === key ? 'on' : ''} onClick={() => select({ kind: 'concept', id: key })}>
              <span className="n">{index + 1}.</span>{graph.label(key)}
            </button>
          </li>)}
        </ol>}
      </div>

      {linking && <div className="linking" role="status">
        {linking.as === 'dependent'
          ? <>Click the concept to learn <b>before</b> {graph.label(linking.from)}.</>
          : <>Click the concept that <b>builds on</b> {graph.label(linking.from)}.</>}
        <button onClick={() => setLinking(null)}>Cancel</button>
      </div>}

      {graph.nodes.length ? <GraphView nodes={graph.nodes} edges={graph.edges} positions={positions}
        selected={selected} matches={matchSet} need={graph.needSet} steps={graph.steps} target={notebook.target}
        fitKey={`${id}:${fitCount}`} onSelect={select} onMenu={at => { setNewName(''); setMenu(at) }}
        onMove={(key, point) => setPositions(prior => separate({ ...prior, [key]: point }, graph.nodes, key))}
        onMoveEnd={() => setPositions(prior => { localStorage.setItem(positionKey(id), JSON.stringify(prior)); return prior })} />
        : <div className="graph empty-graph"><p>This graphbook is empty.</p>
          <button className="primary" onClick={() => setAdding([])}>Add material</button></div>}

      {/* The key to the line styles stays out of the way until asked for. */}
      <button className="key-button" aria-label="What the lines and colors mean" aria-expanded={showKey}
        onClick={() => setShowKey(!showKey)}>?</button>
      {showKey && <div className="legend" role="note">
        <span><i className="line arrow" />Arrow: learn this first, then that</span>
        <span><i className="line dashed" />Dashed: new, waiting for your review</span>
        <span><i className="line dotted" />Dotted: you added it, not in your sources</span>
        <span><i className="swatch need" />Need to know for your goal</span>
        <span>Bigger = more concepts rely on it</span>
      </div>}
    </section>

    <aside className={`side${mode === 'detail' && !selected ? ' idle' : ''}`} aria-live="polite">
      <button className="sheet-close" aria-label="Close this panel" onClick={() => { setSelected(null); setMode('detail') }}>×</button>
      {mode === 'review' ? <ReviewPanel tools={tools} />
        : mode === 'history' ? <HistoryPanel tools={tools} />
          : concept ? <ConceptPanel concept={concept} tools={tools} />
            : edge ? <EdgePanel edge={edge} tools={tools} />
              : <div className="detail">
                <h2>{notebook.title}</h2>
                <p className="lede">Click a concept or a link to see the quotes behind it. Drag concepts to arrange the map. Scroll to zoom.</p>
                {pendingCount > 0 && <button className="primary" onClick={() => setMode('review')}>
                  Review {pendingCount} new suggestion{pendingCount === 1 ? '' : 's'}</button>}
              </div>}
    </aside>

    {adding && <AddDialog notebook={notebook} files={adding} setFiles={setAdding} close={() => setAdding(null)}
      act={act} notify={notify} showReview={() => { setSelected(null); setMode('review') }} />}
    {menu && <>
      <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={event => { event.preventDefault(); setMenu(null) }} />
      <div className="menu" role="menu" style={{ left: Math.min(menu.x, innerWidth - 270), top: Math.min(menu.y, innerHeight - 190) }}>
        {menu.node ? <>
          <strong>{graph.label(menu.node)}</strong>
          <button role="menuitem" onClick={() => { select({ kind: 'concept', id: menu.node! }); setMenu(null) }}>See its quotes</button>
          <button role="menuitem" onClick={() => writeNote(menu.node!)}>Write a note on it</button>
          {approvedConcepts.some(item => item.id === menu.node) && <>
            <button role="menuitem" onClick={() => startLink(menu.node!, 'dependent')}>Link: pick what to learn first…</button>
            <button role="menuitem" onClick={() => startLink(menu.node!, 'prerequisite')}>Link: pick what builds on it…</button>
          </>}
          {approvedConcepts.some(item => item.id === menu.node) && <button role="menuitem" onClick={() => {
            void act(() => api.setTarget(notebook.id, notebook.target === menu.node ? null : menu.node!))
            setMenu(null)
          }}>{notebook.target === menu.node ? 'Clear this goal' : 'I want to learn this'}</button>}
        </> : <>
          <strong>Add a concept here</strong>
          <form className="inline" onSubmit={event => { event.preventDefault(); addHere(menu.world) }}>
            <input autoFocus value={newName} maxLength={80} onChange={event => setNewName(event.target.value)}
              placeholder="Concept name" aria-label="Name of the new concept" />
            <button disabled={!newName.trim()}>Add</button>
          </form>
          <small>It is marked “not in slide !” because no source backs it.</small>
          <button role="menuitem" onClick={() => { setAdding([]); setMenu(null) }}>Add slides, notes or a recording…</button>
        </>}
      </div>
    </>}
    {dragging && !adding && <div className="drop-overlay"><div>Drop to add to {notebook.title}</div></div>}
  </div>
}

function AddDialog(props: {
  notebook: Notebook; files: File[]; setFiles: (files: File[]) => void; close: () => void
  act: (run: () => Promise<Notebook>) => Promise<boolean>; notify: (toast: Toast) => void; showReview: () => void
}) {
  const { notebook } = props
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [packs, setPacks] = useState<SamplePack[]>([])
  useEffect(() => { void api.listSamplePacks(notebook.id).then(setPacks) }, [notebook.id])

  async function add(run: () => Promise<{ notebook: Notebook; results: Parameters<typeof describe>[0] }>) {
    setBusy(true)
    let text = ''
    const ok = await props.act(async () => {
      const done = await run()
      text = describe(done.results)
      return done.notebook
    })
    setBusy(false)
    if (!ok) return
    props.notify({ text })
    props.showReview()
    props.close()
  }

  return <div className="modal" role="dialog" aria-modal="true" aria-label="Add material" onClick={event => {
    if (event.target === event.currentTarget) props.close()
  }}>
    <div className="sheet">
      <header><h2>Add to {notebook.title}</h2><button className="quiet" aria-label="Close" onClick={props.close}>×</button></header>
      <ContextBox context={context} setContext={setContext} files={props.files} setFiles={props.setFiles} busy={busy}
        onSubmit={() => void add(() => api.addMaterial(notebook.id, props.files, context))} />
      <p className="hint">You can also drop files anywhere on the graph.</p>

      {packs.length > 0 && <section>
        <h3>Sample material</h3>
        {packs.map(pack => <div className="pack" key={pack.id}>
          <div><strong>{pack.name}</strong><small>“{pack.context}”</small></div>
          <button disabled={busy} onClick={() => void add(() => api.addSamplePack(notebook.id, pack.id))}>Add</button>
        </div>)}
      </section>}

      <section>
        <h3>Add a concept yourself</h3>
        <form className="inline" onSubmit={event => {
          event.preventDefault()
          void props.act(() => api.addConcept(notebook.id, name)).then(ok => { if (ok) props.close() })
        }}>
          <input value={name} onChange={event => setName(event.target.value)} placeholder="Concept name" aria-label="Concept name" />
          <button disabled={!name.trim()}>Add</button>
        </form>
        <small>It goes straight into your graph, marked “not in slide !” because no source backs it.</small>
      </section>
    </div>
  </div>
}
