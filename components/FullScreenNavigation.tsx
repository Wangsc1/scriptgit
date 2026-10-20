import { Button, HStack, Image, NavigationStack, Spacer, VStack, useEffect, useRef, useState, type VirtualNode } from "scripting"
import { COLOR_SECONDARY_LABEL } from "../constants/colors"

type Presentation = {
  isPresented: boolean
  onChanged: (presented: boolean) => void
  content: VirtualNode
}

/** Each business destination owns its navigation chrome, not a push on the presenting stack.
 * Closing uses the same state/refresh callback as native modal dismissal.
 * Existing editor/viewer/form covers already own their stack and close policy.
 */
export function fullScreenPage(presentation: Presentation, ownClose = false): Presentation {
  return {
    ...presentation,
    content: <NavigationStack>
      <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }}
        toolbar={ownClose ? undefined : {
          topBarLeading: <Button title="返回" action={() => presentation.onChanged(false)} />,
        }}>
        {presentation.content}
      </VStack>
    </NavigationStack>,
  }
}

/** Row equivalent of a NavigationLink, but with native full-screen modal motion. */
export function FullScreenLink({ destination, children }: {
  destination: VirtualNode
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
  })}>
    <Button action={() => changePresented(true)} buttonStyle="plain">
      <HStack>
        {children}
        <Spacer />
        <Image systemName="chevron.right" font="caption" foregroundStyle={COLOR_SECONDARY_LABEL} />
      </HStack>
    </Button>
  </HStack>
}
