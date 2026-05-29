import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { runFFmpeg } from "../utils/ffmpeg.js";
import type { VideoMetadata } from "./videoParserService.js";

export type FrameMediaRef = {
  uri: string;
  mime_type: "image/jpeg";
  width: number;
  height: number;
};

export type ExtractedKeyframe = {
  frame_id: string;
  time_seconds: number;
  media: FrameMediaRef;
};

export type ExtractedVideoFrames = {
  cover_frame: FrameMediaRef;
  keyframes: ExtractedKeyframe[];
};

const framesRootDir = path.join(storageConfig.outputDir, "frames");

const ensureFrameOutputDir = (fileId: string): string => {
  const outputDir = path.join(framesRootDir, fileId);
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
};

const getCoverTimestamp = (durationSeconds: number): number => {
  return Number(Math.min(1, Math.max(0, durationSeconds * 0.1)).toFixed(3));
};

const getKeyframeCount = (durationSeconds: number): number => {
  if (durationSeconds < 1) {
    return 1;
  }

  if (durationSeconds < 3) {
    return 3;
  }

  return 6;
};

const getKeyframeTimestamps = (durationSeconds: number): number[] => {
  const count = getKeyframeCount(durationSeconds);
  const start = durationSeconds < 2 ? 0 : Math.min(1, durationSeconds * 0.1);
  const end = durationSeconds < 2 ? durationSeconds : Math.max(start, durationSeconds * 0.9);

  if (count === 1) {
    return [Number(start.toFixed(3))];
  }

  const step = (end - start) / (count - 1);

  return Array.from({ length: count }, (_value, index) => {
    return Number((start + step * index).toFixed(3));
  });
};

const publicFrameUri = (fileId: string, filename: string): string => {
  return `/api/frames/${fileId}/${filename}`;
};

const extractFrame = async (
  videoPath: string,
  outputPath: string,
  timestampSeconds: number
): Promise<void> => {
  await runFFmpeg(
    [
      "-y",
      "-ss",
      String(timestampSeconds),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath
    ],
    [
      { path: videoPath, replacement: "[video]" },
      { path: outputPath, replacement: "[output]" }
    ]
  );
};

export const extractVideoFrames = async (
  fileId: string,
  filePath: string,
  metadata: VideoMetadata
): Promise<ExtractedVideoFrames> => {
  const outputDir = ensureFrameOutputDir(fileId);
  const coverFilename = "cover.jpg";
  const coverPath = path.join(outputDir, coverFilename);
  const coverTimestamp = getCoverTimestamp(metadata.duration_seconds);

  await extractFrame(filePath, coverPath, coverTimestamp);

  const keyframeTimestamps = getKeyframeTimestamps(metadata.duration_seconds);
  const keyframes: ExtractedKeyframe[] = [];

  for (const [index, timestamp] of keyframeTimestamps.entries()) {
    const frameNumber = String(index + 1).padStart(3, "0");
    const filename = `keyframe_${frameNumber}.jpg`;
    const outputPath = path.join(outputDir, filename);

    await extractFrame(filePath, outputPath, timestamp);

    keyframes.push({
      frame_id: `kf_${frameNumber}`,
      time_seconds: timestamp,
      media: {
        uri: publicFrameUri(fileId, filename),
        mime_type: "image/jpeg",
        width: metadata.width,
        height: metadata.height
      }
    });
  }

  return {
    cover_frame: {
      uri: publicFrameUri(fileId, coverFilename),
      mime_type: "image/jpeg",
      width: metadata.width,
      height: metadata.height
    },
    keyframes
  };
};

export const findExtractedFrame = (
  fileId: string,
  filename: string
): string | undefined => {
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename || !safeFilename.endsWith(".jpg")) {
    return undefined;
  }

  const filePath = path.join(framesRootDir, fileId, safeFilename);
  const resolvedRoot = path.resolve(framesRootDir, fileId);
  const resolvedFilePath = path.resolve(filePath);

  if (!resolvedFilePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return undefined;
  }

  if (!fs.existsSync(resolvedFilePath)) {
    return undefined;
  }

  return resolvedFilePath;
};
