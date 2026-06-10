import { USE_MOCK } from "../config";
import {
  mockCanvasRevalidateResult,
  mockCanvasSession,
  mockFinalVideoResult,
  mockImageCandidates,
  createMockWorkflowResult
} from "../mocks/mockVideoAnalysis";
import type { WorkflowRunResult } from "../App";
import type { V2CanvasFinalVideoResult } from "../types";
import {
  analyzeV2Pipeline,
  assembleV2CanvasFinalVideo,
  createV2ScriptSession,
  generateV2CanvasGapVideo,
  generateV2CanvasImageCandidates,
  generateV2ImageCandidates,
  generateV2ImageToVideo,
  revalidateV2Canvas,
  uploadMaterialFiles,
  uploadSampleVideos
} from "./client";
import type {
  V2CanvasImageCandidateResponse,
  V2CanvasRevalidateResult,
  V2CanvasSession
} from "./client";

export type VideoAnalysisProgressStage =
  | "uploading"
  | "analyzing"
  | "extracting"
  | "generating";

export type VideoAnalysisProgress = {
  note: string;
  stage: VideoAnalysisProgressStage;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const readTextAssets = async (files: File[]) => {
  const textFiles = files.filter(
    (file) =>
      file.type.startsWith("text/") ||
      file.name.toLowerCase().endsWith(".txt") ||
      file.name.toLowerCase().endsWith(".md")
  );

  return Promise.all(
    textFiles.map(async (file, index) => ({
      asset_id: `txt_${String(index + 1).padStart(2, "0")}`,
      type: "note" as const,
      content: await file.text()
    }))
  );
};

const getTargetDurationSeconds = (brief: string) => {
  const match = brief.match(/(\d+(?:\.\d+)?)\s*(?:秒|s)/iu);
  const duration = Number(match?.[1] ?? 20);

  return Number.isFinite(duration) && duration > 0 ? duration : 20;
};

export const runVideoAnalysisWorkflow = async ({
  brief,
  materialFiles,
  onProgress,
  sampleFiles
}: {
  brief: string;
  materialFiles: File[];
  onProgress?: (progress: VideoAnalysisProgress) => void;
  sampleFiles: File[];
}): Promise<WorkflowRunResult> => {
  if (USE_MOCK) {
    onProgress?.({
      stage: "uploading",
      note: "正在读取本地文件并准备 mock 分析"
    });
    await wait(520);

    onProgress?.({
      stage: "extracting",
      note: "正在拆解样例结构、生成关键帧和分镜表"
    });
    await wait(720);

    onProgress?.({
      stage: "generating",
      note: "正在匹配素材、标记缺口和时长不足状态"
    });
    await wait(680);

    return createMockWorkflowResult({ materialFiles, sampleFiles });
  }

  onProgress?.({
    stage: "uploading",
    note: "正在上传样例视频"
  });
  const uploadedSample = await uploadSampleVideos(sampleFiles);
  const uploadedSampleFile = uploadedSample.files[0];

  if (!uploadedSampleFile) {
    throw new Error("上传接口没有返回样例视频 file_id。");
  }

  const videoMaterialFiles = materialFiles.filter((file) => file.type.startsWith("video/"));
  const skippedMaterialCount = materialFiles.length - videoMaterialFiles.length;
  const uploadedMaterials =
    videoMaterialFiles.length > 0
      ? await uploadMaterialFiles(videoMaterialFiles)
      : { files: [] };

  onProgress?.({
    stage: "extracting",
    note: "正在调用真实后端分析结构"
  });
  const textAssets = await readTextAssets(materialFiles);
  const pipelineResult = await analyzeV2Pipeline({
    reference_file_ids: uploadedSample.files.map((file) => file.file_id),
    user_material_file_ids: uploadedMaterials.files.map((file) => file.file_id),
    text_assets: [
      {
        asset_id: "brief_01",
        type: "brief",
        content: brief
      },
      ...textAssets
    ],
    user_request: {
      goal: brief
    },
    options: {
      allow_fallback: true,
      generate_image_candidates: false,
      image_candidate_count: 4,
      target_duration_seconds: getTargetDurationSeconds(brief)
    }
  });

  onProgress?.({
    stage: "generating",
    note: "正在创建结构迁移会话"
  });
  const scriptSession = await createV2ScriptSession({
    pipeline_result: pipelineResult,
    user_request: {
      goal: brief
    },
    target_duration_seconds: pipelineResult.summary.target_duration_seconds
  });

  return {
    materialFiles: uploadedMaterials.files,
    sampleFile: uploadedSampleFile,
    sampleFiles: uploadedSample.files,
    scriptSession,
    v2PipelineResult: pipelineResult,
    ...(skippedMaterialCount > 0
      ? {
          skippedMaterialCount
        }
      : {})
  } as WorkflowRunResult;
};

export const revalidateVideoAnalysisCanvas = async (
  sessionId: string
): Promise<V2CanvasRevalidateResult> => {
  if (USE_MOCK) {
    await wait(500);
    return mockCanvasRevalidateResult;
  }

  // Real canvas coverage recompute. If the backend later returns taskId/videoId,
  // keep polling orchestration next to this call.
  return revalidateV2Canvas({
    session_id: sessionId,
    persist_canvas_session: true
  });
};

export const assembleVideoAnalysisFinalVideo = async (
  canvasSessionId?: string
): Promise<V2CanvasFinalVideoResult> => {
  if (USE_MOCK) {
    await wait(600);
    return mockFinalVideoResult;
  }

  if (!canvasSessionId) {
    throw new Error("缺少 canvasSessionId，无法导出真实视频。");
  }

  return assembleV2CanvasFinalVideo(canvasSessionId, {
    generate_bgm: false
  });
};

export const generateVideoAnalysisImageCandidates = async ({
  canvasSessionId,
  count,
  prompt,
  referenceVideoUris,
  slotId
}: {
  canvasSessionId?: string;
  count: number;
  prompt: string;
  referenceVideoUris?: string[];
  slotId: string;
}): Promise<unknown> => {
  if (USE_MOCK) {
    await wait(620);
    return {
      canvas_session: mockCanvasSession,
      image_generation_result: {
        images: mockImageCandidates.slice(0, count).map((uri) => ({ uri }))
      },
      image_candidate_nodes: []
    } satisfies V2CanvasImageCandidateResponse;
  }

  if (canvasSessionId) {
    return generateV2CanvasImageCandidates(canvasSessionId, {
      slot_id: slotId,
      prompt,
      count,
      allow_fallback: true
    });
  }

  return generateV2ImageCandidates({
    prompt,
    count,
    allow_fallback: true,
    reference_video_uris: referenceVideoUris ?? []
  });
};

export const generateVideoAnalysisGapVideo = async ({
  approvedImageUri,
  canvasSessionId,
  durationSeconds,
  sourceVideoUri,
  slotDescription,
  slotId,
  slotType,
  videoPrompt
}: {
  approvedImageUri?: string;
  canvasSessionId?: string;
  durationSeconds: number;
  sourceVideoUri?: string;
  slotDescription: string;
  slotId: string;
  slotType: string;
  videoPrompt: string;
}): Promise<unknown> => {
  if (USE_MOCK) {
    await wait(860);
    return {
      canvas_session: mockCanvasSession,
      generated_video_node: {
        node_id: `${slotId}_mock_generated_video`,
        node_type: "generated_video",
        slot_id: slotId,
        data: {
          video_uri: approvedImageUri ?? mockImageCandidates[0]
        }
      },
      edge: {
        edge_id: `${slotId}_mock_generated_edge`,
        source_node_id: `${slotId}_mock_generated_video`,
        target_node_id: `${slotId}_slot`,
        edge_type: "generated_video_to_gap"
      },
      generation_result: {
        video_uri: approvedImageUri ?? mockImageCandidates[0]
      }
    };
  }

  if (canvasSessionId) {
    return generateV2CanvasGapVideo(canvasSessionId, {
      approved_image_uri: approvedImageUri,
      duration_seconds: durationSeconds,
      slot_id: slotId,
      video_prompt: videoPrompt,
      allow_fallback: true
    });
  }

  return generateV2ImageToVideo({
    approved_image_uri: approvedImageUri,
    source_video_uri: sourceVideoUri,
    video_prompt: videoPrompt,
    generation_mode: approvedImageUri ? "generated_image" : "direct_from_material_frame",
    duration_seconds: durationSeconds,
    slot_id: slotId,
    slot_type: slotType,
    slot_description: slotDescription,
    allow_fallback: true
  });
};
