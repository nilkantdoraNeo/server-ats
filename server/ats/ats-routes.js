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

function parseSkillsParam(rawSkills) {
  if (!rawSkills || typeof rawSkills !== 'string') {
    return [];
  }

  return rawSkills
    .split(',')
    .map((skill) => skill.trim().toLowerCase())
    .filter(Boolean);
}

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

function createAtsRouter({ supabase }) {
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

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.post('/upload-resume', upload.any(), async (req, res, next) => {
    const files = Array.isArray(req.files) ? req.files : [];

    if (files.length === 0) {
      return res.status(400).json({
        error: 'Missing file. Send one PDF in form-data.'
      });
    }

    if (files.length > 1) {
      await Promise.all(files.map((file) => deleteTempFile(file.path)));
      return res.status(400).json({
        error: 'Too many files for /upload-resume. Send exactly one PDF.'
      });
    }

    const [file] = files;

    try {
      const candidate = await saveCandidateFromFile(file);
      return res.status(201).json({
        message: 'Resume uploaded and candidate saved successfully.',
        candidate
      });
    } catch (error) {
      if (error instanceof DuplicateCandidateError) {
        return res.status(409).json({
          error: error.message,
          duplicateCandidateId: error.details?.candidate?.id || null
        });
      }

      return next(error);
    } finally {
      await deleteTempFile(file.path);
    }
  });


  // Bulk upload and search endpoints are now in separate routers

  router.get('/candidates', async (req, res, next) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    try {
      const { data: candidates, error, count } = await supabase
        .from('candidates')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw new Error(`Failed to list candidates: ${error.message}`);
      }

      return res.status(200).json({
        count: candidates?.length || 0,
        totalCount: count ?? 0,
        limit,
        offset,
        candidates: candidates || []
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/candidate/:id', async (req, res, next) => {
    try {
      const { data: candidate, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

      if (error) {
        throw new Error(`Failed to fetch candidate: ${error.message}`);
      }

      if (!candidate) {
        return res.status(404).json({ error: 'Candidate not found.' });
      }

      return res.status(200).json(candidate);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  createAtsRouter
};
