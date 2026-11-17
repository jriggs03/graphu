import { isRequirement } from './graph/relations'
/** The right-hand side of a notebook: concept details, the review queue, and batch history. */
import { useEffect, useState } from 'react'
import { api } from './api'
import type { Batch, Claim, Concept, Edge, Evidence, Notebook, Status, Topic } from './api'
import type { Level, Tree } from './graph/tree'
import type { Selection } from './graph/GraphView'
import type { Toast } from './ui'

export type Tools = {
  notebook: Notebook
  /** Learning order toward the goal, if a goal is set. */
  order: string[]
  select: (selection: Selection) => void
  /** Run an API call, show the new notebook, and report errors. */
  act: (run: () => Promise<Notebook>) => Promise<boolean>
  decide: (claim: Claim, status: Status) => void
  /** True when the server has an AI key, so pictures can be drawn. */
  ai: boolean
  /** Start drawing a link by hand: the next concept clicked on the map is the other end. */
  startLink: (from: string, as: 'dependent' | 'prerequisite') => void
  notify: (toast: Toast) => void
  /** Which topic everything sits in. */
  tree: Tree
  /** The topic whose map is on screen. `null` is the top level. */
  level: Level
  /** Show a topic's map. */
  open: (level: Level) => void
}

/**
 * Take a concept or a link out of the graph by rejecting every claim behind it.
 * Nothing is deleted: each claim can be brought back with Undo under Sources.
 */
async function remove(tools: Tools, claims: Claim[], what: string) {
  if (!confirm(`Remove ${what} from your graph? You can bring it back from Sources.`)) return
  for (const claim of claims) {
    if (!(await tools.act(() => api.reviewClaim(tools.notebook.id, claim.id, 'rejected')))) return
  }
  tools.select(null)
  tools.notify({ text: `Removed ${what}. Undo it under Sources.` })
}
const liveClaims = (tools: Tools) => {
  const undone = new Set(tools.notebook.batches.filter(batch => batch.undone).map(batch => batch.id))
  return tools.notebook.claims.filter(claim => claim.status !== 'rejected' && !undone.has(claim.batch_id))
}

export const claimText = (claim: Claim) =>
  claim.kind === 'edge' ? `${claim.title} ${claim.relation} ${claim.target}` : claim.title

function HighlightedQuote({ quote, name }: { quote: string; name?: string }) {
  if (!name) return <>{quote}</>
  const start = quote.toLocaleLowerCase().indexOf(name.toLocaleLowerCase())
  if (start < 0) return <>{quote}</>
  return <>{quote.slice(0, start)}<mark>{quote.slice(start, start + name.length)}</mark>{quote.slice(start + name.length)}</>
}

function Quotes({ evidence, tools }: { evidence: Evidence[]; tools: Tools }) {
  const claims = new Map(tools.notebook.claims.map(claim => [claim.id, claim]))
  const ids = [...new Set(evidence.map(item => item.claim_id))]
  return <div className="quotes">{ids.map(id => {
    const claim = claims.get(id)
    const passages = evidence.filter(item => item.claim_id === id)
    const linked = claim?.evidence_kind === 'linked'
    return <div key={id}>
      {linked && <small className="tag">Across your notes · 2 quotes</small>}
      <div className={linked ? 'paired-quotes' : ''}>{passages.map((item, index) =>
        <figure key={`${id}-${index}`} className={item.status}>
          {linked && <small>{index === 0 ? 'Uses the prerequisite' : 'Explains the prerequisite'}</small>}
          <blockquote>“<HighlightedQuote quote={item.quote} name={linked && index === 0 ? claim?.target : undefined} />”</blockquote>
          <figcaption>{item.source} · p. {item.page}
            {item.status === 'pending' && <span className="tag new">new</span>}
          </figcaption>
        </figure>
      )}</div>
      {claim?.status === 'pending' && <div className="actions">
        <button disabled={!claim.ready} onClick={() => tools.decide(claim, 'approved')}>Approve</button>
        <button onClick={() => tools.decide(claim, 'rejected')}>Reject</button>
      </div>}
    </div>
  })}</div>
}

