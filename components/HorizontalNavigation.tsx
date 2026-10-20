import { Animation, Button, GeometryReader, HStack, Image, NavigationStack, Spacer, VStack, ZStack, createContext, useContext, useEffect, useMemo, useObservable, useRef, useState, withAnimation, type VirtualNode } from "scripting"
import { COLOR_SECONDARY_LABEL } from "../constants/colors"
import { useEdgeBack } from "../hooks/useEdgeBack"
import { HorizontalRouteContext, type HorizontalScope } from "../hooks/useHorizontalRoute"

type Destination = {
  isPresented: boolean
  onChanged: (presented: boolean) => void
  content: VirtualNode
  ownClose?: boolean
}
type Route = {
  id: object; key: number; source: object; slot: number; parent?: object; destination: Destination
  scope: HorizontalScope; closing: boolean; presented: boolean; animate?: () => Promise<void>
}

/** Project-local route store: visual removal precedes callbacks and controller disposal.
 * There are no native push entries or modal business presentations to bypass guards.
 */
export class HorizontalRoutes {
  routes: Route[] = []
  listeners = new Set<() => void>()
  private completed = new Map<object, Set<number>>()
  alive = true
  private nextKey = 0
  private emit() { if (this.alive) for (const notify of this.listeners) notify() }
  isTop(id: object) { return this.routes[this.routes.length - 1]?.id === id }
  update(source: object, destinations: Destination[], parent?: object) {
    if (!this.alive) return
    const completed = this.completed.get(source) || new Set<number>()
    this.completed.set(source, completed)
    let changed = false
    destinations.forEach((input, slot) => {
      const destination = { ownClose: true, ...input }
      const route = this.routes.find(r => r.source === source && r.slot === slot)
      if (route) route.presented = destination.isPresented
      if (!destination.isPresented) {
        completed.delete(slot)
        if (route && !route.closing) void this.exit(route.id, () => destination.onChanged(false))
      } else if (route) {
        if (!route.closing) { route.destination = destination; changed = true }
      } else if (!completed.has(slot)) {
        const id = {}, scope: HorizontalScope = {
          guards: new Set(), isTop: () => this.isTop(id), exit: after => this.exit(id, after),
        }
        this.routes.push({ id, key: ++this.nextKey, source, slot, parent, destination, scope, closing: false, presented: true })
        changed = true
      }
    })
    if (changed) this.emit()
  }
  async back(id: object) {
    const route = this.routes.find(r => r.id === id)
    if (!route || route.destination.ownClose || !this.isTop(id) || [...route.scope.guards].some(blocked => blocked())) return
    await this.exit(id, () => route.destination.onChanged(false))
  }
  async exit(id: object, after: () => void | Promise<void>) {
    const route = this.routes.find(r => r.id === id)
    if (!this.alive || !route || route.closing || !this.isTop(id)) return
    route.closing = true
    this.emit()
    // Layer remains mounted, with its last live content, throughout this await.
    try { if (route.animate) await route.animate() }
    catch (error) {
      // Animation failure is not permission to discard the mounted page.
      route.closing = false; this.emit(); throw error
    }
    if (!this.alive || !this.routes.includes(route)) return
    if (route.presented) this.completed.get(route.source)?.add(route.slot)
    this.routes = this.routes.filter(r => r !== route)
    this.emit()
    await after()
  }
  async finish(source: object, slot: number, after: () => void | Promise<void>) {
    const route = this.routes.find(r => r.source === source && r.slot === slot)
    if (route) await this.exit(route.id, after)
    else if (this.alive) await after()
  }
  release(source: object) {
    const removed = new Set(this.routes.filter(r => r.source === source).map(r => r.id))
    let previous = -1
    while (previous !== removed.size) {
      previous = removed.size
      for (const r of this.routes) if (r.parent && removed.has(r.parent)) removed.add(r.id)
    }
    this.routes = this.routes.filter(r => !removed.has(r.id))
    this.completed.delete(source)
    if (removed.size) this.emit()
  }
  dispose() { this.alive = false; this.routes = []; this.listeners.clear(); this.completed.clear() }
}
export const HorizontalRoutesContext = createContext<HorizontalRoutes>()
const RouteIdContext = createContext<object>()

/** Existing page chrome uses isolated *sibling* single-root stacks, never nested
 * native push stacks. The stable root/parent nodes stay mounted underneath. */
