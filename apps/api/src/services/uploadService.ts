import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import multer from "multer";

import { storageConfig } from "../config/storage.js";

export type UploadedVideoFile = {
  file_id: string;
  filename: string;
  original_filename: string;
  path: string;
  mime_type: string;
  size: number;
};

export type UploadResponse = {
  files: UploadedVideoFile[];
};

export class UploadValidationError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

const ensureUploadDir = (): void => {
  fs.mkdirSync(storageConfig.uploadDir, { recursive: true });
};

const sanitizeFilename = (filename: string): string => {
  const parsedName = path.parse(filename);
  const safeBaseName = parsedName.name
    .normalize("NFKD")
    .replace(/[^\w.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  const safeExtension = parsedName.ext.toLowerCase();

  return `${safeBaseName || "video"}${safeExtension}`;
};

const isAllowedVideoFile = (file: Express.Multer.File): boolean => {
  const extension = path.extname(file.originalname).toLowerCase();
  return (
    storageConfig.allowedVideoMimeTypes.includes(file.mimetype) &&
    storageConfig.allowedVideoExtensions.includes(extension)
  );
};

const multerStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    ensureUploadDir();
    callback(null, storageConfig.uploadDir);
  },
  filename: (_req, file, callback) => {
    const fileId = crypto.randomUUID();
    const safeFilename = sanitizeFilename(file.originalname);
    callback(null, `${fileId}-${safeFilename}`);
  }
});

export const videoUploadMiddleware = multer({
  storage: multerStorage,
  limits: {
    fileSize: storageConfig.maxUploadFileSizeBytes,
    files: 10
  },
  fileFilter: (_req, file, callback) => {
    if (!isAllowedVideoFile(file)) {
      callback(
        new UploadValidationError(
          "Only mp4, mov, and webm video files are allowed"
        )
      );
      return;
    }

    callback(null, true);
  }
});

const getFileIdFromStoredFilename = (filename: string): string => {
  const uuidMatch = filename.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u
  );
  return uuidMatch?.[0] || filename;
};

export const formatUploadedVideo = (
  file: Express.Multer.File
): UploadedVideoFile => {
  const fileId = getFileIdFromStoredFilename(file.filename);

  return {
    file_id: fileId,
    filename: file.filename,
    original_filename: file.originalname,
    path: `/api/upload/files/${fileId}`,
    mime_type: file.mimetype,
    size: file.size
  };
};

export const formatUploadResponse = (
  files: Express.Multer.File[]
): UploadResponse => {
  return {
    files: files.map(formatUploadedVideo)
  };
};

export const findUploadedVideoById = (fileId: string): string | undefined => {
  ensureUploadDir();
  const matchingFile = fs
    .readdirSync(storageConfig.uploadDir)
    .find((filename) => filename.startsWith(`${fileId}-`));

  if (!matchingFile) {
    return undefined;
  }

  return path.join(storageConfig.uploadDir, matchingFile);
};
