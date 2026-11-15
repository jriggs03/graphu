import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Home } from './Home'
import { NotebookScreen } from './Notebook'
import { ToastView } from './ui'
import type { Toast } from './ui'
import './style.css'

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

function App() {
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
