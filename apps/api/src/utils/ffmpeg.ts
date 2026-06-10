import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class FFprobeUnavailableError extends Error {
  statusCode = 503;

  constructor(message = "ffprobe is not installed or not available in PATH") {
    super(message);
    this.name = "FFprobeUnavailableError";
  }
}

export class FFprobeExecutionError extends Error {
  statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "FFprobeExecutionError";
  }
}

export class FFmpegUnavailableError extends Error {
  statusCode = 503;

  constructor(message = "ffmpeg is not installed or not available in PATH") {
    super(message);
    this.name = "FFmpegUnavailableError";
  }
}

export class FFmpegExecutionError extends Error {
  statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "FFmpegExecutionError";
  }
}

export type FFprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  display_aspect_ratio?: string;
};

export type FFprobeResult = {
  streams?: FFprobeStream[];
  format?: {
    duration?: string;
    format_name?: string;
  };
};

export const runFFprobe = async (filePath: string): Promise<FFprobeResult> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ]);

    return JSON.parse(stdout) as FFprobeResult;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };

    if (nodeError.code === "ENOENT") {
      throw new FFprobeUnavailableError();
    }

    const detail = (nodeError.stderr || nodeError.stdout || nodeError.message).replaceAll(
      filePath,
      "[uploaded video]"
    );
    throw new FFprobeExecutionError(`ffprobe failed to inspect video: ${detail}`);
  }
};

export type FFmpegPathReplacement = {
  path: string;
  replacement: string;
};

export const runFFmpeg = async (
  args: string[],
  sanitizePaths: FFmpegPathReplacement[] = []
): Promise<void> => {
  try {
    await execFileAsync("ffmpeg", args);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };

    if (nodeError.code === "ENOENT") {
      throw new FFmpegUnavailableError();
    }

    const rawDetail = nodeError.stderr || nodeError.stdout || nodeError.message;
    const detail = sanitizePaths.reduce((currentDetail, pathToSanitize) => {
      return currentDetail.replaceAll(
        pathToSanitize.path,
        pathToSanitize.replacement
      );
    }, rawDetail);

    throw new FFmpegExecutionError(`ffmpeg failed to process video: ${detail}`);
  }
};

export const parseRationalNumber = (value?: string): number | undefined => {
  if (!value || value === "0/0") {
    return undefined;
  }

  const [numeratorRaw, denominatorRaw] = value.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);

  if (!Number.isFinite(numerator)) {
    return undefined;
  }

  if (!denominatorRaw) {
    return numerator;
  }

  if (!Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }

  return numerator / denominator;
};
