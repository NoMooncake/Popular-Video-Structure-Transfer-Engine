import path from "node:path";

import {
  FFprobeExecutionError,
  FFprobeUnavailableError,
  parseRationalNumber,
  runFFprobe,
  type FFprobeStream
} from "../utils/ffmpeg.js";

export type VideoMetadata = {
  duration_seconds: number;
  width: number;
  height: number;
  resolution: string;
  aspect_ratio: string;
  fps?: number;
  codec?: string;
  format?: string;
};

export class VideoMetadataParseError extends Error {
  statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "VideoMetadataParseError";
  }
}

export type VideoParserError =
  | FFprobeUnavailableError
  | FFprobeExecutionError
  | VideoMetadataParseError;

const getVideoStream = (streams: FFprobeStream[] = []): FFprobeStream | undefined => {
  return streams.find((stream) => stream.codec_type === "video");
};

const parseNumber = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
};

const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }

  return x || 1;
};

const getAspectRatio = (width: number, height: number, stream: FFprobeStream): string => {
  if (stream.display_aspect_ratio && stream.display_aspect_ratio !== "0:1") {
    return stream.display_aspect_ratio;
  }

  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
};

export const parseVideoMetadata = async (filePath: string): Promise<VideoMetadata> => {
  const ffprobeResult = await runFFprobe(filePath);
  const videoStream = getVideoStream(ffprobeResult.streams);

  if (!videoStream) {
    throw new VideoMetadataParseError("No video stream found in uploaded file");
  }

  const width = videoStream.width;
  const height = videoStream.height;

  if (!width || !height) {
    throw new VideoMetadataParseError("Video stream is missing width or height");
  }

  const duration =
    parseNumber(videoStream.duration) || parseNumber(ffprobeResult.format?.duration);

  if (!duration) {
    throw new VideoMetadataParseError("Video duration is missing or invalid");
  }

  const fps =
    parseRationalNumber(videoStream.avg_frame_rate) ||
    parseRationalNumber(videoStream.r_frame_rate);

  return {
    duration_seconds: Number(duration.toFixed(3)),
    width,
    height,
    resolution: `${width}x${height}`,
    aspect_ratio: getAspectRatio(width, height, videoStream),
    fps: fps ? Number(fps.toFixed(3)) : undefined,
    codec: videoStream.codec_name,
    format: ffprobeResult.format?.format_name || path.extname(filePath).slice(1)
  };
};
