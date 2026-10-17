/* Real homepage refresh callback, mocked safe-pull facade: no network/write effects. */
const assert = require('node:assert/strict')
const { load, mount, ui, tick, deferred } = require('./remoteFiles.test.cjs')
function page(rows, pull, refresh) {
  const scripting = new Proxy(ui, { get(target, key) { return key === 'Navigation' ? { useDismiss: () => () => {} } : target[key] } })
  return load('pages/RepoListPage.tsx', {
    scripting,
    '../services/repoStore': { listRepos: () => rows, sourceLabel: () => '' },
    '../services/gitService': { autoPullFastForward: pull },
    '../components/BusyOverlay': {}, './RepoDetailPage': {}, './ClonePage': {},
    '../constants/colors': {}, '../utils/mergeConflict': {},
    '../utils/github': { githubRepoFromRemoteUrl: () => null },
    '../utils/remoteProgress': { yieldForUi: async () => {} },
    '../utils/repoSort': { sortReposByGithubUpdated: value => value },
    '../hooks/useRepoListStatus': { useRepoListStatus: () => ({ statusMap: {}, snapshotMap: {}, repoRefreshMap: {}, githubUpdatedProgress: {}, refreshAll: refresh }) },
    '../hooks/useStartupAutoPull': { useStartupAutoPull() {} },
    '../hooks/useRepoVisibilities': { useRepoVisibilities: () => ({}) },
  }).RepoListPage
}
async function main() {
  const rows = ['clone', 'local', 'noRemote', 'bad', 'afterError'].map((name, i) => ({ name, bookmarkName: name, source: i ? 'local' : 'clone' }))
  const calls = [], gate = deferred()
  let refreshes = 0
  const h = mount(page(rows, async (key, options) => {
    calls.push(key); assert.equal(options.includeAllSources, true)
    if (key === 'clone') await gate.promise
    if (key === 'bad') throw Error('HTTP 403')
    if (key === 'noRemote') return { status: 'skipped', reason: '未配置 upstream' }
    return { status: key === 'local' ? 'updated' : 'unchanged' }
  }, async force => { refreshes++; assert.equal(force, true) }), {})
  const first = h.tree.props.refreshable(), duplicate = h.tree.props.refreshable()
  assert.equal(first, duplicate)
  await tick(); assert.deepEqual(calls, ['clone']); assert.equal(refreshes, 0)
  gate.resolve(); await first
  assert.deepEqual(calls, rows.map(r => r.name)); assert.equal(refreshes, 1)
  h.render(); assert.equal(h.tree.props.alert.title, '批量拉取结果')
  assert.match(JSON.stringify(h.tree.props.alert.message), /noRemote：未配置 upstream/)
  assert.match(JSON.stringify(h.tree.props.alert.message), /bad：拉取失败，HTTP 403/)
  assert.match(JSON.stringify(h.tree.props.alert.message), /已更新 1 个/)
  h.unmount()
  const later = deferred(), stopped = [], nextRows = [{ bookmarkName: 'a' }, { bookmarkName: 'b' }]
  const e = mount(page(nextRows, async key => { stopped.push(key); await later.promise; return { status: 'unchanged' } }, async () => { throw Error('must not refresh after unmount') }), {})
  const pending = e.tree.props.refreshable(); await tick(); e.unmount(); later.resolve(); await pending
  assert.deepEqual(stopped, ['a']); assert.equal(e.lateWrites, 0)
  console.log('PASS 下拉涵盖所有来源、重复下拉单飞、单仓跳过/失败不阻断、最后仅刷新一次、卸载停止后续任务')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
