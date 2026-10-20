import { DragGesture, useEffect, useRef } from "scripting"

type Drag = { startLocation: { x: number }; translation: { width: number; height: number } }
/** Points in the full page's local coordinate space; never a general horizontal swipe. */
export function isEdgeBack(details: Drag): boolean {
  const x = details.startLocation.x, dx = details.translation.width, dy = details.translation.height
  return Number.isFinite(x) && Number.isFinite(dx) && Number.isFinite(dy) &&
    x >= 0 && x <= 24 && dx >= 80 && dx > Math.abs(dy) * 1.5
}

/** End-only recognition requests a protected horizontal exit; never a native pop.
 * One completion per drag; an async save cannot be started twice. Failed/cancelled
 * returns can be retried by starting a new drag. Never takes gesture priority.
 */
export function useEdgeBack(action: () => void | Promise<void>, enabled = true) {
  const state = useRef({ alive: true, pending: false, ended: false, action, enabled })
  state.current.action = action; state.current.enabled = enabled
  useEffect(() => () => { state.current.alive = false }, [])
  return DragGesture({ minDistance: 20, coordinateSpace: "local" })
    .onChanged(() => { if (!state.current.pending) state.current.ended = false })
    .onEnded(async details => {
      const s = state.current
      if (!s.alive || !s.enabled || s.pending || s.ended || !isEdgeBack(details)) return
      s.ended = true; s.pending = true
      try { await s.action() }
      finally { s.pending = false }
    })
}
