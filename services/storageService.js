/*
 * Attachment storage on the local disk, outside public/ (storage/attachments/).
 * Files are only reachable through GET /attachments/:id, which checks ticket access.
 * Kept behind this small service so cloud storage can replace it later without touching controllers.
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "../config/index.js";
import { AppError } from "../helpers/errors.js";

const SIGNATURES = {
  jpg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  pdf: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  docx: [[0x50, 0x4b, 0x03, 0x04]], // ZIP container
};

export const ALLOWED_EXTENSIONS = {
  ".jpg": { type: "jpg", mime: "image/jpeg", mimes: ["image/jpeg", "image/pjpeg"] },
  ".jpeg": { type: "jpg", mime: "image/jpeg", mimes: ["image/jpeg", "image/pjpeg"] },
  ".png": { type: "png", mime: "image/png", mimes: ["image/png"] },
  ".pdf": { type: "pdf", mime: "application/pdf", mimes: ["application/pdf"] },
  ".docx": {
    type: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream", "application/zip"],
  },
};

const matchesSignature = (buffer, type) =>
  SIGNATURES[type].some((sig) => buffer.length >= sig.length && sig.every((byte, i) => buffer[i] === byte));

const safeOriginalName = (name) =>
  path.basename(String(name || "file"))
    .replace(/[\u0000-\u001F\u007F"\\/<>:|?*]/g, "_")
    .slice(-150) || "file";

// Validates each in-memory file; throws AppError with a readable message on the first bad file.
export const validateFiles = (files = []) =>
  files.map((file) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const rule = ALLOWED_EXTENSIONS[ext];
    if (!rule) throw new AppError(`"${safeOriginalName(file.originalname)}" is not an allowed file type.`);
    if (file.size > config.uploads.maxFileSizeBytes) throw new AppError(`"${safeOriginalName(file.originalname)}" is larger than 5 MB.`);
    if (!matchesSignature(file.buffer, rule.type)) {
      throw new AppError(`"${safeOriginalName(file.originalname)}" does not look like a real ${rule.type.toUpperCase()} file.`);
    }
    return { file, ext: ext === ".jpeg" ? ".jpg" : ext, mime: rule.mime };
  });

// Writes validated files with random names. Returns metadata rows for ticket_attachments.
export const saveFiles = async (validated) => {
  if (!validated.length) return [];
  await fs.mkdir(config.uploads.dir, { recursive: true });
  const saved = [];
  try {
    for (const { file, ext, mime } of validated) {
      const storedName = `${crypto.randomUUID()}${ext}`;
      await fs.writeFile(path.join(config.uploads.dir, storedName), file.buffer, { flag: "wx" });
      saved.push({ original_name: safeOriginalName(file.originalname), stored_name: storedName, mime_type: mime, size_bytes: file.size });
    }
    return saved;
  } catch (err) {
    await removeFiles(saved.map((s) => s.stored_name));
    throw err;
  }
};

export const removeFiles = async (storedNames = []) => {
  for (const name of storedNames) {
    await fs.unlink(storedPath(name)).catch(() => {});
  }
};

// Absolute path for a stored file; basename() blocks any path traversal in stored names.
export const storedPath = (storedName) => path.join(config.uploads.dir, path.basename(storedName));
