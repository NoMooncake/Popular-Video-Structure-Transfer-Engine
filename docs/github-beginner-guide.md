# GitHub 小白使用手册

这份文档写给第一次使用 GitHub 的队友。目标是让你知道如何注册账号、加入私有仓库、把代码下载到本地、提交自己的修改，以及遇到问题时该怎么沟通。

## 1. GitHub 是什么

GitHub 可以理解成一个线上代码协作平台。我们会把项目代码放在 GitHub 的私有仓库里，只有被邀请的队员可以访问。

常见概念：

- Repository，简称 repo，项目仓库。
- Commit，一次保存记录，类似“存档点”。
- Branch，分支，不同人可以在不同分支上开发。
- Pull Request，简称 PR，请求把一个分支的改动合并到另一个分支。
- Clone，把 GitHub 上的仓库下载到自己的电脑。
- Pull，把 GitHub 上的新代码拉到本地。
- Push，把自己本地提交上传到 GitHub。

## 2. 注册 GitHub 账号

1. 打开 https://github.com
2. 点击 Sign up。
3. 用邮箱注册账号。
4. 完成邮箱验证。
5. 记住自己的 GitHub username。

username 不是邮箱，也不是昵称，而是个人主页链接里的名字。

例如个人主页是：

```text
https://github.com/octocat
```

那么 username 就是：

```text
octocat
```

加入本项目时，请把 username 发给队长。

## 3. 安装 Git

Git 是本地管理代码版本的工具。GitHub 是线上平台，Git 是电脑上的命令行工具。

### 3.1 macOS

打开终端，执行：

```bash
git --version
```

如果系统提示安装 Command Line Tools，按提示安装即可。

### 3.2 Windows

下载并安装 Git：

https://git-scm.com/downloads

安装后打开 Git Bash 或终端，执行：

```bash
git --version
```

能看到版本号就说明安装成功。

## 4. 配置 Git 用户信息

第一次使用 Git 时，需要配置名字和邮箱。邮箱建议使用 GitHub 注册邮箱。

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

查看配置：

```bash
git config --global --list
```

如果配置错了，可以重新执行上面的命令覆盖。

## 5. 加入本项目私有仓库

本项目仓库是 Private，只有被邀请的人能访问。

你需要做：

1. 把 GitHub username 发给队长。
2. 等队长邀请你成为 collaborator。
3. 打开 GitHub 通知或邀请邮件。
4. 点击 Accept invitation。
5. 打开仓库链接，确认自己能看到代码。

如果打不开仓库，优先检查：

- 是否接受了邀请。
- 当前登录的 GitHub 账号是否正确。
- 发给你的仓库链接是否正确。

## 6. 下载项目到本地

进入仓库页面，点击绿色的 Code 按钮，复制仓库地址。

如果你用 HTTPS，地址类似：

```text
https://github.com/NoMooncake/Popular-Video-Structure-Transfer-Engine.git
```

如果你用 SSH，地址类似：

```text
git@github.com:NoMooncake/Popular-Video-Structure-Transfer-Engine.git
```

选择一个本地目录，执行：

```bash
git clone 仓库地址
cd Popular-Video-Structure-Transfer-Engine
```

例如：

```bash
git clone git@github.com:NoMooncake/Popular-Video-Structure-Transfer-Engine.git
cd Popular-Video-Structure-Transfer-Engine
```

## 7. 每天开始写代码前

先确认自己在哪个目录：

```bash
pwd
```

确认当前仓库状态：

```bash
git status
```

切到 `dev` 并拉取最新代码：

```bash
git checkout dev
git pull origin dev
```

如果你要开发一个新功能，正常情况下应该从 `dev` 创建自己的功能分支：

```bash
git checkout -b feature/你的任务名
```

例如：

```bash
git checkout -b feature/video-upload
```

## 8. 提交自己的修改

查看哪些文件被改了：

```bash
git status
```

查看具体改动：

```bash
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

推荐提交信息：

```bash
git commit -m "add sample upload page"
git commit -m "implement gap report schema"
git commit -m "fix timeline preview layout"
```

不推荐：

```bash
git commit -m "update"
git commit -m "fix"
git commit -m "final"
```

上传到 GitHub：

```bash
git push origin 当前分支名
```

例如：

```bash
git push origin feature/video-upload
```

## 9. 创建 Pull Request

上传功能分支后，打开 GitHub 仓库页面，通常会看到 Create pull request 按钮。

创建 PR 时：

- base 选择 `dev`
- compare 选择你的 `feature/xxx`
- 标题写清楚做了什么
- 描述里写清楚改动范围、测试方式、还没完成的点

PR 描述可以这样写：

```markdown
## 改动
- 增加样例视频上传入口
- 增加上传状态展示

## 测试
- 本地启动前端后手动上传 mp4 文件

## 注意
- 后端接口还没接真实解析服务，目前是 mock 数据
```

## 10. 常用命令速查

查看状态：

```bash
git status
```

查看分支：

```bash
git branch
```

查看所有本地和远程分支：

```bash
git branch -a
```

切换分支：

```bash
git checkout 分支名
```

创建并切换分支：

```bash
git checkout -b feature/任务名
```

拉取远程代码：

```bash
git pull origin 分支名
```

查看改动：

```bash
git diff
```

添加文件：

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

查看远程仓库地址：

```bash
git remote -v
```

## 11. 常见问题

### 11.1 我改错分支了怎么办

先不要删除文件，也不要乱试命令。执行：

```bash
git status
git branch
```

把输出截图发到群里，说明你本来想在哪个分支改。

### 11.2 pull 的时候冲突了怎么办

如果终端出现 conflict，不要直接乱删冲突内容。先执行：

```bash
git status
```

把输出发到群里。冲突不是代码坏了，只是两个人改到了同一个文件或同一段内容，需要人工选择保留哪部分。

### 11.3 API Key 能不能提交

不能。

真实 API Key、账号密码、访问 token 都不能提交到 GitHub。后续如果有 `.env` 文件，只能放在本地，不要提交。

可以提交 `.env.example`，但里面只能写变量名，不能写真值：

```text
LLM_API_KEY=
SEEDANCE_API_KEY=
UPLOAD_DIR=
OUTPUT_DIR=
```

### 11.4 不知道该不该提交某个文件怎么办

先问队友。一般不要提交：

- `.env`
- `node_modules/`
- 大视频素材
- 临时导出文件
- 系统自动生成的缓存文件

后续仓库会用 `.gitignore` 统一排除这些文件。

