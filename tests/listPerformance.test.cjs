/* UI/IO scheduling tests: synthetic repositories, no network or user worktrees. */
const assert = require('node:assert/strict')
const { load, mount, ui, all, tick } = require('./remoteFiles.test.cjs')
const { buildFileTree } = load('utils/fileTree.ts')
const performance = load('utils/fileListPerformance.ts')
function expand(n) {
  if (!n || typeof n !== 'object') return n
  if (Array.isArray(n)) return n.map(expand)
  if (typeof n.type === 'function') return expand(n.type(n.props))
  return { ...n, children: (n.children || []).map(expand) }
}
async function main() {
  const paths = Array.from({ length: 5000 }, (_, i) => `folder${Math.floor(i / 500)}/sub/file${i}.txt`)
  const tree = buildFileTree(paths)
  const changed = performance.changedDirectoryPaths(['folder0/sub/file0.txt', 'folder1/sub/file500.txt'])
  assert.deepEqual([...changed].sort(), ['folder0', 'folder0/sub', 'folder1', 'folder1/sub'])
  assert.equal(changed.has('folder'), false)
  assert.deepEqual(performance.expandedFilePaths(tree, new Set()), [])
  assert.equal(performance.expandedFilePaths(tree, new Set(['folder0'])).length, 0)
  assert.equal(performance.expandedFilePaths(tree, new Set(['folder0', 'folder0/sub'])).length, 500)
  let active = 0, peak = 0, count = 0, yielded = false
  setTimeout(() => { yielded = true }, 0)
  const metadata = await performance.readMetadataBatched(paths.slice(0, 20), async () => {
    active++; peak = Math.max(peak, active); count++
    await tick(); active--; return { size: 1, modified: 2 }
  }, () => false)
  assert.equal(peak, 4); assert.equal(count, 20); assert.equal(metadata.size, 20); assert.equal(yielded, true)
  let cancelled = false; count = 0
  await performance.readMetadataBatched(paths, async () => { count++; cancelled = true; return { size: 1, modified: 2 } }, () => cancelled)
  assert.ok(count <= 4)
  let statCalls = 0
  global.FileManager = { stat: async () => { statCalls++; return { size: 1, modificationDate: 2 } } }
  const FilesTab = load('pages/FilesTab.tsx', {
    scripting: ui, '../utils/fileTree': { buildFileTree }, '../utils/fileListPerformance': performance,
    '../utils/format': { formatBytes: String, formatDate: String }, '../services/repoStore': { resolveWorkdir: () => '/mock' },
    '../services/gitService': {}, '../constants/colors': {},
  }).FilesTab
  const h = mount(FilesTab, { files: paths, changes: [{ filepath: paths[0], status: '*modified' }], bookmarkName: 'mock', loading: false, onOpen() {}, onWorktreeChanged() {}, onPush() {}, onRestore() {}, mergeInProgress: false })
  await tick()
  const nodes = () => { h.render(); return all(expand(h.tree)) }
  let rows = nodes()
  assert.equal(rows.filter(n => n.type === 'DisclosureGroup').length, 10)
  assert.equal(rows.filter(n => n.props.trailingSwipeActions && n.type === 'Button').length, 0)
  assert.equal(statCalls, 0)
  rows.find(n => n.type === 'DisclosureGroup').props.onChanged(true)
  rows = nodes()
  assert.equal(rows.filter(n => n.type === 'DisclosureGroup').length, 11)
  rows.filter(n => n.type === 'DisclosureGroup')[1].props.onChanged(true)
  rows = nodes()
  assert.equal(rows.filter(n => n.type === 'Button' && n.props.trailingSwipeActions).length, 500)
  rows.find(n => n.type === 'DisclosureGroup').props.onChanged(false)
  assert.equal(nodes().filter(n => n.type === 'Button' && n.props.trailingSwipeActions).length, 0)
  h.unmount()
  console.log('PASS 5000文件折叠惰性行、父目录索引、按展开范围读取、最多4路元数据IO、让出UI与取消')

  let writes = 0, reads = 0, running = 0, maxReads = 0
  const observedUi = new Proxy(ui, { get(target, key) {
    if (key !== 'useState') return target[key]
    return initial => { const [value, set] = target.useState(initial); return [value, next => { writes++; set(next) }] }
  } })
  const repos = Array.from({ length: 10 }, (_, i) => ({ bookmarkName: String(i), name: String(i) }))
  const useStatus = load('hooks/useRepoListStatus.ts', {
    scripting: observedUi,
    './useRepoGithubUpdated': { useRepoGithubUpdated: () => ({ refresh: async () => {}, stop() {}, progress: {} }) },
    '../services/repoStore': { listRepos: () => repos, readSnapshots: async () => ({}) },
    '../services/gitService': { getCachedRepoStatus() {}, getRepoListStatus: async () => {
      reads++; running++; maxReads = Math.max(maxReads, running); await tick(); running--; return { branch: 'main', workdirOk: true }
    } },
    '../utils/repoSort': { sortReposByGithubUpdated: value => value },
  }).useRepoListStatus
  const home = mount(() => useStatus(() => {}), {})
  home.tree.appear(); await home.tree.refreshAll(); home.render()
  assert.equal(reads, 10); assert.equal(maxReads, 2); assert.equal(Object.keys(home.tree.statusMap).length, 10)
  assert.equal(home.tree.progress.completed, 10)
  assert.ok(writes <= 7, `expected coalesced state writes, got ${writes}`)
  home.unmount()
  console.log('PASS 10仓库两路扫描、结果不丢失、状态写入合并且不按逐仓进度重复渲染')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
