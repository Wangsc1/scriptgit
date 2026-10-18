/** FileManager.remove is recursive, including createFS.rmdir: NEVER use it here.
 * Official Scripting App Store/TestFlight docs (2026-10-18): Python.run supports
 * embedded Python. Require real os.rmdir + dir_fd/O_NOFOLLOW; fail closed if absent.
 * No shell interpolation, rm -r, native extension, or guessed FileManager overload.
 */
export type DirectoryIdentity = { path: string; dev: number; ino: number }
export type EmptyDirectoryPlan = { rootDev: number; rootIno: number; directories: DirectoryIdentity[]; retained: string[] }
export const EMPTY_DIRECTORY_PYTHON = `
import os, json, stat
p=json.loads(json.loads(os.environ['SCRIPTING_QUERY_PARAMETERS'])['payload'])
if not all(f in os.supports_dir_fd for f in (os.open,os.stat,os.rmdir,os.unlink)) or not hasattr(os,'O_NOFOLLOW') or os.listdir not in os.supports_fd:
    raise RuntimeError('安全非递归 rmdir/dir_fd/O_NOFOLLOW 不可用')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
root=os.open(p['root'], flags)
try:
    rs=os.fstat(root)
    expected=p.get('expected')
    if expected and (rs.st_dev!=expected['rootDev'] or rs.st_ino!=expected['rootIno']):
        raise RuntimeError('工作区身份已改变，请重新确认')
    def parent(path):
        parts=path.split('/')
        if any(not c or c in ('.','..') or c.lower()=='.git' or '\\\\' in c or any(ord(v)<32 for v in c) for c in parts):
            raise RuntimeError('不安全的目录路径')
        fd=os.dup(root)
        try:
            for c in parts[:-1]:
                nxt=os.open(c,flags,dir_fd=fd)
                os.close(fd);fd=nxt
                if any(n.lower()=='.git' for n in os.listdir(fd)):
                    raise RuntimeError('嵌套 Git 仓库不允许清理')
            return fd,parts[-1]
        except:
            os.close(fd);raise
    eligible=[];retained=[];virtual=set()
    files=set(p.get('files',[]))
    identities={d['path']:d for d in expected['directories']} if expected else {}
    for path in sorted(set(p['paths']),key=lambda x:(-x.count('/'),x)):
        fd=None;child=None
        try:
            fd,name=parent(path)
            st=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if p['mode']=='unlink':
                if not stat.S_ISREG(st.st_mode):raise RuntimeError('待还原文件不是普通文件，未删除')
                os.unlink(name,dir_fd=fd)
                continue
            if not stat.S_ISDIR(st.st_mode):raise RuntimeError('目录变为符号链接或非目录')
            old=identities.get(path)
            if expected and (not old or st.st_dev!=old['dev'] or st.st_ino!=old['ino']):raise RuntimeError('目录身份已改变')
            child=os.open(name,flags,dir_fd=fd)
            actual=os.fstat(child)
            if (actual.st_dev,actual.st_ino)!=(st.st_dev,st.st_ino):raise RuntimeError('目录并发变化')
            names=os.listdir(child)
            if p['mode']!='delete':
                empty=all(path+'/'+n in virtual or (path+'/'+n in files and stat.S_ISREG(os.stat(n,dir_fd=child,follow_symlinks=False).st_mode)) for n in names)
            else:empty=not names
            if not empty:
                if p['mode']=='verify':raise RuntimeError('目录已非空，请重新确认')
                retained.append(path+'（非空，已保留）');continue
            if p['mode']=='delete':
                # Atomic kernel nonrecursive removal: concurrent new contents => ENOTEMPTY.
                os.rmdir(name,dir_fd=fd)
            virtual.add(path)
            eligible.append({'path':path,'dev':st.st_dev,'ino':st.st_ino})
        except FileNotFoundError:
            if p['mode'] in ('delete','unlink'):continue
            raise RuntimeError('目录已消失，请重新确认')
        except Exception as e:
            if p['mode']=='delete':retained.append(path+'（变化或非空，已保留）')
            else:raise
        finally:
            if child is not None:os.close(child)
            if fd is not None:os.close(fd)
    print(json.dumps({'rootDev':rs.st_dev,'rootIno':rs.st_ino,'directories':eligible,'retained':retained}))
finally:os.close(root)
`

export async function inspectEmptyDirectories(root: string, paths: string[], mode: "preview" | "verify" | "delete" | "unlink", expected?: EmptyDirectoryPlan, files: string[] = []): Promise<EmptyDirectoryPlan> {
  const python = (globalThis as any).Python
  if (typeof python?.run !== "function") throw new Error("当前 Scripting 不支持安全非递归目录删除（需要 Python.run）；未使用递归删除代替。请更新 Scripting。")
  const result = await python.run(EMPTY_DIRECTORY_PYTHON, { queryParameters: { payload: JSON.stringify({ root, paths, mode, expected, files }) } })
  if (result.exitCode !== 0) throw new Error("安全空目录检查/删除失败，未使用递归删除代替。" + String(result.output || "Python rmdir 不可用"))
  try {
    const value = JSON.parse(result.output.trim())
    if (!Array.isArray(value.directories) || !Array.isArray(value.retained) || typeof value.rootIno !== "number") throw new Error("invalid")
    return value
  } catch (_) { throw new Error("安全目录操作返回结果不可确认，请刷新检查实际状态") }
}
