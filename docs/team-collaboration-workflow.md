# 团队协作与 Git 工作流

这份文档定义本项目的团队协作方式、分支规则、提交规则、PR 规则和常用命令。后续项目开发时，以这份文档为准。

## 1. 仓库信息

仓库地址：

```text
git@github.com:NoMooncake/Popular-Video-Structure-Transfer-Engine.git
```

网页地址：

```text
https://github.com/NoMooncake/Popular-Video-Structure-Transfer-Engine
```

仓库可见性：Private

默认分支：`main`

日常开发分支：`dev`

## 2. 分支模型

本项目使用三类分支：

- `main`：稳定分支，只放最终可展示、可提交的版本。
- `dev`：日常集成分支，所有功能先合并到这里。
- `feature/xxx`：个人功能分支，从 `dev` 创建。

合并方向：

```text
feature/xxx -> dev -> main
```

## 3. main 分支规则

`main` 是稳定分支。

规则：

1. 不直接在 `main` 上开发。
2. 不直接 push 到 `main`。
3. 只有当 `dev` 已经可以演示、可以提交时，才从 `dev` 合并到 `main`。
4. Demo 前最后检查通过后，再合并到 `main`。

查看当前分支：

```bash
git branch
```

切到 `main`：

```bash
git checkout main
```

拉取 `main` 最新代码：

```bash
git pull origin main
```

## 4. dev 分支规则

`dev` 是团队日常集成分支。

规则：

1. 每个人开始新任务前，都先从 `dev` 拉最新代码。
2. 正常功能开发通过 PR 合并到 `dev`。
3. 如果临时约定可以直接改 `dev`，提交前必须确认工作区干净、改动范围明确。
4. `dev` 如果跑不起来，优先修复，不继续叠新功能。

切到 `dev`：

```bash
git checkout dev
```

拉取远程 `dev`：

```bash
git pull origin dev
```

查看本地 `dev` 是否落后远程：

```bash
git status
```

推送 `dev`：

```bash
git push origin dev
```

## 5. feature 分支规则

正常开发时，每个功能都从 `dev` 创建 feature 分支。

命名格式：

```text
feature/任务名
```

推荐命名：

```text
feature/video-parser
feature/structure-extractor
feature/frontend-upload-flow
feature/material-analyzer
feature/gap-detector
feature/timeline-preview
feature/agent-revision
feature/demo-case
```

不推荐：

```text
test
abc
my-branch
new
final
```

从 `dev` 创建 feature 分支：

```bash
git checkout dev
git pull origin dev
git checkout -b feature/你的任务名
```

推送 feature 分支：

```bash
git push -u origin feature/你的任务名
```

## 6. 标准开发流程

### 6.1 开始任务

```bash
git checkout dev
git pull origin dev
git checkout -b feature/你的任务名
```

### 6.2 开发过程中查看状态

```bash
git status
```

查看具体改动：

```bash
git diff
```

查看某个文件改动：

```bash
git diff 文件名
```

### 6.3 提交代码

添加单个文件：

```bash
git add 文件名
```

添加多个文件：

```bash
git add 文件1 文件2 文件3
```

添加全部改动：

```bash
git add .
```

提交：

```bash
git commit -m "简短说明这次改了什么"
```

### 6.4 推送代码

第一次推送当前分支：

```bash
git push -u origin 当前分支名
```

之后继续推送同一个分支：

```bash
git push
```

或者明确写：

```bash
git push origin 当前分支名
```

### 6.5 创建 PR

在 GitHub 网页创建 PR：

- base：`dev`
- compare：你的 `feature/xxx`

PR 标题建议：

```text
add sample upload flow
implement gap detection schema
fix timeline preview layout
```

PR 描述建议包含：

```markdown
## 改动
- 写清楚改了什么

## 测试
- 写清楚怎么验证

## 风险
- 写清楚可能影响什么

## 未完成
- 写清楚哪些点后续再做
```

## 7. 当前允许直接修改 dev 的场景

项目初期，如果团队明确说“这次直接在 `dev` 上改”，可以不创建 feature 分支。

直接改 `dev` 的流程：

```bash
git checkout dev
git pull origin dev
git status
```

确认当前没有未提交改动后，开始修改文件。

修改后检查：

```bash
git status
git diff
```

提交：

```bash
git add .
git commit -m "提交说明"
git push origin dev
```

直接改 `dev` 时要注意：

1. 一次提交只做一类事情。
2. 提交前一定看 `git diff`。
3. 不要把临时文件、素材文件、真实密钥提交进去。
4. 如果改动比较大，仍然建议开 feature 分支。

## 8. Demo 前合并流程

当 `dev` 已经可以演示时，创建 PR：

```text
dev -> main
```

合并前检查：

1. 本地能启动。
2. README 运行方式正确。
3. `.env.example` 有需要的变量名。
4. 没有真实 API Key。
5. 核心 Demo 流程能跑通。
6. Demo case、截图、视频产物路径清楚。
7. `dev` 没有明显未完成的破坏性代码。

本地验证命令后续会按项目技术栈补充，例如：

```bash
npm install
npm run dev
npm test
```

## 9. 提交信息规范

提交信息用英文或中文都可以，但必须具体。

推荐：

```bash
git commit -m "add github beginner guide"
git commit -m "create structure blueprint schema"
git commit -m "implement sample video upload"
git commit -m "fix material matching result display"
```

不推荐：

```bash
git commit -m "update"
git commit -m "fix"
git commit -m "wip"
git commit -m "final"
```

## 10. 代码提交前检查清单

提交前执行：

```bash
git status
git diff
```

检查：

- 是否只改了这次任务相关文件。
- 是否误提交了 `.env`。
- 是否误提交了大文件。
- 是否误提交了调试输出。
- 是否提交信息能看懂。

如果已经 `git add` 了，但想看 staged 内容：

```bash
git diff --cached
```

## 11. 常见问题处理

### 11.1 分支切错了

先看状态：

```bash
git status
git branch
```

如果还没有 commit，不要乱删文件，把输出发给队友。

### 11.2 想撤销某个文件的未提交修改

这个操作会丢掉本地改动，执行前要确认。

```bash
git restore 文件名
```

如果不确定，不要执行，先问队友。

### 11.3 已经 git add 了，想取消 add

```bash
git restore --staged 文件名
```

取消全部 staged 文件：

```bash
git restore --staged .
```

### 11.4 pull 时遇到冲突

先看冲突文件：

```bash
git status
```

打开冲突文件，会看到类似：

```text
<<<<<<< HEAD
本地内容
=======
远程内容
>>>>>>> branch-name
```

手动决定保留哪部分，删掉冲突标记，然后：

```bash
git add 冲突文件
git commit -m "resolve merge conflict"
```

如果不会处理，把 `git status` 输出和冲突文件名发到群里。

### 11.5 本地分支太多了

查看分支：

```bash
git branch
```

删除已经合并的本地分支：

```bash
git branch -d feature/分支名
```

不要删除不确定是否已合并的分支。

## 12. 安全规则

不要提交：

- `.env`
- API Key
- GitHub token
- 账号密码
- 未授权视频素材
- 大体积临时文件
- `node_modules/`
- 构建产物和缓存

后续仓库会增加 `.gitignore`，但每个人提交前仍然要自己检查。

## 13. 建议分工

初期三人可以按模块分：

- 同学 A：前端页面、上传流程、迁移过程可视化。
- 同学 B：后端 API、JSON Schema、文件管理、视频处理接口。
- 同学 C：Prompt、结构拆解、素材缺口识别、Demo case 和演示材料。

后续按任务拆分 issue 或 PR，每个任务尽量小而清楚。

