/*
 * Ticket attachment upload: jpg, png, pdf, docx only; max 5 MB each; up to 3 files.
 * Files are held in memory, checked (extension, MIME type and file signature) and only then
 * written to storage/attachments/ with a random name by services/storageService.js.
 */
import multer from "multer";
import path from "path";
import { config } from "../config/index.js";
import { ALLOWED_EXTENSIONS } from "../services/storageService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxFileSizeBytes, files: config.uploads.maxFiles, fields: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const rule = ALLOWED_EXTENSIONS[ext];
    if (!rule || !rule.mimes.includes(file.mimetype)) {
      return cb(Object.assign(new Error("Invalid file type"), { code: "INVALID_FILE_TYPE" }));
    }
    cb(null, true);
  },
});

const MESSAGES = {
  INVALID_FILE_TYPE: "Only JPG, PNG, PDF and DOCX files are allowed.",
  LIMIT_FILE_SIZE: "Each attachment must be 5 MB or smaller.",
  LIMIT_FILE_COUNT: `You can attach up to ${config.uploads.maxFiles} files.`,
  LIMIT_UNEXPECTED_FILE: `You can attach up to ${config.uploads.maxFiles} files.`,
};

// Never throws: an upload problem is stored on req.uploadError so the form can be shown again.
export const uploadAttachments = (req, res, next) => {
  upload.array("attachments", config.uploads.maxFiles)(req, res, (err) => {
    if (err) {
      req.uploadError = MESSAGES[err.code] || "The attachment could not be uploaded.";
      req.files = [];
    }
    next();
  });
};
