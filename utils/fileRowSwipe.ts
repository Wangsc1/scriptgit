/** Intent only, no native gesture/state/storage calls. Pair with simultaneous DragGesture(minDistance: 0).
 * Do not claim vertical motion or screen-edge navigation. A hold/native drag never opens actions.
 */
export interface RowSwipeSample {
  time: number
  startLocation: { x: number; y: number }
  translation: { width: number; height: number }
}
export class FileRowSwipeIntent {
  private epoch = 0
  private active: { row: string; began: number; epoch: number; ignored: boolean } | null = null
  nativeDrag() { this.epoch++ }
  changed(row: string, value: RowSwipeSample) {
    const { width: x, height: y } = value.translation
    if (!this.active || this.active.row !== row || (Math.abs(x) < 1 && Math.abs(y) < 1)) {
      this.active = { row, began: value.time, epoch: this.epoch, ignored: value.startLocation.x < 24 }
    }
    const active = this.active
    if (active.epoch !== this.epoch || value.time - active.began >= 400 ||
      (Math.abs(y) >= 12 && Math.abs(y) > Math.abs(x))) active.ignored = true
  }
  ended(row: string, value: RowSwipeSample): "open" | "close" | null {
    const active = this.active
    if (!active || active.row !== row) return null
    this.changed(row, value)
    this.active = null
    if (active.ignored || active.epoch !== this.epoch) return null
    const { width: x, height: y } = value.translation
    if (Math.abs(x) < 44 || Math.abs(x) < Math.abs(y) * 1.5) return null
    return x < 0 ? "open" : "close"
  }
}
