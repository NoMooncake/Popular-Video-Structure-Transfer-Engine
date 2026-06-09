import { extractVideoFrames, type ExtractedKeyframe } from "./frameExtractService.js";
import { findUploadedVideoById } from "./uploadService.js";
import { parseVideoMetadata, type VideoMetadata } from "./videoParserService.js";
import { assertValidSchema } from "../utils/schemaValidator.js";

type TimeRange = {
  start_seconds: number;
  end_seconds: number;
  relative_start_percent: number;
  relative_end_percent: number;
};

type SampleAnalysisShot = {
  shot_id: string;
  time_range: TimeRange;
  keyframe_refs: string[];
  visual_tags: string[];
  description: string;
  confidence: number;
};

type SampleAnalysisTableRow = {
  row_id: string;
  duration: string;
  sample_video: {
    frame_id: string;
    time_seconds: number;
    media: {
      uri: string;
      mime_type: "image/jpeg";
      width: number;
      height: number;
    };
  };
  shot_description: {
    title: string;
    description: string;
  };
  migration_possibility: string;
};

type SampleAnalysisTable = {
  columns: ["时长", "样例视频", "分镜描述", "迁移可能性"];
  rows: SampleAnalysisTableRow[];
};

export type SampleAnalysis = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "uploaded_video";
    file_id: string;
    path: string;
  };
  video: VideoMetadata & {
    cover_frame: {
      uri: string;
      mime_type: "image/jpeg";
      width: number;
      height: number;
    };
  };
  shot_count: number;
  shots: SampleAnalysisShot[];
  keyframes: ExtractedKeyframe[];
  analysis_table: SampleAnalysisTable;
  transcript: {
    status: "not_started";
    language: "zh-CN";
    summary: string;
    full_text: string;
    segments: [];
  };
  packaging_observations: {
    subtitle_density: "medium";
    title_bars: string[];
    stickers: string[];
    transitions: string[];
    cover_style: string;
  };
  warnings: string[];
};

export type SampleAnalysisBatch = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "uploaded_video_batch";
    file_ids: string[];
  };
  sample_count: number;
  samples: Array<{
    sample_index: number;
    file_id: string;
    analysis_id: string;
    analysis_table: SampleAnalysisTable;
    analysis: SampleAnalysis;
  }>;
  structure_migration_input: {
    reference_file_ids: string[];
    sample_analysis_ids: string[];
    sample_analyses: SampleAnalysis[];
  };
};

export class UploadedSampleNotFoundError extends Error {
  statusCode = 404;

  constructor() {
    super("Uploaded sample video not found");
    this.name = "UploadedSampleNotFoundError";
  }
}

const round = (value: number): number => {
  return Number(value.toFixed(3));
};

const formatDuration = (timeRange: TimeRange): string => {
  const start = Number(timeRange.start_seconds.toFixed(3));
  const end = Number(timeRange.end_seconds.toFixed(3));

  return `${start} - ${end}s`;
};

const getShotRange = (
  index: number,
  total: number,
  durationSeconds: number
): TimeRange => {
  const startPercent = (index / total) * 100;
  const endPercent = ((index + 1) / total) * 100;

  return {
    start_seconds: round((startPercent / 100) * durationSeconds),
    end_seconds: round((endPercent / 100) * durationSeconds),
    relative_start_percent: round(startPercent),
    relative_end_percent: round(endPercent)
  };
};

const buildShots = (
  keyframes: ExtractedKeyframe[],
  durationSeconds: number
): SampleAnalysisShot[] => {
  return keyframes.map((keyframe, index) => {
    const shotNumber = String(index + 1).padStart(2, "0");

    return {
      shot_id: `shot_${shotNumber}`,
      time_range: getShotRange(index, keyframes.length, durationSeconds),
      keyframe_refs: [keyframe.frame_id],
      visual_tags: ["auto_extracted_keyframe"],
      description: "基于固定间隔抽帧生成的预览镜头，用于前端展示和后续结构拆解。",
      confidence: 0.6
    };
  });
};

const shotTitles = [
  "开场吸引",
  "产品展示",
  "情绪 / 场景铺垫",
  "卖点展开",
  "证明 / 对比",
  "行动引导"
];

