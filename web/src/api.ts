/**
 * The single door between the UI and the backend.
 *
 * Every screen imports `api` from here and nowhere else. Behind it sits one of two backends
 * with the same shape:
 *
 *   - `http.ts`          the Graphu server. Used when `/api/info` answers.
 *   - `sample/store.ts`  an in-browser stand-in. Used when there is no server, so a static
 *                        copy of the site still works with the built-in sample.
 *
 * A Tauri desktop shell can add a third that calls `invoke`. Nothing else in the UI changes.
 */
import { httpBackend } from './http'
import { sampleBackend } from './sample/store'
import { stressNotebook } from './graph/stress'

export type Status = 'pending' | 'approved' | 'rejected'

/** One quote on one page of one document. */
export type Evidence = {
  claim_id: number
  batch_id: string
  source_id: string
  source: string
  page: number
  quote: string
  status: Status
}

export type Concept = {
  id: string
  label: string
  /** Short notation shown inside the node, e.g. "∫". May be empty. */
  symbol: string
  /** `pending` concepts are shown as dashed previews and are not part of the graph yet. */
  status: 'pending' | 'approved'
  /** True when no approved source quote backs this concept: the "Not in slide !" marker. */
  user_added: boolean
  evidence: Evidence[]
  comment: string
  /** A small AI-drawn picture. An illustration, not source evidence. */
  visual: { svg: string; caption: string } | null
  /** One plain sentence written by the AI. Shown with an "AI summary" tag. May be empty. */
  heading: string
  /** A formula or line of code that was found on the cited page. */
  snippet: { text: string; page: number; source: string } | null
  /** The topic this concept sits inside: the id of another concept or of a `Topic`. `null` is the top level. */
  parent: string | null
}

/** A named group of concepts that is not itself a concept from the material (a section of a deck). */
export type Topic = { id: string; label: string; parent: string | null; status: 'pending' | 'approved' }

/** `from` relies on `to`: `from` is the dependent, `to` is the prerequisite. */
export type Edge = {
  evidence_kind?: 'stated' | 'linked'
  id: string
  from: string
  to: string
  relation: string
  status: 'pending' | 'approved'
  user_added: boolean
  evidence: Evidence[]
}

/** One AI proposal (or one thing the student added). The unit of review and undo. */
export type Claim = {
  evidence_kind?: 'stated' | 'linked'
  evidence?: Evidence[]
  id: number
  batch_id: string
  kind: 'concept' | 'edge'
  title: string
  target: string
  relation: string
  concept_id: string
  target_id: string
  quote: string
  page: number
  source: string
  status: Status
  /** An edge can only be approved once both of its concepts are approved. */
  ready: boolean
  /** True when this adds evidence to something already in the graph. */
  merge: boolean
}

/** One upload (or the student's own additions). Undo works on a whole batch. */
export type Batch = {
  id: string
  kind: 'upload' | 'sample' | 'manual'
  name: string
  context: string
  created_at: string
  undone: boolean
  /** Proposals dropped because their quote was not found on the cited page. */
  dropped: number
  note: string
}

export type Source = { id: string; name: string; batch_id: string; pages: string[] }

export type Notebook = {
  id: string
  title: string
  concepts: Concept[]
  /** Groups that hold concepts. A concept is also a topic when other concepts name it as their parent. */
  topics: Topic[]
  edges: Edge[]
  claims: Claim[]
  batches: Batch[]
  sources: Source[]
  /** The concept the student said they want to learn, if any. */
  target: string | null
}

export type NotebookSummary = {
  id: string
  title: string
  concepts: number
  pending: number
  updated_at: string
}

export type AddResult = {
  name: string
  batch_id: string | null
  duplicate: boolean
  count: number
  dropped: number
  /** False when nothing was proposed from the file. `note` says why. */
  extracted: boolean
  /** Why nothing was read, or how the text was obtained (for example, an AI transcription). */
  note: string
  /** Set when the file was refused (unreadable, too large, AI failure). Nothing was stored. */
  error?: string
}

/** How far along the file being built is: "week4.pdf, step 2 of 4, Finding concepts and links". */
export type BuildProgress = { name: string; step: number; of: number; label: string }

export type SamplePack = { id: string; name: string; context: string }
export type Info = { mode: 'sample' | 'server'; ai_enabled: boolean }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface Backend {
  info(): Promise<Info>
  listNotebooks(): Promise<NotebookSummary[]>
  createNotebook(title: string): Promise<NotebookSummary>
  renameNotebook(id: string, title: string): Promise<NotebookSummary>
  /** Permanent. The built-in samples cannot be deleted. */
  deleteNotebook(id: string): Promise<void>
  getNotebook(id: string): Promise<Notebook>
  addMaterial(id: string, files: File[], context: string): Promise<{ notebook: Notebook; results: AddResult[] }>
  /** What is being built in this graphbook right now. `null` when nothing is. */
  buildProgress(id: string): Promise<BuildProgress | null>
  listSamplePacks(id: string): Promise<SamplePack[]>
  addSamplePack(id: string, pack: string): Promise<{ notebook: Notebook; results: AddResult[] }>
  /** `pending` is the per-item undo: it puts a reviewed claim back in the queue. */
  reviewClaim(id: string, claim: number, status: Status): Promise<Notebook>
  reviewBatch(id: string, batch: string, status: 'approved' | 'rejected'): Promise<Notebook>
  /** Per-batch undo and restore. An undone batch is kept, never deleted. */
  setBatchUndone(id: string, batch: string, undone: boolean): Promise<Notebook>
  addConcept(id: string, label: string): Promise<Notebook>
  addEdge(id: string, from: string, to: string): Promise<Notebook>
  setComment(id: string, concept: string, text: string): Promise<Notebook>
  setTarget(id: string, concept: string | null): Promise<Notebook>
  /** Choose the short symbol drawn in a concept's node. Empty goes back to the proposed one. */
  setSymbol(id: string, concept: string, symbol: string): Promise<Notebook>
  /** Move a concept or a topic into another topic. `null` moves it to the top level. */
  setParent(id: string, concept: string, parent: string | null): Promise<Notebook>
  resetSample(): Promise<void>
}

let chosen: Promise<Backend> | undefined

/** Ask once whether a Graphu server is there. If not, fall back to the in-browser sample. */
function backend(): Promise<Backend> {
  chosen ??= fetch('/api/info')
    .then(response => response.ok && (response.headers.get('content-type') ?? '').includes('json'))
    .then(found => (found ? httpBackend : sampleBackend), () => sampleBackend)
  return chosen
}

export const api = new Proxy({} as Backend, {
  get: (_, name: keyof Backend) => (...args: unknown[]) => {
    // `#/n/stress-800` opens a made-up graphbook for checking speed. It never reaches a backend.
    const made = name === 'getNotebook' ? stressNotebook(String(args[0])) : null
    if (made) return Promise.resolve(made)
    return backend().then(found => (found[name] as (...values: unknown[]) => unknown)(...args))
  },
})
