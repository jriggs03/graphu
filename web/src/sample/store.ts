/**
 * In-browser stand-in for the Graphu server. It keeps notebooks in localStorage and follows
 * the same rules the real backend must follow (see CLAUDE.md, "Behaviors that must hold"):
 * grounding, review before graph, batches with undo, duplicate blocking by content hash,
 * and never re-proposing a rejected claim.
 *
 * It cannot read uploaded files: there is no AI here. Uploads are recorded as a batch with
 * nothing extracted, and the UI says so.
 */
import { ApiError } from '../api'
import type {
  AddResult, Backend, Batch, Claim, Concept, Edge, Evidence, Notebook, NotebookSummary, Source, Status,
} from '../api'
import { SAMPLE_NOTEBOOKS } from './data'
import type { Candidate, SampleDoc } from './data'

type ClaimRec = {
  id: number; batch_id: string; source_id: string | null
  title: string; target: string; relation: string; symbol: string
  page: number; quote: string; status: Status
}
type NotebookRec = {
  id: string; title: string; updated_at: string
  sources: Source[]; batches: Batch[]; claims: ClaimRec[]
  comments: Record<string, string>; target: string | null
  /** Symbols the student chose, by concept id. */
  symbols?: Record<string, string>
}
type Db = { version: number; seq: number; notebooks: NotebookRec[] }

const STORAGE_KEY = 'graphu.sample'
const VERSION = 1

/* ---------- grounding: a port of `grounded_items` in backend/extraction.py ---------- */

export const normalize = (value: string) => value.split(/\s+/).filter(Boolean).join(' ')
export const keyOf = (value: string) => normalize(value).toLowerCase()

export function groundedItems(items: Candidate[], pages: string[]): Candidate[] {
  const text = pages.map(normalize)
  const kept: Candidate[] = []
  for (const raw of items) {
    const item = {
      ...raw, title: normalize(raw.title), target: normalize(raw.target),
      relation: normalize(raw.relation), quote: normalize(raw.quote),
    }
    if (!(item.page >= 1 && item.page <= text.length) || item.quote.length < 12 || item.quote.length > 800) continue
    if (!text[item.page - 1].includes(item.quote)) continue
    if (item.title.length < 1 || item.title.length > 80 || item.target.length > 80 || item.relation.length > 60) continue
    if (Boolean(item.target) !== Boolean(item.relation) || keyOf(item.title) === keyOf(item.target)) continue
    kept.push(item)
  }
  return kept
}

/* ---------- storage ---------- */

let db: Db | undefined

function load(): Db {
  if (db) return db
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Db | null
    if (saved && saved.version === VERSION) return (db = saved)
  } catch { /* fall through to a fresh sample */ }
  db = seed()
  save()
  return db
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)) } catch { /* storage may be unavailable */ }
}

function find(id: string): NotebookRec {
  const notebook = load().notebooks.find(item => item.id === id)
  if (!notebook) throw new ApiError(404, 'Notebook not found.')
  return notebook
}

function touch(notebook: NotebookRec) {
  notebook.updated_at = new Date().toISOString()
  save()
}

/* ---------- writing claims ---------- */

function newBatch(store: Db, notebook: NotebookRec, fields: Pick<Batch, 'kind' | 'name' | 'context'> & Partial<Batch>): Batch {
  const batch: Batch = {
    id: `b${++store.seq}`, created_at: new Date().toISOString(), undone: false, dropped: 0, note: '', ...fields,
  }
  notebook.batches.push(batch)
  return batch
}

/** Ground the proposals, skip anything already rejected or already present, store the rest. */
function addItems(store: Db, notebook: NotebookRec, batch: Batch, sourceId: string, items: Candidate[], pages: string[]) {
  const grounded = groundedItems(items, pages)
  batch.dropped = items.length - grounded.length
  let count = 0
  for (const item of grounded) {
    const keys = [keyOf(item.title), keyOf(item.target), keyOf(item.relation)]
    const same = (claim: ClaimRec) =>
      keyOf(claim.title) === keys[0] && keyOf(claim.target) === keys[1] && keyOf(claim.relation) === keys[2]
    if (notebook.claims.some(claim => claim.status === 'rejected' && same(claim))) continue
    if (notebook.claims.some(claim => claim.source_id === sourceId && same(claim)
      && claim.page === item.page && claim.quote === item.quote)) continue
    notebook.claims.push({
      id: ++store.seq, batch_id: batch.id, source_id: sourceId, title: item.title, target: item.target,
      relation: item.relation, symbol: item.symbol ?? '', page: item.page, quote: item.quote, status: 'pending',
    })
    count += 1
  }
  return count
}

