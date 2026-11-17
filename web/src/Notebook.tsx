import { isRequirement } from './graph/relations'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { Claim, Notebook, SamplePack, Status } from './api'
import { GraphView } from './graph/GraphView'
import type { GraphEdge, GraphNode, Selection, View } from './graph/GraphView'
import { layout, separate } from './graph/layout'
import { RADIUS, abbreviate, need, route, search, searchIndex, tiers } from './graph/model'
import type { Pair, Point } from './graph/model'
import { tree } from './graph/tree'
import type { Level } from './graph/tree'
import { BundlePanel, ConceptPanel, EdgePanel, HistoryPanel, ReviewPanel, TopicPanel, claimText } from './Panels'
import type { Tools } from './Panels'
import { BuildBar, ContextBox, Icon, Settings, describe, useFileDrop } from './ui'
import type { Toast } from './ui'

type Mode = 'detail' | 'review' | 'history'

const positionKey = (id: string) => `graphu.positions.${id}`
function savedPositions(id: string): Record<string, Point> {
  try { return JSON.parse(localStorage.getItem(positionKey(id)) ?? '{}') } catch { return {} }
}

/** Where the student was in a graphbook: the part of the map on screen and the open concept. */
type Place = { view?: View; selected?: string; level?: Level }
const placeKey = (id: string) => `graphu.place.${id}`
function savedPlace(id: string): Place {
  try { return JSON.parse(localStorage.getItem(placeKey(id)) ?? '{}') } catch { return {} }
}

