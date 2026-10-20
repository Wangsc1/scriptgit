import { Section, Text, useObservable } from "scripting"
import { FormSheet } from "./FormSheet"
import { FormRow } from "./FormRow"

/** 草稿由表单持有，避免逐字符重建原生输入框。 */
export function NameInputSheet({ title, initialName, message, busy, error, onCancel, onConfirm }: {
  title: string; initialName: string; message: string; busy: boolean; error: string
  onCancel: () => void; onConfirm: (name: string) => void
}) {
  const name = useObservable(initialName)
  return <FormSheet backDisabled={busy} navigationTitle={title} confirmTitle="确认" confirmDisabled={busy || !name.value.trim()} error={error} onCancel={onCancel} onConfirm={() => onConfirm(name.value)}>
    <Section footer={<Text>{message}</Text>}>
      <FormRow label="新名称" observable={name} />
    </Section>
  </FormSheet>
}
