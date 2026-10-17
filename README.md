# scripgit

在 iPhone 的 Scripting App 中管理本地 Git 仓库，并浏览、编辑 GitHub 远端文件。当前版本 **1.1.0**。

## 导入

先安装并打开 [Scripting](https://scriptingapp.github.io/)，然后在 iPhone 上打开以下链接，确认导入脚本：

https://scripting.fun/import_scripts?urls=["https%3A%2F%2Fgithub.com%2FWangsc1%2Fscripgit"]

也可以将仓库文件完整导入 Scripting，脚本目录命名为 `scripgit`，保留 `vendor`、`services` 等子目录及 `script.json`；入口是 `index.tsx`。不要只复制入口文件。

## 功能

- 本地仓库添加、初始化、克隆及状态摘要；查看文件、改动、差异与提交历史。
- 分支、暂存、提交、推送、拉取、远端管理、冲突处理、回滚与差异对比。
- GitHub Issues、Pull Requests 与 Actions 浏览及相关操作。
- **GitHub 远端文件编辑**：无需克隆，选择仓库、分支与目录，加载现有 UTF-8 文本，填写提交消息后直接提交到指定分支。
- 状态小组件及同步通知。

## 使用

1. 在「设置」配置 GitHub Token，并验证账号；本地 Git 提交可另外设置姓名和邮箱。
2. 本地 Git：从仓库页右上角「+」添加本地目录或克隆，按提示授予文件夹访问权限。
3. 远端编辑：在仓库首页点「GitHub 远端文件浏览与编辑」，加载自己的仓库列表，或填写 `owner/repo` 后打开。已有 GitHub 远端的本地仓库也可从详情页「GitHub → 远端文件编辑」进入。
4. 选择分支，点目录逐级浏览，打开文件后在全屏编辑器中修改，填写提交消息，点「提交保存」。关闭前如有未保存修改会要求确认；取消可继续编辑。

### 保存与只读限制

- 使用 GitHub Contents API，保存请求携带**加载时的文件 SHA**。他人更新同一文件后，GitHub 会拒绝过期 SHA 的保存；不会自动重试覆盖。
- 保存失败会保留编辑器中的草稿与原 SHA。冲突时先复制草稿，关闭后重新打开文件，比较最新内容再修改提交；网络超时也请核对远端是否已提交。
- 只编辑现有普通文件；二进制、非无损 UTF-8、符号链接、子模块、超过 **512 KiB** 或 API 未提供内容的文件只读。每个目录最多显示 GitHub Contents API 返回的 1000 项。
- 受保护分支、仓库写权限或组织策略可能阻止提交；可改选有写权限的分支，本功能不自动创建分支或 Pull Request。
- 远端提交**不会同步本地工作区**，需要时请在本地仓库中拉取。草稿仅保存在当前会话内，强制退出 App、系统回收或脚本停止不会持久化草稿，请先复制重要内容。

## Token 权限与安全

优先使用 **Fine-grained personal access token**，只授权需要操作的仓库：

- 文件浏览：Repository permissions → **Contents: Read-only**。
- 文件保存：**Contents: Read and write**；仓库 Metadata 读取通常自动授予。
- 编辑 `.github/workflows/` 下的工作流文件可能还需要 **Workflows: Read and write**。
- Issues、Pull Requests、Actions 等功能根据操作另需相应的读取或写入权限；组织仓库可能需要组织审批/SSO 授权。

使用 Classic PAT 时，公开仓库写入通常需要 `public_repo`，私有仓库通常需要 `repo`；修改工作流还需 `workflow`。按最小权限配置，不要把 Token 写入代码、仓库或提交消息。

Token 通过 App 的系统 Keychain 存取。权限不足、Token 过期、网络失败及 API 限流会显示错误，可检查权限后重试。

## 本地检查

需要 Node.js；测试依赖仅安装到临时目录，不属于 iPhone 运行依赖：

```sh
npm install --prefix /tmp/scripgit-test-tools typescript
NODE_PATH=/tmp/scripgit-test-tools/node_modules node tests/remoteFiles.test.cjs
```

测试使用 mock GitHub HTTP、Scripting UI、Data 与编辑器，不会向 GitHub 写入。覆盖分支/路径编码、文本读取、只读识别、SHA 保存与冲突、草稿保留、重复保存、退出确认及浏览交互，并进行 TypeScript/TSX 语法检查。

**本地环境不能验证 iOS 真机 UI、原生编辑器焦点/键盘、全屏弹层手势和真实 GitHub 写入权限。** 导入后应在测试仓库实际检查这些交互，再编辑重要文件。