function addDoc(store: Db, notebook: NotebookRec, doc: SampleDoc, createdAt?: string): AddResult {
  const batch = newBatch(store, notebook, { kind: 'sample', name: doc.name, context: doc.context })
  if (createdAt) batch.created_at = createdAt
  notebook.sources.push({ id: doc.id, name: doc.name, batch_id: batch.id, pages: doc.pages.map(normalize) })
  const count = addItems(store, notebook, batch, doc.id, doc.items, doc.pages)
  return { name: doc.name, batch_id: batch.id, duplicate: false, count, dropped: batch.dropped, extracted: true, note: '' }
}

function seed(): Db {
  const store: Db = { version: VERSION, seq: 0, notebooks: [] }
  for (const sample of SAMPLE_NOTEBOOKS) {
    const notebook: NotebookRec = {
      id: sample.id, title: sample.title, updated_at: '', sources: [], batches: [], claims: [],
      comments: {}, target: sample.target,
    }
    for (const doc of sample.docs) {
      const { batch_id } = addDoc(store, notebook, doc, doc.created_at)
      if (doc.status === 'approved') {
        for (const claim of notebook.claims) if (claim.batch_id === batch_id) claim.status = 'approved'
      }
    }
    if (sample.manual.concepts.length) {
      const batch = newBatch(store, notebook, { kind: 'manual', name: 'Added by you', context: '' })
      batch.created_at = sample.manual.created_at
      const manual = (title: string, target: string, symbol: string) => notebook.claims.push({
        id: ++store.seq, batch_id: batch.id, source_id: null, title, target,
        relation: target ? 'relies on' : '', symbol, page: 0, quote: '', status: 'approved',
      })
      for (const item of sample.manual.concepts) {
        manual(item.title, '', item.symbol)
        notebook.comments[keyOf(item.title)] = item.comment
      }
      for (const [from, to] of sample.manual.links) manual(from, to, '')
    }
    notebook.batches.sort((a, b) => a.created_at.localeCompare(b.created_at))
    notebook.updated_at = notebook.batches[notebook.batches.length - 1].created_at
    store.notebooks.push(notebook)
  }
  return store
}

/* ---------- reading: turn stored claims into the graph the UI draws ---------- */

function view(notebook: NotebookRec): Notebook {
  const undone = new Set(notebook.batches.filter(batch => batch.undone).map(batch => batch.id))
  const sourceName = (id: string | null) => notebook.sources.find(source => source.id === id)?.name ?? ''
  const live = notebook.claims.filter(claim => !undone.has(claim.batch_id) && claim.status !== 'rejected')
  const evidenceOf = (claim: ClaimRec): Evidence => ({
    claim_id: claim.id, batch_id: claim.batch_id, source_id: claim.source_id!, source: sourceName(claim.source_id),
    page: claim.page, quote: claim.quote, status: claim.status,
  })
  const unsourced = (status: string, evidence: Evidence[]) =>
    !evidence.some(item => status === 'pending' || item.status === 'approved')

  const concepts = new Map<string, Concept>()
  for (const claim of live) {
    if (claim.target) continue
    const id = keyOf(claim.title)
    let concept = concepts.get(id)
    if (!concept) {
      concept = {
        id, label: claim.title, symbol: claim.symbol, status: 'pending', user_added: false,
        evidence: [], comment: notebook.comments[id] ?? '', visual: null,
      }
      concepts.set(id, concept)
    }
    if (claim.status === 'approved' && concept.status === 'pending') {
      concept.status = 'approved'
      concept.label = claim.title
    }
    if (!concept.symbol) concept.symbol = claim.symbol
    if (claim.source_id) concept.evidence.push(evidenceOf(claim))
  }
  for (const concept of concepts.values()) {
    concept.user_added = unsourced(concept.status, concept.evidence)
    const chosen = notebook.symbols?.[concept.id]
    if (chosen) concept.symbol = chosen
  }
  const approved = (id: string) => concepts.get(id)?.status === 'approved'

  const edges = new Map<string, Edge & { anyApproved: boolean }>()
  for (const claim of live) {
    if (!claim.target) continue
    const from = keyOf(claim.title)
    const to = keyOf(claim.target)
    if (!concepts.has(from) || !concepts.has(to)) continue
    const id = `${from}->${to}`
    let edge = edges.get(id)
    if (!edge) {
      edge = { id, from, to, relation: claim.relation, status: 'pending', user_added: false, evidence: [], anyApproved: false }
      edges.set(id, edge)
    }
    if (claim.status === 'approved' && !edge.anyApproved) {
      edge.anyApproved = true
      edge.relation = claim.relation
    }
    if (claim.source_id) edge.evidence.push(evidenceOf(claim))
  }
  const edgeList = [...edges.values()].map(({ anyApproved, ...edge }) => {
    const status = anyApproved && approved(edge.from) && approved(edge.to) ? 'approved' as const : 'pending' as const
    return { ...edge, status, user_added: unsourced(anyApproved ? 'approved' : 'pending', edge.evidence) }
  })

  const claims: Claim[] = notebook.claims.map(claim => {
    const concept_id = keyOf(claim.title)
    const target_id = keyOf(claim.target)
    const kind = claim.target ? 'edge' as const : 'concept' as const
    return {
      id: claim.id, batch_id: claim.batch_id, kind, title: claim.title, target: claim.target,
      relation: claim.relation, concept_id, target_id, quote: claim.quote, page: claim.page,
      source: sourceName(claim.source_id), status: claim.status,
      ready: kind === 'concept' || (approved(concept_id) && approved(target_id)),
      merge: claim.status === 'pending' && (kind === 'concept' ? approved(concept_id)
        : edges.get(`${concept_id}->${target_id}`)?.anyApproved === true),
    }
  })

  return {
    id: notebook.id, title: notebook.title, concepts: [...concepts.values()], edges: edgeList, claims,
    batches: notebook.batches, sources: notebook.sources.filter(source => !undone.has(source.batch_id)),
    target: notebook.target && approved(notebook.target) ? notebook.target : null,
  }
}

