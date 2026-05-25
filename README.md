# 爆款结构迁移引擎协作指南

项目名称：爆款结构迁移引擎：样例驱动的视频结构迁移与 AI 改片 Agent

团队名称：随机队友生成队

这份文档给第一次使用 GitHub 的队友看。它包含三部分：

1. 如何注册和配置 GitHub
2. 如何参与这个项目的协作
3. 我们团队的分支工作流和常用命令

## 1. GitHub 是什么

GitHub 可以理解成一个代码协作平台。我们会把项目代码放在一个私有仓库里，只有被邀请的三位队员可以访问。

几个常见概念：

- Repository，简称 repo，意思是一个项目仓库。
- Commit，意思是一次保存记录。
- Branch，意思是分支。不同人可以在不同分支上开发，互不影响。
- Pull Request，简称 PR，意思是请求把一个分支的改动合并到另一个分支。
- Clone，意思是把 GitHub 上的仓库下载到自己的电脑。
- Push，意思是把自己电脑上的改动上传到 GitHub。
- Pull，意思是把 GitHub 上别人提交的新改动拉到自己的电脑。

## 2. 第一次使用 GitHub

### 2.1 注册账号

1. 打开 https://github.com
2. 点击 Sign up
3. 用邮箱注册账号
4. 记住自己的 GitHub 用户名，后续需要发给队长邀请进私有仓库

### 2.2 安装 Git

Git 是本地管理代码版本的工具。GitHub 是线上托管平台，Git 是你电脑上的命令行工具。

macOS 可以在终端执行：

```bash
git --version
```

如果系统提示安装 Command Line Tools，按提示安装即可。

Windows 推荐安装：

https://git-scm.com/downloads

安装后打开 Git Bash 或终端，执行：

```bash
git --version
```

能看到版本号就说明安装成功。

### 2.3 配置 Git 用户信息

第一次使用 Git 时，配置自己的名字和邮箱。邮箱建议和 GitHub 注册邮箱一致。

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

查看配置：

```bash
git config --global --list
```

### 2.4 登录 GitHub

如果使用 GitHub CLI，可以安装后执行：

```bash
gh auth login
```

按提示选择：

- GitHub.com
- HTTPS
- Login with a web browser

如果暂时不用 GitHub CLI，也可以直接用 GitHub 网页完成 PR、评论和代码查看。

## 3. 加入本项目仓库

仓库会设置为 Private。队长创建仓库后，会邀请另外两位队友。

队友需要做：

1. 把自己的 GitHub 用户名发给队长。
2. 收到 GitHub 邀请邮件或站内通知后点击 Accept invitation。
3. 进入仓库页面，确认可以看到代码。

如果打不开仓库，通常有三种原因：

- 没有接受邀请
- 登录的不是被邀请的 GitHub 账号
- 仓库链接写错

## 4. 下载项目到本地

进入 GitHub 仓库页面，点击绿色的 Code 按钮，复制 HTTPS 地址。

然后在电脑上选择一个目录，执行：

```bash
git clone 仓库地址
cd 仓库文件夹名
```

例如：

```bash
git clone https://github.com/你的用户名/viral-structure-transfer.git
cd viral-structure-transfer
```

## 5. 我们团队的分支工作流

本项目使用三类分支：

- `main`：稳定分支，只放最终可展示、可提交的版本。
- `dev`：日常集成分支，大家完成的功能先合并到这里。
- `feature/xxx`：个人功能分支，每个人开发具体任务时从 `dev` 拉出来。

### 5.1 分支职责

`main` 分支：

- 保持稳定。
- 不直接在上面开发。
- Demo 前从 `dev` 合并过来。

`dev` 分支：

- 集成大家的阶段性成果。
- 每个功能完成后，通过 PR 合并到 `dev`。
- 如果 `dev` 挂了，优先修复。

`feature/xxx` 分支：

- 每个人自己的开发分支。
- 从 `dev` 创建。
- 命名要能看出任务内容。

推荐命名：

```text
feature/video-parser
feature/structure-extractor
feature/frontend-upload-flow
feature/gap-detector
feature/timeline-preview
feature/agent-revision
```

不要使用：

```text
test
my-branch
abc
final
```

