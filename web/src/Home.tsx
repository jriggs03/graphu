import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { NotebookSummary } from './api'
import { ContextBox, Settings, describe, useFileDrop } from './ui'
import type { Toast } from './ui'
import { useUser } from './identity'

export function Home({ notify }: { notify: (toast: Toast) => void }) {
  const user = useUser()
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([])
  const [tab, setTab] = useState<'all' | 'review'>('all')
  const [context, setContext] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [destination, setDestination] = useState('new')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [managing, setManaging] = useState<string | null>(null)

  /** Run a change to the list, then reload it. Errors are shown, not thrown. */
  const manage = (run: () => Promise<unknown>) => {
    setManaging(null)
    run().then(refresh, error => notify({ text: error instanceof Error ? error.message : 'Something went wrong.' }))
  }
  const rename = (notebook: NotebookSummary) => {
    const title = prompt('New name for this graphbook', notebook.title)
    if (title?.trim()) manage(() => api.renameNotebook(notebook.id, title))
  }
  const remove = (notebook: NotebookSummary) => {
    if (!confirm(`Delete “${notebook.title}” and everything in it? This cannot be undone.`)) return
    manage(async () => {
      await api.deleteNotebook(notebook.id)
      localStorage.removeItem(`graphu.positions.${notebook.id}`)
      if (destination === notebook.id) setDestination('new')
      notify({ text: `Deleted “${notebook.title}”.` })
    })
  }

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
          <button className="more" aria-label={`Rename or delete ${notebook.title}`} aria-expanded={managing === notebook.id}
            onClick={() => setManaging(managing === notebook.id ? null : notebook.id)}>⋯</button>
          {managing === notebook.id && <div className="row-actions">
            <button onClick={() => rename(notebook)}>Rename</button>
            {notebook.id.startsWith('sample-')
              ? <small>Built-in sample</small>
              : <button className="danger" onClick={() => remove(notebook)}>Delete</button>}
          </div>}
        </li>)}
        {!shown.length && <li className="empty">{tab === 'all' ? 'No graphbooks yet.' : 'Nothing is waiting for review.'}</li>}
      </ul>
      <Settings onReset={refresh} />
    </aside>
    <main className="hero">
      <p className="greeting">Hi, {user?.name}</p>
      <h1 className="wordmark"><img src="/icon-192.png" alt="" />Graphu</h1>
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