function summary(notebook: NotebookRec): NotebookSummary {
  const shown = view(notebook)
  const undone = new Set(shown.batches.filter(batch => batch.undone).map(batch => batch.id))
  return {
    id: notebook.id, title: notebook.title, updated_at: notebook.updated_at,
    concepts: shown.concepts.filter(concept => concept.status === 'approved').length,
    pending: shown.claims.filter(claim => claim.status === 'pending' && !undone.has(claim.batch_id)).length,
  }
}

/* ---------- review ---------- */

function setStatus(notebook: NotebookRec, claimId: number, status: Status) {
  const claim = notebook.claims.find(item => item.id === claimId)
  if (!claim) throw new ApiError(404, 'Proposal not found.')
  if (notebook.batches.find(batch => batch.id === claim.batch_id)?.undone) {
    throw new ApiError(409, 'This batch was undone. Restore it before reviewing its items.')
  }
  if (claim.status === status) return
  const shown = view(notebook).claims.find(item => item.id === claimId)!
  if (status === 'approved' && !shown.ready) {
    throw new ApiError(409, 'Approve both concepts before approving this link.')
  }
  const same = (other: ClaimRec) => keyOf(other.title) === keyOf(claim.title)
    && keyOf(other.target) === keyOf(claim.target) && keyOf(other.relation) === keyOf(claim.relation)
  if (status === 'rejected' && !notebook.claims.some(other => other.status === 'approved' && same(other))) {
    // Rejecting an idea rejects every pending copy of it, so it is not asked again.
    for (const other of notebook.claims) if (other.status === 'pending' && same(other)) other.status = 'rejected'
  }
  claim.status = status
}

