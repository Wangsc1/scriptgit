/** Private per-FilesTab drag capability. Payload contains no path or bookmark.
 * Official onDrag.data creates a new ItemProvider.fromText each time; performDrop
 * must initiate loadText synchronously. No documented drag-end callback exists,
 * so a cancelled drag does nothing and its capability expires/replaces on next drag.
 */
export interface LocalFileDrag { token: string; bookmarkName: string; root: string; path: string; expires: number }
export class LocalFileDragSession {
  private active: LocalFileDrag | null = null
  clear() { this.active = null }
  begin(bookmarkName: string, root: string, path: string): string {
    this.clear()
    // Official UUID.string(), no predictable path/JSON accepted as authorization.
    const token = "scriptgit-local-move:" + UUID.string() + ":" + UUID.string()
    this.active = { token, bookmarkName, root, path, expires: Date.now() + 120000 }
    return token
  }
  eligible(bookmarkName: string, directory: string): boolean {
    const drag = this.active
    return !!drag && drag.bookmarkName === bookmarkName && drag.expires > Date.now() &&
      drag.path !== directory && (drag.path.includes("/") ? drag.path.slice(0, drag.path.lastIndexOf("/")) : "") !== directory
  }
  consume(token: string | null, bookmarkName: string, root: string, directory: string): LocalFileDrag | null {
    const drag = this.active
    const valid = this.eligible(bookmarkName, directory) && !!drag && token === drag.token && root === drag.root
    this.clear() // One shot, including forged/stale payload attempts.
    return valid ? drag : null
  }
}
