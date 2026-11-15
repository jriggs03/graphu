import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { NotebookSummary } from './api'
import { ContextBox, Settings, describe, useFileDrop } from './ui'
import type { Toast } from './ui'

export function Home({ notify }: { notify: (toast: Toast) => void }) {
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([])
  const [tab, setTab] = useState<'all' | 'review'>('all')
  const [context, setContext] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [destination, setDestination] = useState('new')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    api.listNotebooks().then(setNotebooks).catch(error => notify({ text: error.message }))
  }, [notify])
  useEffect(refresh, [refresh])

  const dragging = useFileDrop(dropped => setFiles(prior => [...prior, ...dropped]))

  async function submit() {
    setBusy(true)
    try {
      const title = name.trim() || context.trim() || files[0].name.replace(/\.[^.]+$/, '')
      const id = destination === 'new' ? (await api.createNotebook(title)).id : destination
      const { results } = await api.addMaterial(id, files, context)
      notify({ text: describe(results) })
      location.hash = `#/n/${id}`
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : 'Something went wrong.' })
      setBusy(false)
    }
  }

  const shown = notebooks.filter(notebook => tab === 'all' || notebook.pending > 0)

  return <div className="home">
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')}>Graphbooks</button>
        <button role="tab" aria-selected={tab === 'review'} onClick={() => setTab('review')}>To review</button>
      </div>
      <ul className="notebooks">
        {shown.map(notebook => <li key={notebook.id}>
          <a href={`#/n/${notebook.id}`}>
            <strong>{notebook.title}</strong>
            <small>
              {notebook.concepts} concept{notebook.concepts === 1 ? '' : 's'}
              {notebook.pending > 0 && <span className="count">{notebook.pending} to review</span>}
            </small>
          </a>
        </li>)}
        {!shown.length && <li className="empty">{tab === 'all' ? 'No graphbooks yet.' : 'Nothing is waiting for review.'}</li>}
      </ul>
      <Settings onReset={refresh} />
    </aside>
    <main className="hero">
      <h1 className="wordmark">Graphu</h1>
      <p className="tagline">Your slides, notes and voice memos become a concept map. Every concept points back to the page it came from, and nothing joins the map until you approve it.</p>
      {destination === 'new' && <input className="name-box" value={name} maxLength={80}
        onChange={event => setName(event.target.value)} aria-label="Name of the new graphbook"
        placeholder="Name this graphbook, for example “CSC 4800 Machine Learning”" />}
      <ContextBox context={context} setContext={setContext} files={files} setFiles={setFiles} busy={busy} onSubmit={() => void submit()}>
        <select aria-label="Add to" value={destination} onChange={event => setDestination(event.target.value)}>
          <option value="new">New graphbook</option>
          {notebooks.map(notebook => <option key={notebook.id} value={notebook.id}>{notebook.title}</option>)}
        </select>
      </ContextBox>
      <p className="hint">
        Drop files anywhere on this page.
        {notebooks[0] && <> No files handy? <a href="#/n/sample-calculus">Open the calculus sample</a>.</>}
      </p>
    </main>
    {dragging && <div className="drop-overlay"><div>Drop to add to the context box</div></div>}
  </div>
}