export function HorizontalNavigationRoot({ children }: { children: VirtualNode }) {
  const routes = useMemo(() => new HorizontalRoutes(), [])
  useEffect(() => () => routes.dispose(), [])
  return <HorizontalRoutesContext.Provider value={routes}>
    <ZStack frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
      <HorizontalBase routes={routes}>{children}</HorizontalBase>
      <HorizontalLayers routes={routes} />
    </ZStack>
  </HorizontalRoutesContext.Provider>
}
function HorizontalBase({ routes, children }: { routes: HorizontalRoutes; children: VirtualNode }) {
  const [, render] = useState(0)
  useEffect(() => {
    const update = () => render(v => v + 1)
    routes.listeners.add(update); update()
    return () => { routes.listeners.delete(update) }
  }, [routes])
  return <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} disabled={routes.routes.length > 0}>{children}</VStack>
}
function HorizontalLayers({ routes }: { routes: HorizontalRoutes }) {
  const [, render] = useState(0)
  useEffect(() => {
    const update = () => render(v => v + 1)
    routes.listeners.add(update); update()
    return () => { routes.listeners.delete(update) }
  }, [routes])
  if (routes.routes.length === 0) return <></>
  return <ZStack frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
    {routes.routes.map((route, index) => <HorizontalLayer key={route.key} route={route} routes={routes} top={index === routes.routes.length - 1} />)}
  </ZStack>
}
function HorizontalLayer({ route, routes, top }: { route: Route; routes: HorizontalRoutes; top: boolean }) {
  const position = useObservable(1)
  const alive = useRef(true)
  useEffect(() => {
    const entered = withAnimation(Animation.easeOut(0.28), () => position.setValue(0))
    route.animate = async () => {
      await entered
      if (alive.current) await withAnimation(Animation.easeOut(0.28), "logicallyComplete", () => position.setValue(1))
    }
    return () => { alive.current = false; route.animate = undefined }
  }, [])
  const back = () => { if (alive.current) return routes.back(route.id) }
  const gesture = useEdgeBack(back, top && !route.closing && !route.destination.ownClose)
  return <GeometryReader>{geometry => <VStack spacing={0}
    offset={{ x: geometry.size.width * position.value, y: 0 }}
    frame={{ width: geometry.size.width, height: geometry.size.height }}
    disabled={!top || route.closing}>
    <NavigationStack>
      <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} background="systemBackground"
        simultaneousGesture={route.destination.ownClose ? undefined : gesture}
        toolbar={route.destination.ownClose ? undefined : { topBarLeading: <Button action={back}><Image systemName="chevron.left" /></Button> }}>
        <RouteIdContext.Provider value={route.id}>
          <HorizontalRouteContext.Provider value={route.scope}>{route.destination.content}</HorizontalRouteContext.Provider>
        </RouteIdContext.Provider>
      </VStack>
    </NavigationStack>
  </VStack>}</GeometryReader>
}

/** Declaration only: layers are rendered above the root TabView, not inside a
 * List/Section cell. No page/scroll/tab state is replaced by opening a route. */
export function useHorizontalDestinations(presentation: Destination | Destination[]) {
  const routes = useContext(HorizontalRoutesContext)
  const parent = useContext(RouteIdContext)
  const source = useRef({})
  const alive = useRef(true)
  useEffect(() => { routes?.update(source.current, Array.isArray(presentation) ? presentation : [presentation], parent) }, [presentation])
  useEffect(() => () => { alive.current = false; routes?.release(source.current) }, [routes])
  return (slot: number, after: () => void | Promise<void>) => !alive.current ? Promise.resolve() : routes
    ? routes.finish(source.current, slot, after) : Promise.resolve(after())
}
export function horizontalPage(presentation: Destination, ownClose = false): Destination {
  return { ...presentation, ownClose }
}
export function HorizontalLink({ destination, children, onReturn }: {
  destination: VirtualNode; onReturn?: () => void; children: VirtualNode | VirtualNode[]
}) {
  const [presented, setPresented] = useState(false)
  useHorizontalDestinations(horizontalPage({ isPresented: presented, onChanged: value => { setPresented(value); if (!value) onReturn?.() }, content: destination }))
  return <Button action={() => setPresented(true)} buttonStyle="plain"><HStack>
    {children}<Spacer /><Image systemName="chevron.right" font="caption" foregroundStyle={COLOR_SECONDARY_LABEL} />
  </HStack></Button>
}
