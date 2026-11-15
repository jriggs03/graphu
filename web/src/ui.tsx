/** Small pieces shared by the home screen and the notebook screen. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'
import type { AddResult } from './api'

const PATHS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm5 12 4.5 4.5',
  add: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 5v8m-4-4h8',
  sources: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5m-5 4h5',
  review: 'M4 6h16M4 12h10M4 18h7m5-2 2 2 4-5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0-6v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1',
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
  tidy: 'M4 7h6m4 0h6M4 17h6m4 0h6M12 4v6m0 4v6',
}

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return <svg className="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>
}

export type Toast = { text: string; action?: { label: string; run: () => void } }

export function ToastView({ toast, close }: { toast: Toast | null; close: () => void }) {
  useEffect(() => {
    if (!toast) return
    // Longer messages stay up longer.
    const timer = setTimeout(close, Math.max(8000, toast.text.length * 70))
    return () => clearTimeout(timer)
  }, [toast, close])
  if (!toast) return <div className="toast-slot" aria-live="polite" />
  return <div className="toast-slot" aria-live="polite">
    <div className="toast">
      <span>{toast.text}</span>
      {toast.action && <button onClick={() => { toast.action!.run(); close() }}>{toast.action.label}</button>}
      <button className="quiet" aria-label="Dismiss" onClick={close}>×</button>
    </div>
  </div>
}

/** One plain sentence per file about what happened to it. */
export function describe(results: AddResult[]) {
  return results.map(result => {
    if (result.error) return `“${result.name}” was not added. ${result.error}`
    if (result.duplicate) return `“${result.name}” is already in this graphbook, so it was not added again.`
    if (!result.extracted) return `“${result.name}” was saved, but not read. ${result.note}`
    const dropped = result.dropped ? ` ${result.dropped} dropped because the quote was not on the cited page.` : ''
    const note = result.note ? ` ${result.note}` : ''
    return `${result.count} suggestion${result.count === 1 ? '' : 's'} from “${result.name}” ready to review.${dropped}${note}`
  }).join(' ')
}

/** Drag files anywhere on the page. Returns true while a file is being dragged over it. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false)
  const handler = useRef(onFiles)
  handler.current = onFiles
  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files')
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault() }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length) handler.current(files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return dragging
}

/**
 * The context box: a note about the material being added ("week 6 slides"), a + button to
 * pick files, and the files chosen so far. It is not a "teach me X" prompt.
 */
export function ContextBox(props: {
  context: string; setContext: (value: string) => void
  files: File[]; setFiles: (files: File[]) => void
  busy: boolean; onSubmit: () => void; children?: ReactNode
}) {
  const picker = useRef<HTMLInputElement>(null)
  const { files, setFiles } = props
  return <form className="context-box" onSubmit={event => { event.preventDefault(); props.onSubmit() }}>
    <textarea rows={2} value={props.context} onChange={event => props.setContext(event.target.value)}
      aria-label="Context for the material you are adding"
      placeholder="What are you adding? For example “week 6 slides” or “voice memo from office hours”" />
    {files.length > 0 && <ul className="files">
      {files.map((file, index) => <li key={file.name + index}>
        {file.name}
        <button type="button" aria-label={`Remove ${file.name}`}
          onClick={() => setFiles(files.filter((_, at) => at !== index))}>×</button>
      </li>)}
    </ul>}
    <div className="context-row">
      <button type="button" className="plus" aria-label="Add files" onClick={() => picker.current?.click()}>+</button>
      <input ref={picker} type="file" multiple hidden onChange={event => {
        setFiles([...files, ...(event.target.files ?? [])])
        event.target.value = ''
      }} />
      <span className="grow">{files.length ? '' : 'Slides, PDFs, notes, photos of handwriting, voice memos'}</span>
      {props.children}
      <button className="primary" disabled={props.busy || !files.length}>{props.busy ? 'Reading…' : 'Add to graph'}</button>
    </div>
  </form>
}

export function Settings({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false)
  const [server, setServer] = useState(false)
  const [ai, setAi] = useState(false)
  useEffect(() => {
    void api.info().then(info => { setServer(info.mode === 'server'); setAi(info.ai_enabled) })
  }, [])
  return <div className="settings">
    <button className="rail-button" aria-label="Settings" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="settings" /><span className="rail-label">Settings</span>
    </button>
    {open && <div className="popover" role="dialog" aria-label="Settings">
      {server ? <>
        <h3>Connected to the Graphu server</h3>
        <p>Your graphbooks are saved on the server. {ai
          ? 'Files you add are read with Claude. Every suggestion is checked against the page it cites, then waits for your review.'
          : 'No AI key is set on the server, so files you add are recorded but not read. The sample graphbooks still work.'}</p>
      </> : <>
        <h3>Sample mode</h3>
        <p>Graphu is running entirely in your browser on built-in sample notes. No server is connected, so files you add are recorded but not read.</p>
        <button onClick={() => {
          if (!confirm('Reset every graphbook in this browser back to the original sample?')) return
          void api.resetSample().then(() => { setOpen(false); onReset() })
        }}>Reset sample data</button>
      </>}
      <button className="quiet" onClick={() => setOpen(false)}>Close</button>
    </div>}
  </div>
}
