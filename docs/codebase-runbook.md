# 代码说明与运行手册

本文面向开发和演示运行，说明仓库结构、环境变量、启动方式、测试方式和常见调试入口。

## 目录结构

```text
.
├── apps
│   ├── api                 # Express + TypeScript 后端
│   └── web                 # React + Vite 前端
├── docs                    # 项目文档和接口契约
├── examples                # 示例案例
├── outputs                 # 本地生成产物，运行时创建
├── prompts                 # Prompt 草稿
├── schemas                 # 结构化 JSON schema
└── uploads                 # 本地上传文件，运行时创建
```

## 后端代码地图

主要代码在 `apps/api/src`。

| 路径 | 作用 |
| --- | --- |
| `app.ts` / `index.ts` | Express 应用和服务启动入口 |
| `routes/v2.routes.ts` | V2 主接口：样例分析、脚本会话、画布、生成、导出 |
| `services/v2PipelineService.ts` | V2 pipeline、生成、裁剪、最终拼接和 BGM |
| `services/v2ScriptCanvasService.ts` | 脚本页、结构迁移页、画布重校验 |
| `services/v2MaterialCandidatePoolService.ts` | 用户素材候选池、抽帧、素材片段理解 |
| `services/v2CanvasSessionService.ts` | 画布节点、缺口补全、画布导出 |
| `v2/providers/apiJsonClient.ts` | 外部 AI provider 请求封装 |
| `v2/referenceFrames.ts` | 样例视频抽帧 |
| `utils/ffmpeg.ts` | ffmpeg / ffprobe 调用 |
| `config/env.ts` | `.env` 读取 |
| `config/index.ts` | provider 和存储配置 |

P0 旧链路仍保留在 `sample.routes.ts`、`structure.routes.ts`、`pipeline.routes.ts` 以及对应 P0 service 中，主要用于早期 demo 和回归参考。

## 前端代码地图

主要代码在 `apps/web/src`。

| 路径 | 作用 |
| --- | --- |
| `App.tsx` | 前端入口组件 |
| `api/client.ts` | 调后端 API 的客户端封装 |
| `components/WorkspaceViews.tsx` | 工作台视图 |
| `components/VideoBlockCanvas.tsx` | 画布展示 |
| `components/InspectorPanel.tsx` | 右侧检查面板 |
| `data/workflow.ts` | 前端 demo 数据 |
| `styles.css` | 全局样式 |

## 环境要求

- Node.js 22 或兼容版本。
- npm。
- `ffmpeg` 和 `ffprobe` 在命令行可用。
- 如果要跑真实 provider，需要准备对应 API key。

检查 ffmpeg：

```bash
ffmpeg -version
ffprobe -version
```

## 安装依赖

后端和前端是两个独立 package，需要分别安装。

```bash
cd apps/api
npm install

cd ../web
npm install
```

## 环境变量

从仓库根目录复制模板：

```bash
cp .env.example .env
```

常用基础变量：

```bash
PORT=4000
UPLOAD_DIR=uploads
OUTPUT_DIR=outputs
MAX_UPLOAD_FILE_SIZE_MB=200
```

V2 provider 变量：

```bash
V2_MULTIMODAL_PROVIDER=xiaomi
V2_MULTIMODAL_API_BASE_URL=
V2_MULTIMODAL_API_PATH=/chat/completions
V2_MULTIMODAL_MODEL=
V2_MULTIMODAL_API_KEY=

V2_IMAGE_PROVIDER=volcengine_seedream
V2_IMAGE_API_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
V2_IMAGE_API_PATH=/images/generations
V2_IMAGE_MODEL=
V2_IMAGE_API_KEY=

V2_VIDEO_PROVIDER=seedance
V2_VIDEO_API_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
V2_VIDEO_API_PATH=/contents/generations/tasks
V2_VIDEO_MODEL=
V2_VIDEO_API_KEY=

V2_BGM_PROVIDER=modelslab
V2_BGM_API_BASE_URL=https://modelslab.com
V2_BGM_API_PATH=/api/v6/voice/music_gen
V2_BGM_MODEL=ai-music-generator
V2_BGM_API_KEY=
```

注意：

- `.env` 不要提交。
- `ARK_API_KEY` 可作为部分火山 provider 的 fallback key。
- `MODELSLAB_API_KEY` 也可作为 `V2_BGM_API_KEY` 的 fallback。
- 没有真实 key 时，部分 V2 能力会走 fallback；需要真实生成图片、视频、BGM 时必须配置 provider。

## 启动后端

```bash
cd apps/api
npm run dev
```

默认地址：

```text
http://localhost:4000
```

健康检查：

```bash
curl http://localhost:4000/api/health
curl http://localhost:4000/api/v2/status
```

如果端口冲突：

```bash
PORT=4018 npm run dev
```

## 启动前端

