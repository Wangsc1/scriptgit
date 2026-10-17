import { useEffect, useRef, useState } from "scripting"
import { createLocalWorktreeEntry } from "../services/gitService"
import { resolveWorkdir } from "../services/repoStore"

/** Owned by the stable detail List, not the conditionally mounted FilesTab Section. */
export function useLocalEntryCreation({ bookmarkName, unavailable, onChanged, onError }: {
  bookmarkName: string
  unavailable: boolean
  onChanged: () => void | Promise<void>
  onError: (message: string) => void
}) {
  const [form, setForm] = useState<{ directory: boolean; root: string; bookmarkName: string; id: number; onCreated: (path: string) => void } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const state = useRef({ alive: true, busy: false, sequence: 0 })
  useEffect(() => () => { state.current.alive = false }, [])
  function open(directory: boolean, onCreated: (path: string) => void) {
    if (!state.current.alive || state.current.busy || unavailable || form) return
    try {
      const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
      setError("")
      setForm({ directory, root, bookmarkName, id: ++state.current.sequence, onCreated })
    } catch (e: any) { onError(String(e?.message || e)) }
  }
  function cancel() { if (!state.current.busy) setForm(null) }
  async function confirm(name: string) {
    if (!form || !state.current.alive || state.current.busy || unavailable || form.bookmarkName !== bookmarkName) return
    state.current.busy = true; setBusy(true); setError("")
    try {
      const path = await createLocalWorktreeEntry(bookmarkName, name, form.directory, form.root)
      if (state.current.alive) { form.onCreated(path); setForm(null) }
      await onChanged()
    } catch (e: any) {
      const message = String(e?.message || e)
      if (state.current.alive) { setError(message); onError(message) }
      // Reflect any partial target; never delete the source/target as rollback.
      try { await onChanged() } catch (_) { /* Keep the original error. */ }
    } finally {
      state.current.busy = false
      if (state.current.alive) setBusy(false)
    }
  }
  return { form, busy, error, open, cancel, confirm }
}
