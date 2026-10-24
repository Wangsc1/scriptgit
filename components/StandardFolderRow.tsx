import { Button, HStack, Image, Spacer } from "scripting"

export interface TreeNodeLike { path: string; children: TreeNodeLike[] }
/** Visit only visible branches. A collapsed folder never builds descendant views. */
export function visibleTreeRows<T extends TreeNodeLike>(tree: T[], expanded: Set<string>): { node: T; depth: number }[] {
  const rows: { node: T; depth: number }[] = []
  function visit(nodes: T[], depth: number) {
    for (const node of nodes) {
      rows.push({ node, depth })
      if (expanded.has(node.path)) visit(node.children as T[], depth + 1)
    }
  }
  visit(tree, 0)
  return rows
}

/** Cap indentation so deep paths still have readable row width on a phone. */
export function treeRowIndent(depth: number): number { return Math.min(Math.max(depth, 0), 7) * 16 }

/** Standard List button, no native DisclosureGroup subtree/opacity transition.
 * Deliberately immediate state update: no native animation runtime exports are
 * accessed at module initialization OR on tap. rotationEffect is a numeric view
 * prop, not a native factory. The same implementation is used in diagnostic ⑤.
 */
export function StandardFolderRow({ path, depth, expanded, onToggle, label, disabled = false, contextMenu, trailingSwipeActions }: {
  path: string; depth: number; expanded: boolean; onToggle(): void; label: any; disabled?: boolean
  contextMenu?: any; trailingSwipeActions?: any
}) {
  return <Button buttonStyle="plain" accessibilityLabel={`文件夹 ${path}`} disabled={disabled}
    action={() => { if (!disabled) onToggle() }}
    contextMenu={contextMenu} trailingSwipeActions={trailingSwipeActions}
    frame={{ maxWidth: Infinity, alignment: "leading" }}>
    <HStack spacing={10} padding={{ leading: treeRowIndent(depth) }}
      frame={{ maxWidth: Infinity, alignment: "leading" }} contentShape={{ kind: "interaction", shape: "rect" }}>
      {label}<Spacer />
      <Image systemName="chevron.right" rotationEffect={expanded ? 90 : 0} foregroundStyle="secondaryLabel" />
    </HStack>
  </Button>
}
