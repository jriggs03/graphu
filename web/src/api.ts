/**
 * The single door between the UI and the backend.
 *
 * Every screen imports from here and nowhere else. Today the calls are answered by an
 * in-browser sample backend (`sample/store.ts`) so the app runs with no server and no API key.
 * When the Rust server lands, swap the `backend` object below for one that calls `fetch`
 * (or Tauri `invoke`) and returns the same shapes. Nothing else in the UI has to change.
 */
import { sampleBackend } from './sample/store'

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
}

/** `from` relies on `to`: `from` is the dependent, `to` is the prerequisite. */
export type Edge = {
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
  /** False when no AI server was available, so nothing was read from the file. */
  extracted: boolean
}

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
  getNotebook(id: string): Promise<Notebook>
  addMaterial(id: string, files: File[], context: string): Promise<{ notebook: Notebook; results: AddResult[] }>
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
  resetSample(): Promise<void>
}

const backend: Backend = sampleBackend

export const api = backend
