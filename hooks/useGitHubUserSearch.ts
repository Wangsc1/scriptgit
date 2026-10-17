/** 350ms 防抖；更改/清空/选择/卸载立即废弃旧请求，不让候选串到新用户名。 */
import { useEffect, useRef, useState } from "scripting"
import { searchGitHubUsers, type GitHubUserCandidate } from "../api/githubApi"

export function useGitHubUserSearch() {
  const [candidates, setCandidates] = useState<GitHubUserCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const [limited, setLimited] = useState(false)
  const [incomplete, setIncomplete] = useState(false)
  const state = useRef({ epoch: 0, query: "", page: 0, busy: false, alive: true, timer: null as ReturnType<typeof setTimeout> | null })

  function reset(query: string) {
    const current = state.current
    current.epoch++; current.query = query.trim(); current.page = 0; current.busy = false
    if (current.timer !== null) clearTimeout(current.timer)
    current.timer = null
    setCandidates([]); setLoading(false); setError(""); setHasMore(false); setTotal(null); setLimited(false); setIncomplete(false)
  }

  async function fetchPage(page: number, epoch: number) {
    const current = state.current
    if (!current.alive || epoch !== current.epoch || current.busy) return
    const query = current.query
    current.busy = true; setLoading(true); setError("")
    try {
      const result = await searchGitHubUsers(query, page)
      if (!current.alive || epoch !== current.epoch) return
      setCandidates(previous => {
        const items = page === 1 ? result.items : [...previous, ...result.items]
        const seen = new Set<string>()
        return items.filter(item => { const login = item.login.toLowerCase(); if (seen.has(login)) return false; seen.add(login); return true })
      })
      current.page = page
      setTotal(result.total); setHasMore(result.hasMore); setLimited(result.limited); setIncomplete(result.incomplete)
    } catch (e: any) {
      if (current.alive && epoch === current.epoch) setError("搜索失败：" + String(e?.message || e))
    } finally {
      if (current.alive && epoch === current.epoch) { current.busy = false; setLoading(false) }
    }
  }

  function changeQuery(query: string) {
    reset(query)
    const current = state.current
    if (!/^[A-Za-z0-9-]{2,39}$/.test(current.query)) return
    const epoch = current.epoch
    current.timer = setTimeout(() => { current.timer = null; fetchPage(1, epoch) }, 350)
  }

  function loadMore() { return fetchPage(state.current.page + 1, state.current.epoch) }
  // 首次失败重试第一页，翻页失败则重试下一页，不丢已展示的候选。
  function retry() { if (/^[A-Za-z0-9-]{2,39}$/.test(state.current.query)) return loadMore() }

  useEffect(() => () => {
    state.current.alive = false; state.current.epoch++
    if (state.current.timer !== null) clearTimeout(state.current.timer)
  }, [])

  return { candidates, loading, error, hasMore, total, limited, incomplete, changeQuery, selectUser: reset, loadMore, retry }
}
