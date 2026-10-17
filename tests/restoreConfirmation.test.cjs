const assert = require('node:assert/strict')
const fs = require('node:fs')
const { load, ui, mount } = require('./remoteFiles.test.cjs')
const { getRepoPendingAlert } = load('utils/repoDetailAlerts.ts', { './format': {} })
const file = { type: 'restore', filepath: 'a.txt' }
const folder = { type: 'restore', filepath: 'folder', filepaths: ['folder/a.txt', 'folder/sub/b.txt'] }
for (const action of [file, folder]) {
  const alert = getRepoPendingAlert(action)
  assert.equal(alert.title, '还原改动？')
  assert.equal(alert.confirmButton, '还原')
  assert.match(alert.message, /当前改动将丢失，此操作不可撤销/)
}
assert.equal(getRepoPendingAlert({ ...folder, filepath: 'same' }).message, getRepoPendingAlert({ ...file, filepath: 'same' }).message)
const page = fs.readFileSync(require('node:path').join(__dirname, '../pages/RepoDetailPage.tsx'), 'utf8')
assert.match(page, /title=\{activeAlert.confirmButton\}\s+role="destructive"/)
assert.match(page, /title="取消"\s+role="cancel"/)
async function main() {
  const calls = [], errors = []
  const { useRepoPendingActions } = load('hooks/useRepoPendingActions.ts', {
    scripting: ui,
    '../services/gitService': { restoreFile: async (_, path) => calls.push(path) },
    '../utils/format': {},
  })
  const props = { bookmarkName: 'repo', beginOpBusy: async title => assert.equal(title, '正在还原改动'), reloadRepo: async () => calls.push('refresh'), endOpBusy() {}, showToast: (...args) => errors.push(args) }
  const h = mount(useRepoPendingActions, props)
  for (const action of [file, folder]) {
    calls.length = 0
    h.tree.setPending(action); h.render()
    // Opening the confirmation does not execute any mutation.
    assert.deepEqual(calls, [])
    await h.tree.runPending()
    assert.deepEqual(calls, [...(action.filepaths ?? [action.filepath]), 'refresh'])
  }
  calls.length = 0
  h.tree.setPending(folder); h.render(); h.tree.clearPending(); h.render(); await h.tree.runPending()
  assert.deepEqual(calls, [])
  assert.deepEqual(errors, [])
  h.unmount()
  console.log('PASS 文件与文件夹共用还原标题、红色确认按钮、取消行为和确认后执行流程')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
