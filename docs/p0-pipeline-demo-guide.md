# P0 Pipeline Demo Guide

This runbook shows how to run the backend P0 demo locally. It intentionally does not include any API key, endpoint, or provider secret.

## What This Demo Proves

The backend can run the P0 flow:

1. Upload or provide sample video analysis.
2. Extract sample structure.
3. Normalize user material input.
4. Analyze user materials.
5. Map sample structure slots to user materials.
6. Detect material gaps.
7. Generate fill strategies.
8. Generate a 15-30 second timeline plan.

The recommended demo path is `POST /api/pipeline/p0`, because it returns all intermediate results under `stages`.

## Prerequisites

- Node.js is installed.
- Dependencies are installed in `apps/api`.
- `ffmpeg` and `ffprobe` are installed if testing real video upload/sample analysis.
- `.env` exists if you need custom `PORT`, upload/output directories, or real LLM integration.
- Do not print or share `.env`.

Install dependencies:

```bash
cd apps/api
npm install
```

Start the backend:

```bash
cd apps/api
PORT=4018 npm run dev
```

In another terminal:

```bash
BASE=http://localhost:4018
curl -sS "$BASE/api/health" | jq
```

Expected:

```json
{
  "status": "ok",
  "service": "popular-video-structure-transfer-api"
}
```

## Fastest Stable Demo: Fixture Sample Analysis

Use this path when you want a stable demo that does not depend on a real uploaded sample video or external model.

From `apps/api`:

```bash
BASE=http://localhost:4018
SAMPLE=../../examples/case_01/sample_analysis.mock.json

jq -n --slurpfile sample "$SAMPLE" '{
  sample_analysis: $sample[0],
  material_input: {
    target_topic: "猫粮避坑种草",
    target_audience: "新手养猫用户",
    product_name: "低敏猫粮",
    creative_brief: "做一个 20 秒种草/避坑短视频",
    selling_points: ["单一肉源", "低油配方", "小包装试吃"],
    uploaded_file_ids: ["user_video_clip_01.mp4", "product_closeup_01.jpg"],
    text_assets: [
      {
        type: "copy",
        content: "适合肠胃敏感、容易挑食的猫咪。"
      }
    ]
  },
  use_mock: true,
  confidence_threshold: 0.99
}' | curl -sS -X POST "$BASE/api/pipeline/p0" \
  -H "Content-Type: application/json" \
  --data-binary @- | tee /tmp/p0-pipeline-result.json | jq '{
    id,
    summary,
    structure_source: .stages.structure_blueprint.source,
    stage_keys: (.stages | keys),
    first_timeline_item: .stages.timeline_plan.timeline[0] | {
      slot_id,
      time_range,
      visual_source,
      material_ref,
      gap_ref,
      fill_strategy_ref,
      subtitle
    }
  }'
```

Expected proof points:

- `summary.status` is `completed`.
- `summary.stage_count` is `8`.
- `stage_keys` includes:
  - `sample_analysis`
  - `structure_blueprint`
  - `material_input`
  - `material_analysis`
  - `slot_mapping`
  - `gap_report`
  - `fill_strategies`
  - `timeline_plan`
- `structure_source.type` is `mock` when `use_mock: true`.
- `first_timeline_item.visual_source` is one of:
  - `user_material`
  - `reuse`
  - `text_card`
  - `generated_graphic`
  - `aigc`
- `first_timeline_item.gap_ref` and `fill_strategy_ref` show how gaps are connected to fill strategies.

Good screenshots:

- Terminal showing `summary.status: completed`.
- Terminal showing the 8 `stage_keys`.
- Terminal showing `first_timeline_item` with `time_range`, `visual_source`, `material_ref`, `gap_ref`, and `fill_strategy_ref`.

## Real Video Demo Path

Use this when you want to prove upload, metadata parsing, cover extraction, and keyframes.

Set your local video path:

```bash
VIDEO_PATH="/absolute/path/to/sample.MP4"
BASE=http://localhost:4018
```

Upload the sample video:

```bash
UPLOAD_JSON=$(curl -sS -X POST "$BASE/api/upload/video" \
  -F "file=@${VIDEO_PATH}")

echo "$UPLOAD_JSON" | jq

FILE_ID=$(echo "$UPLOAD_JSON" | jq -r '.files[0].file_id')
echo "$FILE_ID"
```

Run sample analysis:

```bash
SAMPLE_JSON=$(curl -sS -X POST "$BASE/api/sample/analyze" \
  -H "Content-Type: application/json" \
  -d "{\"file_id\":\"$FILE_ID\"}")

echo "$SAMPLE_JSON" | jq '{
  id,
  source,
  video: {
    duration_seconds: .video.duration_seconds,
    resolution: .video.resolution,
    aspect_ratio: .video.aspect_ratio,
    fps: .video.fps,
    cover_frame: .video.cover_frame
  },
  shot_count,
  keyframe_count: (.keyframes | length),
  transcript_status: .transcript.status
}'
```

Open the cover image URL in browser:

```bash
COVER_URI=$(echo "$SAMPLE_JSON" | jq -r '.video.cover_frame.uri')
echo "$BASE$COVER_URI"
```

