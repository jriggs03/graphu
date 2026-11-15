/**
 * Who is using this browser. There is no sign-in: the first visit asks for a name and makes
 * up a random id, both kept in this browser. The id is sent with every request, and the
 * server keeps a separate set of graphbooks for each id.
 */
import { useEffect, useState } from 'react'

export type User = { id: string; name: string }

const KEY = 'graphu.user'
const listeners = new Set<(user: User | null) => void>()

function load(): User | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return saved && typeof saved.id === 'string' && typeof saved.name === 'string' ? saved : null
  } catch { return null }
}

let current = load()

/** A random id. `randomUUID` needs HTTPS or localhost, so there is a fallback for plain HTTP. */
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The id sent to the server, or undefined before the first visit has been named. */
export const userId = () => current?.id

/** Set or change the name. The id is created once and never changes. */
export function setName(name: string) {
  current = { id: current?.id ?? newId(), name: name.trim().slice(0, 60) }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* storage may be unavailable */ }
  listeners.forEach(listener => listener(current))
}

export function useUser() {
  const [user, setUser] = useState(current)
  useEffect(() => {
    listeners.add(setUser)
    return () => { listeners.delete(setUser) }
  }, [])
  return user
}