const migrationPossibilityByIndex = [
  "可迁移为新视频里的强 Hook、产品质感冲击或痛点开场。",
  "可迁移为新产品的主体亮相、核心卖点展示或使用前状态。",
  "可迁移为目标用户场景、情绪共鸣或使用环境铺垫。",
  "可迁移为卖点拆解、材质细节、功能过程或方案展开。",
  "可迁移为效果对比、证据证明、参数卡片或结果展示。",
  "可迁移为结尾 CTA、购买引导、评论互动或品牌收束。"
];

const getKeyframeByRef = (
  keyframes: ExtractedKeyframe[],
  frameId: string | undefined,
  fallbackIndex: number
): ExtractedKeyframe => {
  return (
    keyframes.find((keyframe) => keyframe.frame_id === frameId) ||
    keyframes[fallbackIndex] ||
    keyframes[0]
  );
};

const buildAnalysisTable = (
  shots: SampleAnalysisShot[],
  keyframes: ExtractedKeyframe[]
): SampleAnalysisTable => {
  return {
    columns: ["时长", "样例视频", "分镜描述", "迁移可能性"],
    rows: shots.map((shot, index) => {
      const keyframe = getKeyframeByRef(keyframes, shot.keyframe_refs[0], index);

      return {
        row_id: shot.shot_id,
        duration: formatDuration(shot.time_range),
        sample_video: {
          frame_id: keyframe.frame_id,
          time_seconds: keyframe.time_seconds,
          media: keyframe.media
        },
        shot_description: {
          title: shotTitles[index] || `分镜 ${index + 1}`,
          description: shot.description
        },
        migration_possibility:
          migrationPossibilityByIndex[index] ||
          "可迁移为新视频中相同结构位置的画面、节奏和包装表达。"
      };
    })
  };
};

export const analyzeSampleVideo = async (
  fileId: string
): Promise<SampleAnalysis> => {
  const filePath = findUploadedVideoById(fileId);

  if (!filePath) {
    throw new UploadedSampleNotFoundError();
  }

  const metadata = await parseVideoMetadata(filePath);
  const frames = await extractVideoFrames(fileId, filePath, metadata);
  const shots = buildShots(frames.keyframes, metadata.duration_seconds);
  const analysisTable = buildAnalysisTable(shots, frames.keyframes);

  const sampleAnalysis: SampleAnalysis = {
    id: `sample_analysis_${fileId}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "uploaded_video",
      file_id: fileId,
      path: `/api/upload/files/${fileId}`
    },
    video: {
      ...metadata,
      cover_frame: frames.cover_frame
    },
    shot_count: shots.length,
    shots,
    keyframes: frames.keyframes,
    analysis_table: analysisTable,
    transcript: {
      status: "not_started",
      language: "zh-CN",
      summary: "当前版本暂未接入 ASR；已完成视频元数据、封面和关键帧解析，可用于第一版样例结构拆解前的基础展示。",
      full_text: "",
      segments: []
    },
    packaging_observations: {
      subtitle_density: "medium",
      title_bars: [],
      stickers: [],
      transitions: ["fixed_interval_preview"],
      cover_style: "从上传样例视频自动抽取的封面帧。"
    },
    warnings: [
      "当前 sample_analysis 使用真实视频元数据和抽帧结果，字幕摘要仍为 mock，后续接入 ASR 后替换。"
    ]
  };

  assertValidSchema("sample_analysis", sampleAnalysis);
  return sampleAnalysis;
};

export const analyzeSampleVideos = async (
  fileIds: string[]
): Promise<SampleAnalysisBatch> => {
  const uniqueFileIds = Array.from(
    new Set(fileIds.map((fileId) => fileId.trim()).filter(Boolean))
  );

  const analyses = await Promise.all(uniqueFileIds.map((fileId) => analyzeSampleVideo(fileId)));

  return {
    id: `sample_analysis_batch_${Date.now()}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "uploaded_video_batch",
      file_ids: uniqueFileIds
    },
    sample_count: analyses.length,
    samples: analyses.map((analysis, index) => ({
      sample_index: index + 1,
      file_id: uniqueFileIds[index],
      analysis_id: analysis.id,
      analysis_table: analysis.analysis_table,
      analysis
    })),
    structure_migration_input: {
      reference_file_ids: uniqueFileIds,
      sample_analysis_ids: analyses.map((analysis) => analysis.id),
      sample_analyses: analyses
    }
  };
};
