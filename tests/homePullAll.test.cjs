/* Real homepage refresh callback, mocked safe-pull facade: no network/write effects. */
const assert = require('node:assert/strict')
const { load, mount, ui, all, tick, deferred } = require('./remoteFiles.test.cjs')
function page(rows, pull, refresh, refreshOne = () => {}, overrides = {}) {
  const scripting = new Proxy(ui, { get(target, key) { return key === 'Navigation' ? { useDismiss: () => () => {} } : target[key] } })
  return load('pages/RepoListPage.tsx', {
    scripting,
    '../services/repoStore': { listRepos: () => rows, sourceLabel: () => '' },
    '../services/gitService': { autoPullFastForward: pull },
    '../components/BusyOverlay': {}, '../components/CommitMessageSheet': { CommitMessageSheet: 'CommitMessageSheet' }, '../utils/format': { buildCommitMessage: (title, description) => { const head = title.trim(), body = (description || '').trim(); return body ? `${head}\n\n${body}` : head } }, './RepoDetailPage': {}, './ClonePage': {},
    '../constants/colors': {}, '../utils/mergeConflict': {},
    '../utils/github': { githubRepoFromRemoteUrl: () => null },
    '../utils/remoteProgress': { yieldForUi: async () => {} },
    '../utils/repoDetailAlerts': load('utils/repoDetailAlerts.ts', { './format': {} }),
    '../utils/repoSort': { sortReposByGithubUpdated: value => value },
    '../hooks/useRepoListStatus': { useRepoListStatus: () => ({ statusMap: {}, snapshotMap: {}, repoRefreshMap: {}, githubUpdatedProgress: {}, refreshAll: refresh, refreshRepo: refreshOne }) },
    '../hooks/useRepoSyncActions': { useRepoSyncActions: () => ({ handlePush: async () => {} }) }, '../hooks/useRepoVisibilities': { useRepoVisibilities: () => ({}) },
    ...overrides,
  }).RepoListPage
}
async function main() {
  const rows = ['clone', 'local', 'noRemote', 'bad', 'afterError'].map((name, i) => ({ name, bookmarkName: name, source: i ? 'local' : 'clone' }))
  const calls = [], gate = deferred(), refreshGate = deferred()
  let refreshes = 0
  const h = mount(page(rows, async (key, options) => {
    calls.push(key); assert.equal(options.includeAllSources, true)
    if (key === 'clone') await gate.promise
    if (key === 'bad') throw Error('HTTP 403')
    if (key === 'noRemote') return { status: 'skipped', reason: '未配置 upstream' }
    return { status: key === 'local' ? 'updated' : 'unchanged' }
  }, async force => { refreshes++; assert.equal(force, true); await refreshGate.promise }), {})
  assert.equal(all(h.tree).some(n => n.type === 'ProgressView'), false)
  const first = h.tree.props.refreshable(), duplicate = h.tree.props.refreshable()
  assert.equal(first, duplicate)
  await tick(); h.render(); const bar = all(h.tree).find(n => n.type === 'ProgressView'); assert.equal(bar.props.progressViewStyle,'linear'); assert.equal(bar.props.value,0); assert.equal(bar.props.total,6); assert.deepEqual(calls, ['clone']); assert.equal(refreshes, 0)
  gate.resolve(); await tick(); h.render()
  const finishing = all(h.tree).find(n => n.type === 'ProgressView')
  assert.equal(finishing.props.value, 5); assert.equal(finishing.props.total, 6)
  refreshGate.resolve(); await first
  assert.deepEqual(calls, rows.map(r => r.name)); assert.equal(refreshes, 1)
  h.render(); assert.equal(all(h.tree).some(n => n.type === 'ProgressView'), false); assert.equal(h.tree.props.alert.title, '批量拉取结果')
  assert.match(JSON.stringify(h.tree.props.alert.message), /noRemote：未配置 upstream/)
  assert.match(JSON.stringify(h.tree.props.alert.message), /bad：拉取失败，HTTP 403/)
  assert.match(JSON.stringify(h.tree.props.alert.message), /已更新 1 个/)
  h.unmount()
  const later = deferred(), stopped = [], nextRows = [{ bookmarkName: 'a' }, { bookmarkName: 'b' }]
  const e = mount(page(nextRows, async key => { stopped.push(key); await later.promise; return { status: 'unchanged' } }, async () => { throw Error('must not refresh after unmount') }), {})
  const pending = e.tree.props.refreshable(); await tick(); e.unmount(); later.resolve(); await pending
  assert.deepEqual(stopped, ['a']); assert.equal(e.lateWrites, 0)
  const oneGate = deferred(), oneCalls = [], refreshed = []
  const single = mount(page(rows, async (key, options) => {
    oneCalls.push(key); assert.equal(options.includeAllSources, true)
    await oneGate.promise; return { status: 'updated', reason: '已快进更新' }
  }, async () => { throw Error('single pull must not refresh all repos') }, repo => refreshed.push(repo.bookmarkName)), {})
  const actions = () => { single.render(); return all(single.tree).filter(n => n.props.trailingSwipeActions).map(n => n.props.trailingSwipeActions) }
  let swipes = actions()
  assert.equal(swipes[1].allowsFullSwipe, false)
  assert.deepEqual(swipes[1].actions.map(n => n.props.title), ['拉取', '删除'])
  assert.equal(swipes[1].actions[0].props.tint, 'systemBlue'); assert.equal(swipes[1].actions[0].props.systemImage, undefined)
  const action = swipes[1].actions[0].props.action
  const one = action(), again = action(); assert.equal(one, again)
  assert.ok(actions().every(swipe => swipe.actions[0].props.disabled))
  await tick(); assert.deepEqual(oneCalls, ['local'])
  oneGate.resolve(); await one
  assert.deepEqual(refreshed, ['local']); assert.ok(actions().every(swipe => !swipe.actions[0].props.disabled))
  assert.equal(single.tree.props.alert.title, '拉取完成'); single.unmount()
  console.log('PASS 下拉涵盖所有来源、重复下拉单飞、单仓跳过/失败不阻断、最后仅刷新一次、卸载停止后续任务；蓝色左滑仅拉取目标仓库且防重复')
}
module.exports = { page }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
