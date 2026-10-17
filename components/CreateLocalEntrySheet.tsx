import { NavigationStack, List, Section, Text, Button, useObservable } from "scripting"
import { FormRow } from "./FormRow"

/** Dedicated create form. Presentation modifiers belong to the sheet's ROOT:
 * https://scriptingapp.github.io/guide/View%20Modifiers/Presentation%20View%20Modifiers.md
 * No auto-focus or imperative navigation while the native Menu is dismissing.
 */
export function CreateLocalEntrySheet({ directory, busy, error, onCancel, onConfirm }: {
  directory: boolean; busy: boolean; error: string
  onCancel: () => void; onConfirm: (name: string) => void
}) {
  const name = useObservable("")
  return <NavigationStack
    presentationDetents={["medium", "large"]}
    presentationDragIndicator="visible"
    presentationBackground="systemGroupedBackground"
  >
    <List
      navigationTitle={directory ? "创建目录" : "创建文件"}
      navigationBarTitleDisplayMode="inline"
      scrollContentBackground="hidden"
      scrollDismissesKeyboard="interactively"
      toolbar={{
        cancellationAction: <Button title="取消" action={onCancel} disabled={busy} />,
        confirmationAction: <Button title="确认" action={() => onConfirm(name.value)} disabled={busy || !name.value.trim()} />,
      }}
    >
      {error ? <Section><Text font={13} foregroundStyle="systemRed">{error}</Text></Section> : null}
      <Section footer={<Text>添加到仓库工作区根目录。不覆盖同名目标，不暂存、提交或推送。文件初始为空，扩展名不限；Git 不跟踪空目录。</Text>}>
        <FormRow label="新名称" observable={name} />
      </Section>
    </List>
  </NavigationStack>
}
