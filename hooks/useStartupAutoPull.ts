import { useEffect, useRef } from "scripting"
import { startStartupPull, subscribeStartupPull } from "../services/startupAutoPull"

/** 只启动一次后台任务并在单仓完成后刷新对应状态；不渲染结果UI，也不保存React状态。 */
export function useStartupAutoPull(onSettled: (key: string) => void): void {
  const callback = useRef(onSettled)
  callback.current = onSettled
  useEffect(() => {
    const unsubscribe = subscribeStartupPull((_value, key) => { if (key) callback.current(key) })
    void startStartupPull()
    return unsubscribe
  }, [])
}