export function NotebookScreen({ id, notify }: { id: string; notify: (toast: Toast) => void }) {
  const [notebook, setNotebook] = useState<Notebook>()
  const [missing, setMissing] = useState(false)
  const [selected, setSelected] = useState<Selection>(null)
  const [mode, setMode] = useState<Mode>('detail')
  const [query, setQuery] = useState('')
  const [positions, setPositions] = useState<Record<string, Point>>(() => savedPositions(id))
  const [fitCount, setFitCount] = useState(0)
  // Coming back to a graphbook puts the student where they left off.
  const [startPlace] = useState(() => savedPlace(id))
  const place = useRef<Place>(startPlace)
  const saving = useRef(0)
  const remember = useCallback((change: Place) => {
    place.current = { ...place.current, ...change }
    clearTimeout(saving.current)
    saving.current = window.setTimeout(() => {
      try { localStorage.setItem(placeKey(id), JSON.stringify(place.current)) } catch { /* storage may be full */ }
    }, 250)
  }, [id])
  const rememberView = useCallback((view: View) => remember({ view }), [remember])
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null)
  // The topic whose map is on screen. `null` is the top level of the graphbook.
  const [wantedLevel, setLevel] = useState<Level>(startPlace.level ?? null)
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
      localStorage.setItem('graphu.last', JSON.stringify({ id: loaded.id, title: loaded.title }))
      // On a phone the panel covers the map, so it only opens when asked for.
      if (matchMedia('(max-width: 900px)').matches) return
      const open = startPlace.selected
      if (open && [...loaded.concepts, ...loaded.topics].some(item => item.id === open)) setSelected({ kind: 'concept', id: open })
      else if (loaded.claims.some(claim => claim.status === 'pending')) setMode('review')
    }).catch(() => setMissing(true))
  }, [id, startPlace])
  useEffect(() => { remember({ selected: selected?.kind === 'concept' ? selected.id : undefined }) }, [selected, remember])

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
  const nest = useMemo(() => (notebook ? tree(notebook) : null), [notebook])
  // A topic that no longer holds anything (its batch was undone, say) falls back to the top level.
  const level: Level = wantedLevel && nest?.isTopic(wantedLevel) ? wantedLevel : null
  useEffect(() => { remember({ level }) }, [level, remember])

  // Everything about the whole graphbook: the learning route crosses every level.
  const whole = useMemo(() => {
    if (!notebook || !nest) return null
    const pairs: Pair[] = notebook.edges.filter(edge => edge.status === 'approved' && isRequirement(edge.relation) && notebook.concepts.some(c => c.id === edge.from && c.status === 'approved') && notebook.concepts.some(c => c.id === edge.to && c.status === 'approved')).map(edge => [edge.from, edge.to])
    const order = notebook.target ? route(notebook.target, pairs, nest.label) : []
    return {
      order, needSet: notebook.target ? need(notebook.target, pairs) : new Set<string>(),
      steps: new Map(order.map((key, index) => [key, index + 1])),
    }
  }, [notebook, nest])

  // What is drawn: the one level that is open.
  //
  //   in:  every concept, topic and link, plus which level is open
  //   out: the nodes on that level, a line for each pair of them that links join (links into a
  //        topic add up on the topic), and a stand-in node for each concept a link reaches elsewhere
  const graph = useMemo(() => {
    if (!notebook || !nest || !whole) return null
    const concepts = new Map(notebook.concepts.map(concept => [concept.id, concept]))
    const here = nest.children(level)
    const standIns = new Map<string, string>() // concept → its stand-in node on this level
    const real = new Map<string, string>()     // and back again
    const standIn = (key: string) => {
      const node = `~${level}~${key}`
      standIns.set(key, node)
      real.set(node, key)
      return node
    }
    const shown = (key: string) => nest.stand(key, level) ?? standIns.get(key) ?? null

    // Group the links by the two nodes that stand for their ends on this level.
    const lines = new Map<string, { from: string; to: string; links: typeof notebook.edges }>()
    for (const edge of notebook.edges) {
      const a = nest.stand(edge.from, level)
      const b = nest.stand(edge.to, level)
      if ((!a && !b) || a === b) continue // somewhere else, or wholly inside one topic
      const from = a ?? standIn(edge.from)
      const to = b ?? standIn(edge.to)
      const key = `${from}->${to}`
      if (!lines.has(key)) lines.set(key, { from, to, links: [] })
      lines.get(key)!.links.push(edge)
    }
    const onPath = (edge: { from: string; to: string; status: string }) =>
      edge.status === 'approved' && whole.needSet.has(edge.from) && whole.needSet.has(edge.to)
    const bundles = new Map<string, typeof notebook.edges>()
    const edges: GraphEdge[] = [...lines.entries()].map(([key, line]) => {
      const only = line.links.length === 1 ? line.links[0] : null
      const out = real.has(line.from) || real.has(line.to)
      // The line is the link itself when both of its ends are the link's own concepts.
      if (only && (real.get(line.from) ?? line.from) === only.from && (real.get(line.to) ?? line.to) === only.to) {
        // One real link between two concepts: click it to see its quotes.
        return { id: only.id, from: line.from, to: line.to, pending: only.status === 'pending', unsourced: only.user_added,
          linked: only.evidence_kind === 'linked', out, path: onPath(only) }
      }
      // A line between topics stands for every link that joins them.
      bundles.set(`links:${key}`, line.links)
      return { id: `links:${key}`, from: line.from, to: line.to, pending: line.links.every(edge => edge.status === 'pending'),
        unsourced: false, count: line.links.length, out, path: line.links.some(onPath) }
    })

    const pairs: Pair[] = edges.filter(edge => !edge.pending && !real.has(edge.from) && !real.has(edge.to)).map(edge => [edge.from, edge.to])
    const inGraph = (key: string) => (concepts.get(key) ?? notebook.topics.find(topic => topic.id === key))?.status === 'approved'
    const tier = tiers(here.filter(inGraph), pairs)
    // A topic shows a dot when something inside it is waiting for review.
    const waiting = new Set<string>()
    for (const concept of notebook.concepts) {
      if (concept.status !== 'pending' && !concept.evidence.some(item => item.status === 'pending')) continue
      for (const above of nest.path(concept.id)) waiting.add(above)
    }
    const chain = level ? [...nest.path(level), level] : []
    const nodes: GraphNode[] = here.map(key => {
      const concept = concepts.get(key)
      const label = nest.label(key)
      const size = tier.get(key) ?? 1
      return {
        id: key, label, symbol: concept?.symbol || abbreviate(label), tier: size, r: RADIUS[size],
        pending: (concept?.status ?? notebook.topics.find(topic => topic.id === key)?.status) === 'pending',
        unsourced: concept?.user_added ?? false,
        newEvidence: waiting.has(key) || Boolean(concept?.evidence.some(item => item.status === 'pending')),
        inside: nest.isTopic(key) ? nest.count(key) : undefined,
      }
    })
    for (const [key, node] of standIns) {
      const concept = concepts.get(key)!
      // Name the first topic on the way to it that is not also around this level.
      const path = nest.path(key)
      const split = path.findIndex((above, index) => above !== chain[index])
      const where = split >= 0 ? nest.label(path[split]) : key === level ? 'this topic'
        : path.length ? nest.label(path[path.length - 1]) : notebook.title
      nodes.push({
        id: node, label: concept.label, symbol: concept.symbol || abbreviate(concept.label), tier: 1, r: 32,
        pending: concept.status === 'pending', unsourced: false, newEvidence: false, ghost: where,
      })
    }

    const needSet = new Set<string>()
    for (const key of whole.needSet) { const node = shown(key); if (node) needSet.add(node) }
    const steps = new Map<string, number>()
    for (const [key, step] of whole.steps) { const node = shown(key); if (node && (node === key || real.has(node))) steps.set(node, step) }
    return {
      nodes, edges, needSet, steps, real, bundles, shown,
      all: edges.map(edge => [edge.from, edge.to] as Pair),
      target: notebook.target ? shown(notebook.target) : null,
    }
  }, [notebook, nest, whole, level])

  // Place any node that has no position yet. Nodes that already have one stay where they are.
  useEffect(() => {
    if (!graph) return
    setPositions(prior => {
      // Sizes change as the graph grows, so nodes that now touch are nudged apart.
      // Each level is laid out on its own. The other levels keep their places.
      const next = graph.nodes.every(node => prior[node.id]) ? separate(prior, graph.nodes)
        : { ...prior, ...layout(graph.nodes, graph.all, prior) }
      if (next === prior) return prior
      localStorage.setItem(positionKey(id), JSON.stringify(next))
      return next
    })
  }, [graph, id])

  const index = useMemo(() => (notebook ? searchIndex(notebook) : []), [notebook])
  const matches = useMemo(() => (query.trim() ? search(index, query) : null), [index, query])
  // A match inside a topic lights up the topic that holds it on the level being shown.
  const matchSet = useMemo(() => (matches && graph
    ? new Set(matches.map(match => graph.shown(match.id)).filter((node): node is string => Boolean(node))) : null), [matches, graph])

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
  if (!notebook || !graph || !nest || !whole) return <div className="lost"><p>Loading…</p></div>

  /** Show a topic's map. `null` is the top level. */
  const open = (next: Level) => {
    setLevel(next)
    setSelected(next ? { kind: 'concept', id: next } : null)
    setMode('detail')
    setMenu(null)
  }
  const select = (picked: Selection) => {
    // A stand-in node means the concept it stands for.
    const selection = picked?.kind === 'concept' && graph.real.has(picked.id) ? { ...picked, id: graph.real.get(picked.id)! } : picked
    if (selection?.kind === 'concept' && nest.has(selection.id) && selection.id !== level) {
      // Selecting something on another level goes to that level and brings it to the middle.
      const home = nest.parent(selection.id)
      if (home !== level) {
        setLevel(home)
        setFocus(prior => ({ id: selection.id, n: (prior?.n ?? 0) + 1 }))
      }
    }
    if (selection?.kind === 'edge') {
      const edge = notebook.edges.find(item => item.id === selection.id)
      if (edge && nest.parent(edge.from) !== level && nest.parent(edge.to) !== level) setLevel(nest.parent(edge.from))
    }
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
  /** Open a concept and bring it to the middle of the map (from search results and the route). */
  const goTo = (key: string) => {
    select({ kind: 'concept', id: key })
    setFocus(prior => ({ id: key, n: (prior?.n ?? 0) + 1 }))
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

  const tools: Tools = { notebook, order: whole.order, select, act, decide, ai, startLink, notify, tree: nest, level, open }
  const label = nest.label
  // What the map highlights: a concept shown here by a stand-in is highlighted on the stand-in.
  // The open topic itself is not on its own map, so selecting it highlights nothing.
  const onMap = selected?.kind === 'concept' ? graph.shown(selected.id) : null
  const marked: Selection = selected?.kind === 'concept' ? (onMap ? { kind: 'concept', id: onMap } : null) : selected
  const pendingCount = notebook.claims.filter(claim => claim.status === 'pending'
    && !notebook.batches.find(batch => batch.id === claim.batch_id)?.undone).length
  const concept = selected?.kind === 'concept' ? notebook.concepts.find(item => item.id === selected.id) : undefined
  const topic = selected?.kind === 'concept' && !concept ? notebook.topics.find(item => item.id === selected.id) : undefined
  const edge = selected?.kind === 'edge' ? notebook.edges.find(item => item.id === selected.id) : undefined
  const bundle = selected?.kind === 'edge' ? graph.bundles.get(selected.id) : undefined
  const approvedConcepts = notebook.concepts.filter(item => item.status === 'approved')

  /** Add a concept by hand at the spot that was double-clicked or right-clicked. */
  function addHere(at: Point) {
    const label = newName.trim().split(/\s+/).join(' ')
    if (!label) return
    const key = label.toLowerCase()
    setPositions(prior => (prior[key] ? prior : { ...prior, [key]: at }))
    setMenu(null)
    setNewName('')
    // A concept added while a topic is open goes into that topic.
    void act(async () => {
      const added = await api.addConcept(notebook!.id, label)
      return level ? api.setParent(notebook!.id, key, level) : added
    }).then(ok => { if (ok) setSelected({ kind: 'concept', id: key }) })
  }

  /** Open a concept's panel with the cursor in its notes box. */
  function writeNote(key: string) {
    select({ kind: 'concept', id: key })
    setMenu(null)
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('.note textarea')?.focus(), 60)
  }

  function tidy() {
    const next = { ...positions, ...layout(graph!.nodes, graph!.all, {}) }
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
      <button className="rail-button" aria-label="Add concepts or material" onClick={() => setAdding([])}>
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
        {level ? <h1 className="crumbs" aria-label="Where you are">
          <button onClick={() => open(null)}>{notebook.title}</button>
          {nest.path(level).map(key => <span key={key}><i>›</i><button onClick={() => open(key)}>{label(key)}</button></span>)}
          <span><i>›</i><b>{label(level)}</b></span>
        </h1> : <h1>{notebook.title}</h1>}
        <div className="search">
          <input ref={searchBox} type="search" value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && matches?.length) goTo(matches[0].id) }}
            placeholder="Search names, slide text, quotes and your notes" aria-label="Search this graphbook" />
          {matches && <div className="results">
            <small>{matches.length ? `${matches.length} match${matches.length === 1 ? '' : 'es'} highlighted · Enter opens the first` : 'No matches'}</small>
            {matches.slice(0, 40).map(match => <button key={match.id} onClick={() => goTo(match.id)}>
              <strong>{label(match.id)}</strong>
              <span>{nest.path(match.id).length > 0 && <em>in {nest.path(match.id).map(label).join(' › ')} · </em>}{match.why}</span>
            </button>)}
            {matches.length > 40 && <small>and {matches.length - 40} more. Type another word to narrow it down.</small>}
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
        {whole.order.length > 0 && <ol className="route" aria-label="What you need to know, in order">
          {whole.order.map((key, index) => <li key={key}>
            <button className={selected?.id === key ? 'on' : ''} onClick={() => goTo(key)}
              title={nest.path(key).length ? `in ${nest.path(key).map(label).join(' › ')}` : undefined}>
              <span className="n">{index + 1}.</span>{label(key)}
            </button>
          </li>)}
        </ol>}
      </div>

      {linking && <div className="linking" role="status">
        {linking.as === 'dependent'
          ? <>Click the concept to learn <b>before</b> {label(linking.from)}.</>
          : <>Click the concept that <b>builds on</b> {label(linking.from)}.</>}
        <button onClick={() => setLinking(null)}>Cancel</button>
      </div>}

      {graph.nodes.length ? <GraphView nodes={graph.nodes} edges={graph.edges} positions={positions}
        selected={marked} matches={matchSet} need={graph.needSet} steps={graph.steps} target={graph.target}
        fitKey={`${id}:${level ?? ''}:${fitCount}`} startView={startPlace.view} onView={rememberView} focus={focus} onSelect={select}
        onOpen={key => { if (!nest.isTopic(key)) return false; open(key); return true }}
        onMenu={at => { setNewName(''); setMenu({ ...at, node: at.node && (graph.real.get(at.node) ?? at.node) }) }}
        onMove={(key, point) => setPositions(prior => separate({ ...prior, [key]: point }, graph.nodes, key))}
        onMoveEnd={() => setPositions(prior => { localStorage.setItem(positionKey(id), JSON.stringify(prior)); return prior })} />
        : <div className="graph empty-graph"><p>This graphbook is empty.</p>
          <p>Build it yourself, or add notes for suggestions.</p>
          <form className="inline" onSubmit={event => { event.preventDefault(); addHere({ x: 0, y: 0 }) }}>
            <input aria-label="First concept name" placeholder="Your first concept" maxLength={80}
              value={newName} onChange={event => setNewName(event.target.value)} />
            <button className="primary" disabled={!newName.trim()}>Add first concept</button>
          </form>
          <button onClick={() => setAdding([])}>Add material</button></div>}

      {/* The key to the line styles stays out of the way until asked for. */}
      <button className="key-button" aria-label="What the lines and colors mean" aria-expanded={showKey}
        onClick={() => setShowKey(!showKey)}>?</button>
      {showKey && <div className="legend" role="note">
        <span><i className="line arrow" />Arrow: learn this first, then that</span>
        <span><i className="line dashed" />Dashed: new, waiting for your review</span>
        <span>2 quotes: a connection across your notes</span>
        <span><i className="line dotted" />Dotted: you added it, not in your sources</span>
        <span><i className="swatch need" />Need to know for your goal</span>
        <span>Bigger = more concepts rely on it</span>
        <span><i className="swatch topic" />Dotted ring and a number: a topic. Double-click to open it</span>
        <span><i className="swatch ghost" />↗ White and dashed: lives in another topic</span>
      </div>}
    </section>

    <aside className={`side${mode === 'detail' && !selected ? ' idle' : ''}`} aria-live="polite">
      <button className="sheet-close" aria-label="Close this panel" onClick={() => { setSelected(null); setMode('detail') }}>×</button>
      {mode === 'review' ? <ReviewPanel tools={tools} />
        : mode === 'history' ? <HistoryPanel tools={tools} />
          : concept ? <ConceptPanel concept={concept} tools={tools} />
            : topic ? <TopicPanel topic={topic} tools={tools} />
            : edge ? <EdgePanel edge={edge} tools={tools} />
            : bundle ? <BundlePanel links={bundle} tools={tools} />
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
          <strong>{label(menu.node)}</strong>
          {nest.isTopic(menu.node) && <button role="menuitem" onClick={() => open(menu.node!)}>Open this topic</button>}
          {notebook.concepts.some(item => item.id === menu.node) && <>
            <button role="menuitem" onClick={() => { select({ kind: 'concept', id: menu.node! }); setMenu(null) }}>See its quotes</button>
            <button role="menuitem" onClick={() => writeNote(menu.node!)}>Write a note on it</button>
          </>}
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

  return <div className="modal" role="dialog" aria-modal="true" aria-label="Add concepts or material" onClick={event => {
    if (event.target === event.currentTarget) props.close()
  }}>
    <div className="sheet">
      <header><h2>Add to {notebook.title}</h2><button className="quiet" aria-label="Close" onClick={props.close}>×</button></header>
      <ContextBox context={context} setContext={setContext} files={props.files} setFiles={props.setFiles} busy={busy}
        onSubmit={() => void add(() => api.addMaterial(notebook.id, props.files, context))} />
      {busy && props.files.length > 0
        ? <BuildBar notebook={notebook.id} title={notebook.title} files={props.files} />
        : <p className="hint">You can also drop files anywhere on the graph.</p>}

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