function manualBatch(store: Db, notebook: NotebookRec) {
  return notebook.batches.find(batch => batch.kind === 'manual' && !batch.undone)
    ?? newBatch(store, notebook, { kind: 'manual', name: 'Added by you', context: '' })
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const duplicate = (name: string): AddResult =>
  ({ name, batch_id: null, duplicate: true, count: 0, dropped: 0, extracted: false, note: '' })

/* ---------- the Backend the UI talks to ---------- */

export const sampleBackend: Backend = {
  async info() {
    return { mode: 'sample', ai_enabled: false }
  },

  async listNotebooks() {
    return load().notebooks.map(summary).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  },

  async createNotebook(title) {
    const store = load()
    const notebook: NotebookRec = {
      id: `n${++store.seq}`, title: normalize(title).slice(0, 80) || 'Untitled graphbook', updated_at: '',
      sources: [], batches: [], claims: [], comments: {}, target: null,
    }
    store.notebooks.push(notebook)
    touch(notebook)
    return summary(notebook)
  },

  async renameNotebook(id, title) {
    const notebook = find(id)
    const name = normalize(title).slice(0, 80)
    if (!name) throw new ApiError(422, 'Give the graphbook a name.')
    notebook.title = name
    touch(notebook)
    return summary(notebook)
  },

  async deleteNotebook(id) {
    if (SAMPLE_NOTEBOOKS.some(sample => sample.id === id)) throw new ApiError(409, 'The built-in samples cannot be deleted.')
    const store = load()
    find(id)
    store.notebooks = store.notebooks.filter(notebook => notebook.id !== id)
    save()
  },

  async getNotebook(id) {
    return view(find(id))
  },

  async addMaterial(id, files, context) {
    const store = load()
    const notebook = find(id)
    const results: AddResult[] = []
    for (const file of files) {
      const name = file.name.replace(/\\/g, '/').split('/').pop()!.trim().slice(0, 180) || 'Document'
      const hash = await sha256(file)
      if (notebook.sources.some(source => source.id === hash)) {
        results.push(duplicate(name))
        continue
      }
      const note = 'This copy of Graphu runs in your browser with no server, so nothing was read from this file.'
      const batch = newBatch(store, notebook, { kind: 'upload', name, context: normalize(context).slice(0, 300), note })
      notebook.sources.push({ id: hash, name, batch_id: batch.id, pages: [] })
      results.push({ name, batch_id: batch.id, duplicate: false, count: 0, dropped: 0, extracted: false, note })
    }
    touch(notebook)
    return { notebook: view(notebook), results }
  },

  async listSamplePacks(id) {
    const notebook = find(id)
    const sample = SAMPLE_NOTEBOOKS.find(item => item.id === id)
    return (sample?.packs ?? [])
      .filter(pack => !notebook.sources.some(source => source.id === pack.id))
      .map(pack => ({ id: pack.id, name: pack.name, context: pack.context }))
  },

  async addSamplePack(id, packId) {
    const store = load()
    const notebook = find(id)
    const pack = SAMPLE_NOTEBOOKS.find(item => item.id === id)?.packs.find(item => item.id === packId)
    if (!pack) throw new ApiError(404, 'Sample material not found.')
    const result = notebook.sources.some(source => source.id === pack.id)
      ? duplicate(pack.name) : addDoc(store, notebook, pack)
    touch(notebook)
    return { notebook: view(notebook), results: [result] }
  },

  async reviewClaim(id, claimId, status) {
    const notebook = find(id)
    setStatus(notebook, claimId, status)
    touch(notebook)
    return view(notebook)
  },

  async reviewBatch(id, batchId, status) {
    const notebook = find(id)
    const pending = () => notebook.claims.filter(claim => claim.batch_id === batchId && claim.status === 'pending')
    // Concepts first, so that links between them become approvable.
    for (const claim of pending().filter(item => !item.target)) setStatus(notebook, claim.id, status)
    for (const claim of pending()) {
      if (status === 'rejected' || view(notebook).claims.find(item => item.id === claim.id)!.ready) {
        setStatus(notebook, claim.id, status)
      }
    }
    touch(notebook)
    return view(notebook)
  },

  async setBatchUndone(id, batchId, undone) {
    const notebook = find(id)
    const batch = notebook.batches.find(item => item.id === batchId)
    if (!batch) throw new ApiError(404, 'Batch not found.')
    batch.undone = undone
    touch(notebook)
    return view(notebook)
  },

  async addConcept(id, label) {
    const store = load()
    const notebook = find(id)
    const title = normalize(label)
    if (!title || title.length > 80) throw new ApiError(422, 'Give the concept a name of up to 80 characters.')
    if (view(notebook).concepts.some(concept => concept.id === keyOf(title))) {
      throw new ApiError(409, `“${title}” is already in this notebook.`)
    }
    notebook.claims.push({
      id: ++store.seq, batch_id: manualBatch(store, notebook).id, source_id: null, title, target: '',
      relation: '', symbol: '', page: 0, quote: '', status: 'approved',
    })
    touch(notebook)
    return view(notebook)
  },

  async addEdge(id, from, to) {
    const store = load()
    const notebook = find(id)
    const shown = view(notebook)
    const [a, b] = [from, to].map(key => shown.concepts.find(concept => concept.id === key && concept.status === 'approved'))
    if (!a || !b || a.id === b.id) throw new ApiError(422, 'Pick two different concepts that are in the graph.')
    if (shown.edges.some(edge => edge.from === a.id && edge.to === b.id)) {
      throw new ApiError(409, 'That link already exists.')
    }
    notebook.claims.push({
      id: ++store.seq, batch_id: manualBatch(store, notebook).id, source_id: null, title: a.label, target: b.label,
      relation: 'relies on', symbol: '', page: 0, quote: '', status: 'approved',
    })
    touch(notebook)
    return view(notebook)
  },

  async setComment(id, concept, text) {
    const notebook = find(id)
    const value = text.trim().slice(0, 2000)
    if (value) notebook.comments[concept] = value
    else delete notebook.comments[concept]
    touch(notebook)
    return view(notebook)
  },

  async setTarget(id, concept) {
    const notebook = find(id)
    notebook.target = concept
    touch(notebook)
    return view(notebook)
  },

  async setSymbol(id, concept, symbol) {
    const notebook = find(id)
    const value = normalize(symbol)
    if (value.length > 12) throw new ApiError(422, 'Keep the symbol to 12 characters or fewer.')
    notebook.symbols = { ...notebook.symbols }
    if (value) notebook.symbols[concept] = value
    else delete notebook.symbols[concept]
    touch(notebook)
    return view(notebook)
  },

  async drawVisual() {
    throw new ApiError(422, 'Pictures are drawn by AI, which needs the Graphu server. This copy runs in your browser only.')
  },

  async resetSample() {
    db = seed()
    save()
  },
}
