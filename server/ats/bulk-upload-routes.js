const express = require('express');
const fs = require('fs');
const path = require('path');
const { promises: fsPromises } = require('fs');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const { parseResumeText } = require('./resume-parser');
const {
  DuplicateCandidateError,
  buildDedupKeys,
  buildResumeHash,
  buildResumeStoragePath,
  findExistingCandidate,
  getResumePublicUrl,
  isStorageAlreadyExistsError,
  isUniqueViolation,
  normalizeCandidatePayload,
  withDedupLock
} = require('./candidate-dedup');

function getConfig() {
  const maxFilesPerRequestRaw = Number(process.env.MAX_FILES_PER_REQUEST);
  const maxFilesPerRequest =
    Number.isFinite(maxFilesPerRequestRaw) && maxFilesPerRequestRaw >= 0
      ? Math.floor(maxFilesPerRequestRaw)
      : 500;

  const bulkUploadConcurrencyRaw = Number(process.env.BULK_UPLOAD_CONCURRENCY);
  const bulkUploadConcurrency =
    Number.isFinite(bulkUploadConcurrencyRaw) && bulkUploadConcurrencyRaw > 0
      ? Math.floor(bulkUploadConcurrencyRaw)
      : 8;

  const maxFileSizeMbRaw = Number(process.env.MAX_RESUME_FILE_SIZE_MB);
  const maxFileSizeMb =
    Number.isFinite(maxFileSizeMbRaw) && maxFileSizeMbRaw > 0 ? maxFileSizeMbRaw : 10;

  return {
    maxFilesPerRequest,
    bulkUploadConcurrency,
    maxFileSizeBytes: Math.floor(maxFileSizeMb * 1024 * 1024),
    resumeBucket: process.env.SUPABASE_RESUME_BUCKET || 'resumes'
  };
}

async function parseResumeBuffer(fileBuffer) {
  const parser = new PDFParse({ data: fileBuffer });

  try {
    const parsedPdf = await parser.getText();
    return parseResumeText(parsedPdf?.text || '');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function deleteTempFile(filePath) {
  if (!filePath) {
    return;
  }
  await fsPromises.unlink(filePath).catch(() => {});
}

async function processFilesWithConcurrency(files, concurrency, handler) {
  const results = new Array(files.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, files.length));

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= files.length) {
        break;
      }

      results[currentIndex] = await handler(files[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function createBulkUploadRouter({ supabase }) {
  const router = express.Router();
  const config = getConfig();

  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const limits = {
    fileSize: config.maxFileSizeBytes
  };

  if (config.maxFilesPerRequest > 0) {
    limits.files = config.maxFilesPerRequest;
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => {
      callback(null, uploadsDir);
    },
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.pdf';
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
    }
  });

  const upload = multer({
    storage,
    limits,
    fileFilter: (_req, file, callback) => {
      const hasPdfMimeType = file.mimetype === 'application/pdf';
      const hasPdfExtension = path.extname(file.originalname).toLowerCase() === '.pdf';

      if (hasPdfMimeType || hasPdfExtension) {
        callback(null, true);
        return;
      }

      callback(new Error('Only PDF files are allowed.'));
    }
  });

  async function saveCandidateFromFile(file) {
    const fileBuffer = await fsPromises.readFile(file.path);
    const parsed = await parseResumeBuffer(fileBuffer);
    const resumeHash = buildResumeHash(fileBuffer);
    const storagePath = buildResumeStoragePath(resumeHash);
    const resumeUrl = getResumePublicUrl(supabase, config.resumeBucket, storagePath);
    const payload = normalizeCandidatePayload(parsed, resumeUrl);
    const dedupKeys = buildDedupKeys({
      email: payload.email,
      phone: payload.phone,
      resumeHash
    });

    return withDedupLock(dedupKeys, async () => {
      const existingBeforeUpload = await findExistingCandidate({
        supabase,
        email: payload.email,
        phone: payload.phone,
        resumeUrl
      });

      if (existingBeforeUpload) {
        throw new DuplicateCandidateError(
          `Duplicate candidate skipped (matched by ${existingBeforeUpload.matchBy}).`,
          existingBeforeUpload
        );
      }

      const { error: storageError } = await supabase.storage
        .from(config.resumeBucket)
        .upload(storagePath, fileBuffer, {
          contentType: 'application/pdf',
          upsert: false
        });

      if (storageError && !isStorageAlreadyExistsError(storageError)) {
        throw new Error(`Failed to upload resume to Supabase Storage: ${storageError.message}`);
      }

      if (isStorageAlreadyExistsError(storageError)) {
        const existingByFile = await findExistingCandidate({
          supabase,
          email: payload.email,
          phone: payload.phone,
          resumeUrl
        });

        if (existingByFile) {
          throw new DuplicateCandidateError(
            `Duplicate candidate skipped (matched by ${existingByFile.matchBy}).`,
            existingByFile
          );
        }
      }

      const { data: insertedCandidate, error: insertError } = await supabase
        .from('candidates')
        .insert(payload)
        .select('*')
        .single();

      if (insertError) {
        if (isUniqueViolation(insertError)) {
          const existingAfterConflict = await findExistingCandidate({
            supabase,
            email: payload.email,
            phone: payload.phone,
            resumeUrl
          });

          throw new DuplicateCandidateError(
            `Duplicate candidate skipped (matched by ${existingAfterConflict?.matchBy || 'constraint'}).`,
            existingAfterConflict || {}
          );
        }

        throw new Error(`Failed to save candidate in database: ${insertError.message}`);
      }

      return insertedCandidate;
    });
  }

  router.post('/upload-resumes', upload.any(), async (req, res, next) => {
    const files = Array.isArray(req.files) ? req.files : [];

    if (files.length === 0) {
      return res.status(400).json({
        error: 'Missing files. Send one or more PDFs in form-data.'
      });
    }

    try {
      const outcomes = await processFilesWithConcurrency(
        files,
        config.bulkUploadConcurrency,
        async (file) => {
          try {
            const candidate = await saveCandidateFromFile(file);
            return {
              ok: true,
              fileName: file.originalname,
              candidate
            };
          } catch (error) {
            return {
              ok: false,
              fileName: file.originalname,
              error: error.message
            };
          } finally {
            await deleteTempFile(file.path);
          }
        }
      );

      const uploaded = outcomes
        .filter((result) => result?.ok)
        .map((result) => ({
          fileName: result.fileName,
          candidate: result.candidate
        }));

      const failed = outcomes
        .filter((result) => result && !result.ok)
        .map((result) => ({
          fileName: result.fileName,
          error: result.error
        }));

      const hasFailures = failed.length > 0;
      return res.status(hasFailures ? 207 : 201).json({
        message: hasFailures
          ? 'Bulk upload finished with partial failures.'
          : 'Bulk upload finished successfully.',
        totalFiles: files.length,
        concurrencyUsed: config.bulkUploadConcurrency,
        maxFilesPerRequest: config.maxFilesPerRequest > 0 ? config.maxFilesPerRequest : 'unlimited',
        uploadedCount: uploaded.length,
        failedCount: failed.length,
        uploaded,
        failed
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createBulkUploadRouter };
