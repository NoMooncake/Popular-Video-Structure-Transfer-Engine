import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { findUploadedVideoById } from "../services/uploadService.js";
import { runFFmpeg, runFFprobe } from "../utils/ffmpeg.js";
import type { V2VideoRef } from "./types.js";

export type V2ReferenceFrame = {
  frame_id: string;
  source_uri: string;
  source_label?: string;
  time_seconds: number;
  file_path: string;
  public_uri: string;
  mime_type: "image/jpeg";
  data_url: string;
};

const referenceFrameRootDir = path.join(storageConfig.outputDir, "v2-reference-frames");

const buildReferenceFramePublicUri = (filePath: string): string => {
  const runId = path.basename(path.dirname(filePath));
  const filename = path.basename(filePath);

  return `/api/v2/reference-frames/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`;
};

const isLocalVideoPath = (value: string | undefined): value is string => {
  return Boolean(
    value &&
      value.startsWith("/") &&
      /\.(mp4|mov|avi|wmv|webm|m4v)(?:[?#].*)?$/iu.test(value) &&
      fs.existsSync(value)
  );
};

const extractFileIdFromUploadUri = (uri: string | undefined): string | undefined => {
  if (!uri) {
    return undefined;
  }

  const match = uri.match(/\/api\/upload\/files\/([^/?#]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
};

const resolveLocalVideoPath = (videoRef: V2VideoRef): string | undefined => {
  if (isLocalVideoPath(videoRef.uri)) {
    return videoRef.uri;
  }

  const fileId = videoRef.file_id || extractFileIdFromUploadUri(videoRef.uri);
  return fileId ? findUploadedVideoById(fileId) : undefined;
};

const ensureOutputDir = (): string => {
  const outputDir = path.join(referenceFrameRootDir, String(Date.now()));
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
};

const readDurationSeconds = async (videoPath: string): Promise<number | undefined> => {
  try {
    const probeResult = await runFFprobe(videoPath);
    const duration =
      Number(probeResult.format?.duration) ||
      Number(probeResult.streams?.find((stream) => stream.codec_type === "video")?.duration);

    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
};

const getFrameTimestamps = (durationSeconds: number | undefined, count: number): number[] => {
  if (!durationSeconds || durationSeconds <= 1) {
    return Array.from({ length: count }, () => 0);
  }

  if (count === 1) {
    return [Number(Math.min(1, durationSeconds * 0.25).toFixed(3))];
  }

  const start = Math.min(1, durationSeconds * 0.15);
  const end = Math.max(start, durationSeconds * 0.85);
  const step = (end - start) / (count - 1);

  return Array.from({ length: count }, (_value, index) =>
    Number((start + step * index).toFixed(3))
  );
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
      { path: videoPath, replacement: "[reference_video]" },
      { path: outputPath, replacement: "[reference_frame]" }
    ]
  );
};

const toJpegDataUrl = (filePath: string): string => {
  return `data:image/jpeg;base64,${fs.readFileSync(filePath).toString("base64")}`;
};

const getFrameCountForVideo = (
  remainingFrameSlots: number,
  remainingVideoCount: number
): number => {
  return Math.max(1, Math.floor(remainingFrameSlots / remainingVideoCount));
};

export const collectV2ReferenceFramesFromVideos = async (
  videoRefs: V2VideoRef[],
  maxFrames: number
): Promise<V2ReferenceFrame[]> => {
  const frameLimit = Math.max(0, Math.floor(maxFrames));
  if (frameLimit === 0) {
    return [];
  }

  const localVideos = videoRefs
    .map((videoRef) => ({
      ...videoRef,
      uri: resolveLocalVideoPath(videoRef)
    }))
    .filter((videoRef): videoRef is V2VideoRef & { uri: string } =>
      isLocalVideoPath(videoRef.uri)
    );
  if (localVideos.length === 0) {
    return [];
  }

  const outputDir = ensureOutputDir();
  const frames: V2ReferenceFrame[] = [];

  for (const [videoIndex, videoRef] of localVideos.entries()) {
    if (frames.length >= frameLimit || !videoRef.uri) {
      break;
    }

    const remainingFrameSlots = frameLimit - frames.length;
    const remainingVideoCount = localVideos.length - videoIndex;
    const frameCount = getFrameCountForVideo(remainingFrameSlots, remainingVideoCount);
    const durationSeconds = await readDurationSeconds(videoRef.uri);
    const timestamps = getFrameTimestamps(durationSeconds, frameCount);

    for (const timestampSeconds of timestamps) {
      if (frames.length >= frameLimit) {
        break;
      }

      const frameNumber = String(frames.length + 1).padStart(2, "0");
      const outputPath = path.join(outputDir, `reference_${frameNumber}.jpg`);

      try {
        await extractFrame(videoRef.uri, outputPath, timestampSeconds);
        frames.push({
          frame_id: `reference_frame_${frameNumber}`,
          source_uri: videoRef.uri,
          source_label: videoRef.label,
          time_seconds: timestampSeconds,
          file_path: outputPath,
          public_uri: buildReferenceFramePublicUri(outputPath),
          mime_type: "image/jpeg",
          data_url: toJpegDataUrl(outputPath)
        });
      } catch {
        if (timestampSeconds !== 0) {
          const fallbackOutputPath = path.join(
            outputDir,
            `reference_${frameNumber}_fallback.jpg`
          );

          try {
            await extractFrame(videoRef.uri, fallbackOutputPath, 0);
            frames.push({
              frame_id: `reference_frame_${frameNumber}`,
              source_uri: videoRef.uri,
              source_label: videoRef.label,
              time_seconds: 0,
              file_path: fallbackOutputPath,
              public_uri: buildReferenceFramePublicUri(fallbackOutputPath),
              mime_type: "image/jpeg",
              data_url: toJpegDataUrl(fallbackOutputPath)
            });
          } catch {
            // Skip unusable material videos; image generation can still proceed from prompt text.
          }
        }
      }
    }
  }

  return frames;
};

export const findV2ReferenceFrameFile = (
  runId: string,
  filename: string
): string | undefined => {
  const framePath = path.join(referenceFrameRootDir, runId, filename);
  const normalizedRoot = path.resolve(referenceFrameRootDir);
  const normalizedFramePath = path.resolve(framePath);

  if (
    !normalizedFramePath.startsWith(`${normalizedRoot}${path.sep}`) ||
    !fs.existsSync(normalizedFramePath)
  ) {
    return undefined;
  }

  return normalizedFramePath;
};