```bash
cd apps/web
npm run dev
```

默认地址：

```text
http://127.0.0.1:5173
```

如果前端需要连接非默认后端地址，优先检查 `apps/web/src/api/client.ts` 中的 base URL 配置。

## 构建与校验

后端：

```bash
cd apps/api
npm run typecheck
npm run build
npm test
```

前端：

```bash
cd apps/web
npm run build
```

当前最常用的 V2 回归测试：

```bash
cd apps/api
node --import tsx --test --test-concurrency=1 tests/v2Pipeline.test.ts
```

## V2 主要运行流程

真实业务链路通常按以下顺序调用：

1. 上传样例视频和用户素材：`POST /api/upload/videos`
2. 样例分析：`POST /api/v2/reference/analyze`
3. 结构迁移 / pipeline 分析：`POST /api/v2/pipeline/analyze`
4. 创建脚本会话：`POST /api/v2/script-sessions`
5. 用户编辑时长、旁白、添加素材：
   - `PATCH /api/v2/script-sessions/:sessionId/slots/:slotId`
   - `POST /api/v2/script-sessions/:sessionId/slots/:slotId/materials/uploaded-files`
6. 进入画布并重新判断素材覆盖：`POST /api/v2/canvas/revalidate`
7. 缺口补全：
   - `POST /api/v2/canvas-sessions/:canvasSessionId/image-candidates`
   - `POST /api/v2/canvas-sessions/:canvasSessionId/gap-video`
   - `GET /api/v2/generation/video-tasks/:taskId`
   - `POST /api/v2/canvas-sessions/:canvasSessionId/generated-videos/review-trim`
8. 最终导出：`POST /api/v2/canvas-sessions/:canvasSessionId/final-video`
9. 读取最终视频：`GET /api/v2/assembly/final-videos/:filename`

更完整字段见 [Backend API Contract](backend-api-contract.md)。

## 素材分配策略

当前 V2 画布采用保守策略：

- 10 秒以内素材保留为一个完整连续动作段。
- 10 秒以上素材按约 6 秒动作段粗切。
- 每个候选动作段最多抽 8 帧。
- 同一源视频默认只自动服务一个分镜，避免把一个完整倒茶、喝水或展示动作拆给多个分镜重复使用。
- 如果素材不足，会在画布上暴露缺口，由用户继续添加素材或触发 AI 补全。

用户后续在结构迁移页给某个分镜添加新素材后，再进入画布或触发 `canvas/revalidate`，也会走同一套素材分配逻辑。

## BGM 接入

最终导出支持全局 BGM。

当前 provider：

```text
V2_BGM_PROVIDER=modelslab
V2_BGM_API_PATH=/api/v6/voice/music_gen
```

实现细节：

- ModelsLab 最小时长要求为 30 秒，后端会请求至少 30 秒 BGM。
- 最终混音时按成片真实时长截断，并做淡出。
- `status=processing` 时不会直接下载 `future_links`，会轮询 `fetch_result` 到 `success` 后再下载 `output`。
- 如果 provider 失败，后端会 fallback 到本地合成测试音轨，并在 `audio_policy.final_bgm.provider_result.source` 中记录原因。

## 本地产物

运行时会写入：

| 目录 | 内容 |
| --- | --- |
| `uploads/` | 用户上传视频 |
| `outputs/v2-reference-frames` | 样例抽帧 |
| `outputs/v2-material-candidate-frames` | 用户素材候选帧 |
| `outputs/v2-material-candidate-pools` | 素材候选池 JSON |
| `outputs/v2-script-sessions` | 脚本会话 JSON |
| `outputs/v2-canvas-sessions` | 画布会话 JSON |
| `outputs/v2_generated_video_review` | 生成视频和裁剪结果 |
| `outputs/v2_final_assembly` | 最终拼接视频和 BGM 工作目录 |

这些目录是运行产物，不应作为源代码提交。

## 常见问题

### 生成视频时长和缺口不一致

图生视频 provider 可能只能生成固定时长。后端会在生成后做 review/trim，把剪入段裁到缺口时长。

### 进入导出时还有缺口

当前策略是未补全缺口不会自动生成占位视频；导出会拼接已有可用素材和已确认生成视频。如果请求中传了 `target_duration_seconds`，实际总时长不匹配会报错。

### 表格里显示素材不够但我上传过素材

进入画布时会重新按最新时长和最新素材重算。若同一源视频已经自动服务过另一个分镜，后续分镜不会继续自动复用它；需要上传新的素材或触发 AI 补全。

### ModelsLab 返回 404

不要下载 `processing` 阶段的 `future_links`。后端已实现轮询 `fetch_result`，只有 `success` 后才下载 `output`。

### 测试不应消耗外部额度

测试中应使用本地音频或 fallback，不依赖真实 provider。真实 provider 测试建议单独用 smoke 脚本执行。