Then run the full pipeline:

```bash
jq -n --argjson sample "$SAMPLE_JSON" '{
  sample_analysis: $sample,
  material_input: {
    target_topic: "猫粮避坑种草",
    target_audience: "新手养猫用户",
    product_name: "低敏猫粮",
    creative_brief: "基于样例视频结构，迁移成新产品的 20 秒短视频方案",
    selling_points: ["单一肉源", "低油配方", "小包装试吃"],
    uploaded_file_ids: ["user_video_clip_01.mp4", "product_closeup_01.jpg"],
    text_assets: [
      {
        type: "copy",
        content: "适合肠胃敏感、容易挑食的猫咪。"
      }
    ]
  },
  use_mock: true,
  confidence_threshold: 0.99
}' | curl -sS -X POST "$BASE/api/pipeline/p0" \
  -H "Content-Type: application/json" \
  --data-binary @- | tee /tmp/p0-real-video-pipeline-result.json | jq '{
    summary,
    sample_video: {
      duration: .stages.sample_analysis.video.duration_seconds,
      aspect_ratio: .stages.sample_analysis.video.aspect_ratio,
      cover: .stages.sample_analysis.video.cover_frame.uri
    },
    slot_count: (.stages.structure_blueprint.slots | length),
    gap_count: (.stages.gap_report.gaps | length),
    timeline_count: (.stages.timeline_plan.timeline | length),
    timeline_preview: [.stages.timeline_plan.timeline[] | {
      item_id,
      time_range,
      slot_type,
      visual_source,
      material_ref,
      gap_ref,
      fill_strategy_ref,
      subtitle
    }]
  }'
```

Good screenshots:

- Upload response with `file_id`.
- Sample analysis output with duration, aspect ratio, cover frame, and keyframe count.
- Browser showing the cover image URL.
- Pipeline output with summary and timeline preview.

## Endpoint-by-Endpoint Demo

If you need to show each module separately, use this order:

1. `POST /api/upload/video`
2. `POST /api/sample/analyze`
3. `POST /api/structure/extract`
4. `POST /api/material/input`
5. `POST /api/material/analyze`
6. `POST /api/structure/migrate`
7. `POST /api/gap/detect`
8. `POST /api/gap/fill-strategy`
9. `POST /api/generate/timeline`

For frontend integration, prefer the full pipeline first and split into individual endpoints only when a page needs partial recomputation.

## Mock, Fallback, and Real Model Behavior

Use `use_mock: true` for stable demos and frontend development.

Behavior:

- `use_mock: true`: structure extraction uses fallback/mock structure and avoids external LLM calls.
- `use_mock: false` and LLM env configured: structure extraction can call the real model.
- Missing LLM env: backend falls back to rule-based structure output.

Current P0 limitations:

- ASR/subtitle reading is not implemented yet. `sample_analysis.transcript.status` is `not_started`.
- AIGC image/video generation is not called in P0. `aigc_prompt_candidate` only produces prompts for later image/video generation.
- Keyframes are fixed-interval extraction, not shot-boundary detection.

## Common Errors

### Missing sample input

Request:

```json
{
  "material_input": {
    "target_topic": "猫粮避坑种草",
    "selling_points": ["单一肉源"]
  }
}
```

Response:

```json
{
  "error": {
    "code": "pipeline_stage_failed",
    "stage": "sample_analyze",
    "message": "Request body must include sample_file_id or sample_analysis"
  }
}
```

### Invalid material input

Request misses `selling_points`:

```json
{
  "sample_analysis": {},
  "material_input": {
    "target_topic": "猫粮避坑种草"
  },
  "use_mock": true
}
```

Response:

```json
{
  "error": {
    "code": "pipeline_stage_failed",
    "stage": "material_input",
    "message": "selling_points must include at least one item"
  }
}
```

## CI-Ready Verification

Run from `apps/api`:

```bash
npm run typecheck
LLM_API_KEY= LLM_ENDPOINT_ID= LLM_API_BASE_URL= npm test
npm run build
npm run validate:fixtures
```

The test command clears LLM env variables for deterministic mock/fallback behavior.

## What to Hand to Frontend

For the first UI pass, frontend can call only:

```text
POST /api/pipeline/p0
```

Then render from:

```text
result.stages.structure_blueprint.slots
result.stages.slot_mapping.mappings
result.stages.gap_report.gaps
result.stages.fill_strategies.gaps
result.stages.timeline_plan.timeline
```

Recommended UI mapping:

| UI area | Backend field |
| --- | --- |
| Sample metadata | `stages.sample_analysis.video` |
| Structure cards | `stages.structure_blueprint.slots` |
| Card status | `stages.slot_mapping.mappings[].material_status` |
| Missing/partial marks | `stages.gap_report.gaps[]` |
| Fill action menu | `stages.fill_strategies.gaps[].fill_options[]` |
| Final timeline | `stages.timeline_plan.timeline[]` |
| Preview media | `uri`, `path`, `/api/upload/files/:fileId`, `/api/frames/:fileId/:filename` |
