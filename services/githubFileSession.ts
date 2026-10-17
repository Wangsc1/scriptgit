/** 单文件编辑会话：失败不丢草稿、不推进 SHA；所有保存串行化。 */
export interface RemoteTextFile {
  path: string
  sha: string
  text: string | null
  readOnlyReason?: string
}

export class GitHubFileSession {
  readonly path: string
  readonly branch: string
  readonly readOnlyReason?: string
  private original: string
  private sha: string
  saving = false

  constructor(file: RemoteTextFile, branch: string) {
    this.path = file.path
    this.branch = branch
    this.sha = file.sha
    this.original = file.text ?? ""
    this.readOnlyReason = file.readOnlyReason || (file.text === null ? "非文本文件" : undefined)
  }

  isDirty(text: string): boolean { return text !== this.original }

  async save(text: string, message: string, write: (input: {
    path: string; branch: string; sha: string; text: string; message: string
  }) => Promise<string>): Promise<void> {
    if (this.saving) throw new Error("正在保存，请勿重复提交")
    if (this.readOnlyReason) throw new Error(this.readOnlyReason)
    if (!message.trim()) throw new Error("提交消息不能为空")
    if (!this.isDirty(text)) throw new Error("文件没有修改")
    this.saving = true
    try {
      const sha = await write({ path: this.path, branch: this.branch, sha: this.sha, text, message: message.trim() })
      if (!sha) throw new Error("保存响应缺少文件 SHA，请重新加载并核对远端状态")
      this.sha = sha
      this.original = text
    } finally {
      this.saving = false
    }
  }
}
