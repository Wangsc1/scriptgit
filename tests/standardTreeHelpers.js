// Assertions against the actual standard Button row output, not a DisclosureGroup mock.
const isFolderRow = n => n?.type === 'Button' && String(n.props.accessibilityLabel || '').startsWith('文件夹 ')
const folderExpanded = n => n.children[0].children.find(x => x.type === 'Image' && x.props.systemName === 'chevron.right').props.rotationEffect === 90
module.exports = { isFolderRow, folderExpanded }
