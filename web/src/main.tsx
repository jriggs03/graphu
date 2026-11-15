import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Home } from './Home'
import { NotebookScreen } from './Notebook'
import { ToastView } from './ui'
import type { Toast } from './ui'
import { applySettings } from './settings'
import { setName, useUser } from './identity'
import './style.css'

applySettings()

/** Hash routes keep the app a single static page: `#/` is home, `#/n/<id>` is a notebook. */
function useRoute() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const change = () => setHash(location.hash)
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  return hash
}

/** First visit: ask for a name. It is remembered in this browser from then on. */
function Welcome() {
  const [name, setValue] = useState('')
  return <main className="welcome">
    <h1 className="wordmark"><img src="/icon-192.png" alt="" />Graphu</h1>
    <form onSubmit={event => { event.preventDefault(); if (name.trim()) setName(name) }}>
      <label htmlFor="name">What should we call you?</label>
      <input id="name" autoFocus value={name} maxLength={60} autoComplete="given-name"
        onChange={event => setValue(event.target.value)} placeholder="Your name" />
      <button className="primary" disabled={!name.trim()}>Start</button>
    </form>
    <p className="hint">Your graphbooks are private to this browser. Nobody else sees them, and there is no password to remember.</p>
  </main>
}

function App() {
  const user = useUser()
  return user ? <Signed key={user.id} /> : <Welcome />
}

function Signed() {
  const hash = useRoute()
  const [toast, setToast] = useState<Toast | null>(null)
  const close = useCallback(() => setToast(null), [])
  const notebook = hash.match(/^#\/n\/(.+)$/)?.[1]
  return <>
    {notebook
      ? <NotebookScreen key={notebook} id={decodeURIComponent(notebook)} notify={setToast} />
      : <Home notify={setToast} />}
    <ToastView toast={toast} close={close} />
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => console.warn('PWA registration failed', error))
}
