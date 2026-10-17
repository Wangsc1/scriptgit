import { useEffect, useRef, useState } from "scripting"
import { getStartupPullState, startStartupPull, stopStartupPull, subscribeStartupPull } from "../services/startupAutoPull"

export function useStartupAutoPull(onSettled: (key: string) => void) {
  const [result, setResult] = useState(getStartupPullState)
  const callback = useRef(onSettled)
  callback.current = onSettled
  useEffect(() => {
    const unsubscribe = subscribeStartupPull((value, key) => {
      setResult(value)
      if (key) callback.current(key)
    })
    // 读取已完成汇总而非再次排队；模块级once跨Tab/页面重挂载生效。
    setResult(getStartupPullState())
    void startStartupPull()
    return unsubscribe
  }, [])
  return { ...result, stop: stopStartupPull }
}