function Chip({ concept, pending, tools }: { concept: Concept; pending: boolean; tools: Tools }) {
  return <button className={`chip${pending ? ' pending' : ''}`}
    onClick={() => tools.select({ kind: 'concept', id: concept.id })}>
    {concept.symbol && <code>{concept.symbol}</code>}{concept.label}
  </button>
}

/** Where an item sits: "in Transformers › Positional encoding". Each name opens that topic. */
function Where({ id, tools }: { id: string; tools: Tools }) {
  const path = tools.tree.path(id)
  if (!path.length) return null
  return <div className="in-topic">in {path.map((key, index) => <span key={key}>
    {index > 0 && ' › '}<button className="quiet" onClick={() => tools.open(key)}>{tools.tree.label(key)}</button>
  </span>)}</div>
}

/** For anything that holds other concepts: how many, a button to open its map, and what is in it. */
function Inside({ id, tools }: { id: string; tools: Tools }) {
  const { tree, notebook } = tools
  if (!tree.isTopic(id)) return null
  const count = tree.count(id)
  const status = (key: string) => [...notebook.concepts, ...notebook.topics].find(item => item.id === key)?.status
  return <div className="inside">
    <div className="inside-head">
      <span><b>Topic</b> · {count} concept{count === 1 ? '' : 's'} inside</span>
      {tools.level === id
        ? <button onClick={() => tools.open(tree.parent(id))}>↑ Up one level</button>
        : <button className="primary" onClick={() => tools.open(id)}>Open →</button>}
    </div>
    <div className="rel">{tree.children(id).map(key =>
      <button key={key} className={`chip${status(key) === 'pending' ? ' pending' : ''}`}
        onClick={() => tools.select({ kind: 'concept', id: key })}>
        {tree.label(key)}{tree.isTopic(key) && <small>{tree.count(key)}</small>}
      </button>)}</div>
  </div>
}

/**
 * Move a concept (or a topic) into another topic, a new topic, or out to the top level.
 * The AI proposes where things go; this is where the student decides.
 */
function MoveRow({ id, tools }: { id: string; tools: Tools }) {
  const { tree, notebook } = tools
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  useEffect(() => { setNaming(false); setName('') }, [id])
  // Anything that already holds concepts can receive this one, except itself and what is inside it.
  const topics = [...notebook.topics, ...notebook.concepts]
    .filter(item => tree.isTopic(item.id) && item.id !== id && !tree.path(item.id).includes(id))
    .sort((a, b) => a.label.localeCompare(b.label))
  const move = (parent: string | null) => void tools.act(() => api.setParent(notebook.id, id, parent))
  async function intoNew() {
    const label = name.trim().split(/\s+/).join(' ')
    const key = label.toLowerCase()
    if (!label) return
    const here = tree.parent(id)
    // The new topic takes this item's place on the map, and the item goes inside it.
    const ok = await tools.act(async () => {
      await api.addConcept(notebook.id, label)
      if (here) await api.setParent(notebook.id, key, here)
      return api.setParent(notebook.id, id, key)
    })
    if (ok) setNaming(false)
  }
  return <div className="move">
    <label className="symbol-edit">Topic
      <select value={tree.parent(id) ?? ''} aria-label="The topic this sits in"
        onChange={event => (event.target.value === '+' ? setNaming(true) : move(event.target.value || null))}>
        <option value="">Top level</option>
        {topics.map(item => <option key={item.id} value={item.id}>{'– '.repeat(tree.path(item.id).length)}{item.label}</option>)}
        <option value="+">New topic…</option>
      </select>
    </label>
    {naming && <form className="inline" onSubmit={event => { event.preventDefault(); void intoNew() }}>
      <input autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)}
        placeholder="Name of the new topic" aria-label="Name of the new topic" />
      <button disabled={!name.trim()}>Move</button>
    </form>}
  </div>
}

/** A topic that is not itself a concept from the material: a named group. */
export function TopicPanel({ topic, tools }: { topic: Topic; tools: Tools }) {
  return <div className="detail">
    <div className="where">Topic</div>
    <Where id={topic.id} tools={tools} />
    <h2 className="heading">{topic.label}</h2>
    {topic.status === 'pending' && <p className="callout new">Everything inside is a new suggestion. The topic joins your graph when you approve something in it.</p>}
    <p className="lede">A topic groups concepts so a large map can be opened one part at a time. It is a way of organizing, not a claim from your material, so it has no quotes of its own.</p>
    <Inside id={topic.id} tools={tools} />
    <MoveRow id={topic.id} tools={tools} />
  </div>
}

