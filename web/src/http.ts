/** The real backend: each call is one HTTP request to the Graphu server (crates/graphu-server). */
import { ApiError } from './api'
import type { AddResult, Backend, Notebook } from './api'

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail
      : response.status === 413 ? 'That file is too large. Choose one under 8 MB.' : 'The request failed.'
    throw new ApiError(response.status, detail)
  }
  return data as T
}

const at = (id: string) => `/notebooks/${encodeURIComponent(id)}`
type Added = { notebook: Notebook; results: AddResult[] }

export const httpBackend: Backend = {
  info: () => request('GET', '/info'),
  listNotebooks: () => request('GET', '/notebooks'),
  createNotebook: title => request('POST', '/notebooks', { title }),
  renameNotebook: (id, title) => request('PATCH', at(id), { title }),
  deleteNotebook: async id => { await request('DELETE', at(id)) },
  getNotebook: id => request('GET', at(id)),

  async addMaterial(id, files, context) {
    // One request per file: the body is the file itself, and the server hashes it.
    const results: AddResult[] = []
    let notebook: Notebook | undefined
    for (const file of files) {
      const query = new URLSearchParams({ name: file.name, context })
      try {
        const added = await request<Added>('POST', `${at(id)}/documents?${query}`, undefined, file)
        results.push(...added.results)
        notebook = added.notebook
      } catch (error) {
        // One bad file does not stop the others. Report why it was refused.
        const reason = error instanceof Error ? error.message : 'The upload failed.'
        results.push({ name: file.name, batch_id: null, duplicate: false, count: 0, dropped: 0, extracted: false, note: '', error: reason })
      }
    }
    return { notebook: notebook ?? await this.getNotebook(id), results }
  },

  listSamplePacks: id => request('GET', `${at(id)}/sample-packs`),
  addSamplePack: (id, pack) => request('POST', `${at(id)}/sample-packs/${encodeURIComponent(pack)}`),
  reviewClaim: (id, claim, status) => request('PATCH', `${at(id)}/claims/${claim}`, { status }),
  reviewBatch: (id, batch, status) => request('POST', `${at(id)}/batches/${batch}/review`, { status }),
  setBatchUndone: (id, batch, undone) => request('PATCH', `${at(id)}/batches/${batch}`, { undone }),
  addConcept: (id, label) => request('POST', `${at(id)}/concepts`, { label }),
  addEdge: (id, from, to) => request('POST', `${at(id)}/edges`, { from, to }),
  setComment: (id, concept, text) => request('PUT', `${at(id)}/comment`, { concept, text }),
  setTarget: (id, concept) => request('PUT', `${at(id)}/target`, { concept }),
  drawVisual: (id, concept) => request('POST', `${at(id)}/visual`, { concept }),

  async resetSample() {
    throw new ApiError(405, 'This workspace is stored on the server, so it cannot be reset from here.')
  },
}
