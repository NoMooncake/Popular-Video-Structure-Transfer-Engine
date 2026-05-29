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