/** A line between two topics: every link it stands for. */
export function BundlePanel({ links, tools }: { links: Edge[]; tools: Tools }) {
  const label = tools.tree.label
  return <div className="detail">
    <div className="where">{links.length} links</div>
    <h2 className="heading">This line stands for {links.length} link{links.length === 1 ? '' : 's'} between concepts inside these topics</h2>
    <p className="lede">Pick one to see the quotes behind it.</p>
    <div className="bundle">{links.map(edge =>
      <button key={edge.id} className={`chip${edge.status === 'pending' ? ' pending' : ''}`}
        onClick={() => tools.select({ kind: 'edge', id: edge.id })}>
        {label(edge.from)} <small>{edge.relation}</small> {label(edge.to)}
      </button>)}</div>
  </div>
}

export function ConceptPanel({ concept, tools }: { concept: Concept; tools: Tools }) {
  const { notebook, order } = tools
  const byId = new Map(notebook.concepts.map(item => [item.id, item]))
  const learnFirst = notebook.edges.filter(edge => edge.from === concept.id && isRequirement(edge.relation))
  const usedBy = notebook.edges.filter(edge => edge.to === concept.id && isRequirement(edge.relation))
  const step = order.indexOf(concept.id)
  const goal = notebook.target ? byId.get(notebook.target) : undefined
  const approved = concept.status === 'approved'
  const linkable = notebook.concepts.filter(item => item.status === 'approved' && item.id !== concept.id
    && !learnFirst.some(edge => edge.to === item.id) && !usedBy.some(edge => edge.from === item.id))
  const [note, setNote] = useState(concept.comment)
  useEffect(() => setNote(concept.comment), [concept.id, concept.comment])

  const next = !goal ? null
    : step >= 0 && step < order.length - 1 ? byId.get(order[step + 1])!
      : step < 0 ? byId.get(order[0])! : null

  return <div className="detail">
    <div className="where">{!goal ? 'Exploring'
      : step >= 0 ? <>Step {step + 1} of {order.length} toward <b>{goal.label}</b></>
        : <>Not needed for <b>{goal.label}</b></>}</div>
    {/* Order follows docs/design/prototype-autoencoders.html:
        heading → snippet → quotes → Learn first / Used by → I want to learn this. */}
    <Where id={concept.id} tools={tools} />
    <h3 className="concept-name">{concept.symbol && <code>{concept.symbol}</code>}{concept.label}</h3>
    {concept.heading
      ? <h2 className="heading">{concept.heading} <span className="tag ai">AI summary</span></h2>
      : <h2 className="heading">{concept.label}</h2>}
    {!approved && <p className="callout new">New suggestion. It is not part of your graph until you approve it.</p>}
    {concept.user_added && <p className="callout unsourced"><b>Not in slide !</b> You added this yourself. No source in this graphbook backs it.</p>}
    {concept.snippet && <figure className="snippet">
      <pre>{concept.snippet.text}</pre>
      <figcaption>slide {concept.snippet.page} · {concept.snippet.source}</figcaption>
    </figure>}
    <Quotes evidence={concept.evidence} tools={tools} />
    <Inside id={concept.id} tools={tools} />

    <div className="rel"><h3>Learn first</h3>
      {learnFirst.map(edge => <Chip key={edge.id} concept={byId.get(edge.to)!} pending={edge.status === 'pending'} tools={tools} />)}
      {!learnFirst.length && <span className="none">Nothing. Start here.</span>}
    </div>
    <div className="rel"><h3>Used by</h3>
      {usedBy.map(edge => <Chip key={edge.id} concept={byId.get(edge.from)!} pending={edge.status === 'pending'} tools={tools} />)}
      {!usedBy.length && <span className="none">Nothing else in this map yet.</span>}
    </div>
    {approved && <div className="goal-actions">
      {notebook.target === concept.id
        ? <button onClick={() => void tools.act(() => api.setTarget(notebook.id, null))}>Clear goal</button>
        : <button onClick={() => void tools.act(() => api.setTarget(notebook.id, concept.id))}>I want to learn this</button>}
      {next && <button className="primary" onClick={() => tools.select({ kind: 'concept', id: next.id })}>
        {step >= 0 ? `Next · ${next.label} →` : `Back to the path · 1. ${next.label}`}
      </button>}
    </div>}
    {approved && <div className="link-buttons">
      <button onClick={() => tools.startLink(concept.id, 'dependent')}>+ Link what to learn first</button>
      <button onClick={() => tools.startLink(concept.id, 'prerequisite')}>+ Link what builds on this</button>
    </div>}
    {approved && linkable.length > 0 && <select className="link-add" value="" aria-label="Add a prerequisite yourself"
      onChange={event => void tools.act(() => api.addEdge(notebook.id, concept.id, event.target.value))}>
      <option value="">+ Add something to learn first…</option>
      {linkable.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>}


    <label className="symbol-edit">Symbol on the map
      <input key={concept.id + concept.symbol} defaultValue={concept.symbol} maxLength={12} placeholder="e.g. ∫ or MST"
        onBlur={event => {
          if (event.target.value.trim() !== concept.symbol) void tools.act(() => api.setSymbol(notebook.id, concept.id, event.target.value))
        }} />
    </label>

    <MoveRow id={concept.id} tools={tools} />

    <label className="note">Your notes
      <textarea rows={3} value={note} placeholder="Add a comment. Search finds these too."
        onChange={event => setNote(event.target.value)}
        onBlur={() => { if (note.trim() !== concept.comment) void tools.act(() => api.setComment(notebook.id, concept.id, note)) }} />
    </label>
    <button className="danger remove" onClick={() => void remove(tools,
      liveClaims(tools).filter(claim => claim.kind === 'concept' && claim.concept_id === concept.id), `“${concept.label}”`)}>
      Remove this concept from my graph</button>
  </div>
}

export function EdgePanel({ edge, tools }: { edge: Edge; tools: Tools }) {
  const byId = new Map(tools.notebook.concepts.map(item => [item.id, item]))
  const from = byId.get(edge.from)!
  const to = byId.get(edge.to)!
  const waiting = edge.status === 'pending' && (from.status === 'pending' || to.status === 'pending')
  return <div className="detail">
    <div className="where">Link</div>
    <h2>{from.label} {edge.relation} {to.label}</h2>
    {edge.status === 'pending' && <p className="callout new">New suggestion. {waiting
      ? 'Approve both concepts first, then this link can join your graph.'
      : 'It is not part of your graph until you approve it.'}</p>}
    {edge.user_added && <p className="callout unsourced"><b>Not in slide !</b> You added this link yourself. No source backs it.</p>}
    {edge.evidence_kind === 'linked' && <p className="lede">Both passages were found in your notes. Check that they support this learning dependency before approving it.</p>}
    <Quotes evidence={edge.evidence} tools={tools} />
    <div className="rel"><h3>{isRequirement(edge.relation) ? 'Learn first' : edge.relation}</h3><Chip concept={to} pending={to.status === 'pending'} tools={tools} /></div>
    <div className="rel"><h3>Then</h3><Chip concept={from} pending={from.status === 'pending'} tools={tools} /></div>
    <button className="danger remove" onClick={() => void remove(tools,
      liveClaims(tools).filter(claim => claim.kind === 'edge' && claim.concept_id === edge.from && claim.target_id === edge.to),
      `the link from “${to.label}” to “${from.label}”`)}>Remove this link</button>
  </div>
}

const liveBatches = (notebook: Notebook) => [...notebook.batches].reverse()

export function ReviewPanel({ tools }: { tools: Tools }) {
  const { notebook } = tools
  const groups = liveBatches(notebook).filter(batch => !batch.undone)
    .map(batch => ({ batch, claims: notebook.claims.filter(claim => claim.batch_id === batch.id && claim.status === 'pending') }))
    .filter(group => group.claims.length)
  if (!groups.length) {
    return <div className="detail"><h2>Review</h2><p className="none">Your review queue is empty. New suggestions appear here after you add material.</p></div>
  }
  return <div className="detail">
    <h2>Review</h2>
    <p className="lede">These came from the material you added. Each one shows the quote it rests on. Approve what belongs in your map.</p>
    {groups.map(({ batch, claims }) => <section key={batch.id} className="batch">
      <header>
        <div><strong>{batch.name}</strong>{batch.context && <small>“{batch.context}”</small>}</div>
        <button onClick={() => void tools.act(() => api.reviewBatch(notebook.id, batch.id, 'approved'))}>Approve all</button>
      </header>
      {(['stated', 'linked'] as const).map(kind => <div key={kind}>
        {claims.some(claim => (claim.evidence_kind ?? 'stated') === kind) &&
          <h3>{kind === 'linked' ? 'Across your notes' : 'From one passage'}</h3>}
      {claims.filter(claim => (claim.evidence_kind ?? 'stated') === kind).map(claim => <article key={claim.id} className="claim">
        <button className="claim-title" onClick={() => tools.select(claim.kind === 'concept'
          ? { kind: 'concept', id: claim.concept_id } : { kind: 'edge', id: `${claim.concept_id}->${claim.target_id}` })}>
          <span className="tag">{claim.merge ? 'More evidence' : claim.kind === 'edge' ? 'Link' : 'Concept'}</span>
          {claimText(claim)}
        </button>
        {claim.evidence_kind === 'linked' && claim.evidence
          ? <Quotes evidence={claim.evidence} tools={tools} />
          : <>{claim.quote && <blockquote>“{claim.quote}”</blockquote>}
            <small>{claim.source ? `${claim.source} · p. ${claim.page}` : 'Added by you'}</small></>}

        {!claim.ready && <small className="wait">Approve both concepts to enable this link.</small>}
        {claim.evidence_kind !== 'linked' && <div className="actions">
          <button disabled={!claim.ready} onClick={() => tools.decide(claim, 'approved')}>Approve</button>
          <button onClick={() => tools.decide(claim, 'rejected')}>Reject</button>
        </div>}
      </article>)}
      </div>)}
    </section>)}
  </div>
}

function BatchCard({ batch, tools }: { batch: Batch; tools: Tools }) {
  const { notebook } = tools
  const claims = notebook.claims.filter(claim => claim.batch_id === batch.id)
  const count = (status: Status) => claims.filter(claim => claim.status === status).length
  const date = new Date(batch.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return <section className={`batch${batch.undone ? ' undone' : ''}`}>
    <header>
      <div>
        <strong>{batch.name}</strong>
        <small>{date}{batch.context && ` · “${batch.context}”`}</small>
      </div>
      <button onClick={() => void tools.act(() => api.setBatchUndone(notebook.id, batch.id, !batch.undone))}>
        {batch.undone ? 'Restore' : 'Undo batch'}
      </button>
    </header>
    <small>
      {batch.undone ? 'Undone. Nothing from this batch is in your graph. '
        : `${count('approved')} in graph · ${count('pending')} to review · ${count('rejected')} rejected. `}
      {batch.dropped > 0 && `${batch.dropped} dropped: quote not found on the cited page. `}
      {batch.note}
    </small>
    {claims.length > 0 && <details>
      <summary>{claims.length} item{claims.length === 1 ? '' : 's'}</summary>
      <ul className="items">{claims.map(claim => <li key={claim.id}>
        <span className={`status ${claim.status}`}>{claim.status === 'approved' ? 'in graph' : claim.status}</span>
        <span className="grow">{claimText(claim)}</span>
        {!batch.undone && claim.status !== 'pending'
          && <button onClick={() => tools.decide(claim, 'pending')}>Undo</button>}
      </li>)}</ul>
    </details>}
  </section>
}

export function HistoryPanel({ tools }: { tools: Tools }) {
  return <div className="detail">
    <h2>Sources and history</h2>
    <p className="lede">Each thing you add is a batch. Undo a single decision or a whole batch. Nothing is deleted, so you can always restore it.</p>
    {liveBatches(tools.notebook).map(batch => <BatchCard key={batch.id} batch={batch} tools={tools} />)}
  </div>
}
