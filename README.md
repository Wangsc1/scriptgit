# scriptgit

在 iPhone 的 Scripting App 中管理本地 Git 仓库，并浏览、编辑 GitHub 远端文件。当前版本 **1.2.6**。

## 导入

先安装并打开 [Scripting](https://scriptingapp.github.io/)，然后在 iPhone 上打开以下链接，确认导入脚本：

https://scripting.fun/import_scripts?urls=["https%3A%2F%2Fgithub.com%2FWangsc1%2Fscriptgit"]

也可以将仓库文件完整导入 Scripting，脚本目录命名为 `scriptgit`，保留 `vendor`、`services` 等子目录及 `script.json`；入口是 `index.tsx`。不要只复制入口文件。

## 功能

- 本地仓库添加、初始化、克隆及状态摘要；查看文件、改动、差异与提交历史。
- **按 GitHub 用户名批量添加**：分页加载该用户拥有且当前凭据可访问的全部仓库，未克隆默认勾选，可逐项选择，确认数量和目录后依次克隆并注册到本地列表。
- 分支、暂存、提交、推送、拉取、远端管理、冲突处理、回滚与差异对比。
- GitHub Issues、Pull Requests 与 Actions 浏览及相关操作。
- **GitHub 远端文件编辑**：无需克隆，选择仓库、分支与目录，加载现有 UTF-8 文本，填写提交消息后直接提交到指定分支。
- 状态小组件及同步通知；仓库页和设置页左上角关闭叉号为黑色。

## 使用

1. 公开用户搜索、按用户名加载公开仓库与克隆公开仓库**不需要 Token**；私有仓库和远端写入需在「设置」配置并验证 GitHub Token。本地 Git 提交可另外设置姓名和邮箱。
2. 本地 Git：从仓库页右上角「+」添加本地目录或克隆。单个和批量克隆默认保存到 **iCloud Drive/Scripting/git/<repo>**，自动创建 `git` 文件夹；也可点「更改目录」选择父目录并授权，其下自动创建 `git`。
3. 远端编辑：在仓库首页点「GitHub 远端文件浏览与编辑」，加载自己的仓库列表，或填写 `owner/repo` 后打开。已有 GitHub 远端的本地仓库也可从详情页「GitHub → 远端文件编辑」进入。
4. 选择分支，点目录逐级浏览，打开文件后在全屏编辑器中修改，填写提交消息，点「提交保存」。关闭前如有未保存修改会要求确认；取消可继续编辑。

### 按用户名批量克隆

在「克隆仓库」页输入部分 GitHub 用户名（至少 2 个字母、数字或 `-`），停顿约 350ms 后自动搜索公开用户，显示头像与 login 候选；可加载更多候选。点候选后立即自动完整分页加载该用户的全部可访问仓库；也可手工填写有效完整用户名，停顿约 650ms 后自动加载。页面若带有有效初始用户名，也会自动加载。全量加载最多一个请求在途，输入变化时只保留最新目标；失败可点「重试仓库加载」。更改或清空输入会立即使旧仓库列表和选择失效，防止用旧用户名执行批量克隆。

用户候选来自 GitHub 用户搜索，**不是关联账号列表**；GitHub 最多提供前 1000 个匹配结果，结果过多或不完整时请细化关键词。完整分页加载仓库成功后，**未克隆默认勾选**；已在本地注册且 GitHub origin 匹配的仓库标注「已克隆」，默认不勾选，仍可手动选择。「全选」包含已克隆项，「取消全选」清空选择。识别忽略 owner/repo 大小写及 HTTPS/SSH、`.git` 形式差异，不按同名目录猜测、不额外逐仓联网；成功克隆后标记即时更新，重开加载时按持久记录识别。执行时原有同名/已存在目录安全跳过规则不变。点「克隆所选仓库」，核对用户名、范围、数量和目标目录后确认。

- **未配置 Token**：匿名分页加载该用户拥有的公开仓库，页面注明“仅公开仓库”，可直接匿名克隆；不请求当前账号或私有仓库接口。公开 fork 的详情读取也支持匿名。
- **已配置 Token**：用户搜索与仓库读取沿用认证；本人列表包含已授权私有仓库，其他用户公开仓库与当前账号有权访问、归该用户拥有的私有仓库合并去重。Token 无效、权限不足或后续分页失败会明确报错，**不会静默降级为公开列表**，也不会把半份仓库列表作为“全部”使用。
- 仓库选择列表不显示 GitHub 原始响应中 `disabled: true` 的已禁用仓库；不会删除已有本地注册或文件。未标禁用但详情返回 `Repository access blocked` 时会明确提示 GitHub 阻止访问及已知原因，配置 Token 不保证解除限制。
- 逐个显示 `当前项/总数` 和下载进度，逐项报告成功、失败、跳过或取消；单项失败后继续下一项。取消是协作式的，可能需要等待当前网络请求结束；已完成项目保留，未执行项目标为取消。
- 已存在的同名文件、文件夹（即使为空）、符号链接，以及忽略大小写后的同名项目都会跳过，不覆盖、不合并。重跑不会重复注册同一路径，也不会自动改名。
- 克隆先写入本次专用临时目录，完成后才移动到目标并注册；失败/取消只清理本次拥有的临时目录和 Git 缓存，绝不删除既有目标。若下载后注册失败，保留下载文件与缓存并显示提示，避免误删数据。

### 默认 iCloud 目录

使用官方 `FileManager.iCloudDocumentsDirectory` 获取 **Scripting 自有 iCloud 容器文稿目录**，在其下创建 `git`；不猜测系统绝对路径，也不额外拼接一个 `Scripting` 文件夹。该默认目录无需外部安全范围书签。

iCloud 未启用、未授权，或因离线/权限等原因导致目录不可用时会明确报错，**不会静默切换到本地 Documents**。请启用 iCloud Drive / Scripting 的 iCloud 权限后重试，或主动更改目录。外部目录仍通过系统目录选择器获取授权，并保存父目录书签及仓库相对路径。

### 重新进入与状态刷新

启动先显示已保存仓库和可操作入口，状态在后台逐仓刷新；顶部显示处理进度，失败或较慢的仓库会在对应行显示说明，可点「重试状态刷新」。上次快照只是摘要，不代表刚完成实时检查。

- 单仓界面等待约 10 秒后会标为“状态未确认”并继续处理其它仓库，不据此判定 iCloud 或目录失效，也不删除文件。
- 界面停止等待不等于原生读取已取消。原任务真实结束前重试会复用它；慢矩阵扫描最多使用两个不同仓库的槽位，两个读取都迟迟未结束时，其余仓库会明确显示暂未扫描，而不是无限转圈。
- 同一仓库的读写屏障保留到真实任务结束。写操作若等待读取超时，会提示“暂未执行写操作”，请稍后重试；不会把超时的写入排在后台随后偷偷执行。
- 批量克隆页面打开时，隐藏的仓库列表不为每个新增仓库提前堆积状态扫描；返回列表后再刷新。强制退出不会自动恢复克隆队列，也不会自动删除遗留文件。

如克隆失败，请保留「本次结果」中**仓库名及完整错误信息**的截图/文字。仅凭“失败”不能判断是认证、网络、目录权限还是其它原因，不建议直接删除仓库数据。若仍卡在加载，请同时说明是 Scripting 的启动加载页，还是已经进入 scriptgit 的仓库列表。

### 保存与只读限制

- 使用 GitHub Contents API，保存请求携带**加载时的文件 SHA**。他人更新同一文件后，GitHub 会拒绝过期 SHA 的保存；不会自动重试覆盖。
- 保存失败会保留编辑器中的草稿与原 SHA。冲突时先复制草稿，关闭后重新打开文件，比较最新内容再修改提交；网络超时也请核对远端是否已提交。
- 只编辑现有普通文件；二进制、非无损 UTF-8、符号链接、子模块、超过 **512 KiB** 或 API 未提供内容的文件只读。每个目录最多显示 GitHub Contents API 返回的 1000 项。
- 受保护分支、仓库写权限或组织策略可能阻止提交；可改选有写权限的分支，本功能不自动创建分支或 Pull Request。
- 远端提交**不会同步本地工作区**，需要时请在本地仓库中拉取。草稿仅保存在当前会话内，强制退出 App、系统回收或脚本停止不会持久化草稿，请先复制重要内容。

## Token 权限与安全

只做公开用户搜索、公开仓库加载与克隆时可以不配置 Token。匿名请求的 GitHub API 限额较低，搜索另有限流；触发限制会显示提示，请稍后重试，或配置 Token 提高限额。已配置但失效的 Token 应先更新或由用户主动清除，不会自动忽略。

需要私有仓库或远端写入时，优先使用 **Fine-grained personal access token**，只授权需要操作的仓库：

- 仓库读取、克隆和文件浏览：Repository permissions → **Contents: Read-only**。批量只能发现当前 Token 有权读取的仓库，私有仓库需要逐个或按所需范围授权。
- 文件保存：**Contents: Read and write**；仓库 Metadata 读取通常自动授予。
- 编辑 `.github/workflows/` 下的工作流文件可能还需要 **Workflows: Read and write**。
- Issues、Pull Requests、Actions 等功能根据操作另需相应的读取或写入权限；组织仓库可能需要组织审批/SSO 授权。

使用 Classic PAT 时，公开仓库写入通常需要 `public_repo`，私有仓库通常需要 `repo`；修改工作流还需 `workflow`。按最小权限配置，不要把 Token 写入代码、仓库或提交消息。

Token 通过 App 的系统 Keychain 存取。权限不足、Token 过期、网络失败及 API 限流会显示错误，可检查权限后重试。

## 本地检查

需要 Node.js；测试依赖仅安装到临时目录，不属于 iPhone 运行依赖：

```sh
npm install --prefix /tmp/scriptgit-test-tools typescript
NODE_PATH=/tmp/scriptgit-test-tools/node_modules node tests/remoteFiles.test.cjs
NODE_PATH=/tmp/scriptgit-test-tools/node_modules node tests/cloneQueue.test.cjs
NODE_PATH=/tmp/scriptgit-test-tools/node_modules node tests/anonymousClone.test.cjs
NODE_PATH=/tmp/scriptgit-test-tools/node_modules node tests/userSearch.test.cjs
NODE_PATH=/tmp/scriptgit-test-tools/node_modules node tests/startupRefresh.test.cjs
NODE_PATH=/tmp/scriptgit-test-tools/node_modules node tests/clonedSelection.test.cjs
NODE_PATH=/tmp/scriptgit-test-tools/node_modules node tests/autoRepoLoad.test.cjs
```

测试使用 mock GitHub HTTP、Scripting UI、Data、编辑器、内存文件系统与克隆引擎，不会向 GitHub 写入，也不会在服务器克隆用户仓库。覆盖全部分页（本人私有/他人公开与可访问私有）、iCloud 默认与不可用、外部目录权限及书签、批量成功/部分失败/跳过/取消/同名安全与重跑，以及文件编辑的 SHA 冲突、草稿保留、退出确认回归；同时验证无 Token 分页、页面到真实克隆服务/HTTP 认证路径（底层网络与引擎 mock）、Token 失败不降级、私有读取/写入门禁，以及用户候选搜索分页、防抖、旧响应丢弃、选择和用户名更改失效；还覆盖慢/失败仓库启动隔离、刷新重入、隐藏页新增仓库、超时不解锁与不重复扫描、真实写入保持屏障、Git 引擎首次加载单飞，以及既有状态缓存/协调器回归；进行 TypeScript/TSX 语法检查。

**本地环境不能验证 iOS 真机 UI、原生编辑器焦点/键盘、全屏弹层手势、真实 iCloud 同步/目录授权和 GitHub 实际克隆/写入权限。** 导入后应在测试仓库实际检查这些交互，再编辑重要文件。
