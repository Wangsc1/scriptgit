import { createContext, useContext, useEffect, useRef } from "scripting"

export type HorizontalScope = {
  guards: Set<() => boolean>
  exit: (after: () => void | Promise<void>) => Promise<void>
  isTop: () => boolean
}
export const HorizontalRouteContext = createContext<HorizontalScope>()

/** Ignore delayed callbacks from a covered parent without starting new writes. */
export function useHorizontalActive() {
  const scope = useContext(HorizontalRouteContext)
  return () => !scope || scope.isTop()
}

/** Completion callbacks run only after the route's horizontal removal. */
export function useHorizontalFinish() {
  const scope = useContext(HorizontalRouteContext)
  return (after: () => void | Promise<void>) => scope ? scope.exit(after) : Promise.resolve(after())
}

/** Call only after this page's async save/confirmation has granted exit. */
export function useHorizontalExit(after: () => void | Promise<void>) {
  const scope = useContext(HorizontalRouteContext)
  const current = useRef(after)
  current.current = after
  return () => scope ? scope.exit(() => current.current()) : Promise.resolve(current.current())
}

/** Writes on a destination (including its mounted tabs) block the shell back path. */
export function useHorizontalBackGuard(blocked: boolean) {
  const scope = useContext(HorizontalRouteContext)
  const current = useRef(blocked)
  current.current = blocked
  useEffect(() => {
    if (!scope) return
    const guard = () => current.current
    scope.guards.add(guard)
    return () => { scope.guards.delete(guard) }
  }, [scope])
}