这些名字看不出分支用途。

### 5.2 标准开发流程

每次开始写代码前，先切到 `dev` 并更新：

```bash
git checkout dev
git pull origin dev
```

从 `dev` 创建自己的功能分支：

```bash
git checkout -b feature/你的任务名
```

写完一部分后，查看改动：

```bash
git status
git diff
```

添加要提交的文件：

```bash
git add 文件名
```

如果确认所有改动都要提交：

```bash
git add .
```

提交改动：

```bash
git commit -m "简短说明这次改了什么"
```

上传自己的分支：

```bash
git push origin feature/你的任务名
```

然后去 GitHub 网页创建 Pull Request：

- base 选择 `dev`
- compare 选择自己的 `feature/你的任务名`
- 标题写清楚这次做了什么
- 描述里写测试方式、影响范围、还有没做完的点

### 5.3 PR 合并规则

我们的合并方向是：

```text
feature/xxx -> dev -> main
```

规则：

1. 不直接 push 到 `main`。
2. 不直接 push 到 `dev`，除非是紧急修复且队友已确认。
3. 每个 PR 尽量只做一件事。
4. PR 合并前至少让一位队友看一眼。
5. 合并前本地要能跑起来，不能把明显跑不起来的代码合进 `dev`。

### 5.4 Demo 前合并到 main

当 `dev` 上的版本已经可以演示时，由一位同学创建 PR：

```text
dev -> main
```

合并前检查：

- README 运行方式是否正确
- 环境变量是否写在 `.env.example`，不要把真实 API Key 提交
- 前端能打开
- 后端接口能启动
- 核心流程能演示
- Demo case 文件和截图视频路径能找到

## 6. 常用 Git 命令

查看当前在哪个分支、哪些文件改了：

```bash
git status
```

查看当前分支：

```bash
git branch
```

切换分支：

```bash
git checkout 分支名
```

创建并切换到新分支：

```bash
git checkout -b feature/任务名
```

拉取远程最新代码：

```bash
git pull origin 分支名
```

查看具体改了什么：

```bash
git diff
```

添加文件到提交区：

```bash
git add 文件名
```

提交：

```bash
git commit -m "提交说明"
```

推送：

```bash
git push origin 分支名
```

查看提交历史：

```bash
git log --oneline
```

## 7. 常见问题

### 7.1 我改错分支了怎么办

先不要慌，也不要乱删文件。先执行：

```bash
git status
```

把输出截图发到群里，说明你本来想在哪个分支改。队友可以帮你把改动移动到正确分支。

### 7.2 pull 的时候冲突了怎么办

如果看到 conflict 或冲突提示，先停止操作，把终端输出发给队友。

冲突不是代码坏了，只是两个人改到了同一个地方，需要人工决定保留哪部分。

### 7.3 API Key 能不能提交

不能。

真实 API Key 只能放在本地 `.env` 文件里。后续仓库里可以提供 `.env.example`，只写变量名，不写真实密钥。

错误示例：

```text
LLM_API_KEY=sk-真实密钥
```

正确示例：

```text
LLM_API_KEY=
SEEDANCE_API_KEY=
```

### 7.4 提交信息怎么写

提交信息要短，但要说清楚做了什么。

推荐：

```bash
git commit -m "add sample video analysis schema"
git commit -m "implement timeline preview layout"
git commit -m "fix upload error handling"
```

不推荐：

```bash
git commit -m "update"
git commit -m "fix"
git commit -m "final"
```

## 8. 本项目建议分工方式

三个人可以先按模块分：

- 同学 A：前端页面和流程可视化
- 同学 B：后端 API、JSON Schema、文件上传
- 同学 C：AI Prompt、结构拆解、缺口识别、Demo case

每个人都从 `dev` 创建自己的 `feature/xxx` 分支。合并时通过 PR 进入 `dev`。

## 9. 当前阶段最重要的协作原则

1. 先把 P0 闭环跑通，再做 P1 亮点。
2. 每次提交尽量小一点，方便队友 review。
3. 不提交真实 API Key、账号密码、未授权素材。
4. 遇到 Git 问题先发 `git status`，不要随手删除或重置。
5. Demo 前所有代码统一从 `dev` 合并到 `main`。
