import { Button, HStack, Image, NavigationStack, Spacer, VStack, useEffect, useRef, useState, type VirtualNode } from "scripting"
import { COLOR_SECONDARY_LABEL } from "../constants/colors"
import { ModalBackContext, useEdgeBack } from "../hooks/useEdgeBack"

type Presentation = {
  isPresented: boolean
  onChanged: (presented: boolean) => void
  content: VirtualNode
}

/** Each business destination owns its navigation chrome, not a push on the presenting stack.
 * Closing uses the same state/refresh callback as native modal dismissal.
 * Existing editor/viewer/form covers already own their stack and close policy.
 */
export function fullScreenPage(presentation: Presentation, ownClose = false, backArrow = false): Presentation {
  let dismissed = false
  const controlled = { ...presentation, onChanged: (presented: boolean) => {
    if (!presented) {
      if (dismissed || !presentation.isPresented) return
      dismissed = true
    }
    presentation.onChanged(presented)
  } }
  return {
    ...controlled,
    content: <NavigationStack>
      <ModalBackContent presentation={controlled} ownClose={ownClose} backArrow={backArrow} />
    </NavigationStack>,
  }
}

function ModalBackContent({ presentation, ownClose, backArrow }: {
  presentation: Presentation; ownClose: boolean; backArrow: boolean
}) {
  const scope = useRef({ guards: new Set<() => boolean>() })
  const closed = useRef(false)
  const current = useRef(presentation)
  if (current.current.isPresented !== presentation.isPresented) closed.current = false
  current.current = presentation
  function back() {
    if (!current.current.isPresented || closed.current || [...scope.current.guards].some(blocked => blocked())) return
    closed.current = true
    current.current.onChanged(false)
  }
  const gesture = useEdgeBack(back, !ownClose)
  return <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }}
    simultaneousGesture={ownClose ? undefined : gesture}
    toolbar={ownClose ? undefined : {
      topBarLeading: backArrow
        ? <Button action={back}><Image systemName="chevron.left" /></Button>
        : <Button title="返回" action={back} />,
    }}>
    <ModalBackContext.Provider value={scope.current}>{presentation.content}</ModalBackContext.Provider>
  </VStack>
}

/** Row equivalent of a NavigationLink, but with native full-screen modal motion. */
export function FullScreenLink({ destination, children, backArrow = false }: {
  destination: VirtualNode
  backArrow?: boolean
  children: VirtualNode | VirtualNode[]
}) {
  const [presented, setPresented] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  function changePresented(value: boolean) {
    if (alive.current) setPresented(value)
  }
  return <HStack fullScreenCover={fullScreenPage({
    isPresented: presented, onChanged: changePresented, content: destination,
  }, false, backArrow)}>
    <Button action={() => changePresented(true)} buttonStyle="plain">
      <HStack>
        {children}
        <Spacer />
        <Image systemName="chevron.right" font="caption" foregroundStyle={COLOR_SECONDARY_LABEL} />
      </HStack>
    </Button>
  </HStack>
}
