const express = require('express');
const multer = require('multer');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createGoogleMeetEvent } = require("./google");
const nodemailer = require("nodemailer");
const { createAtsRouter } = require('./ats/ats-routes');
const { createSearchRouter } = require('./ats/search-routes');
const { createBulkUploadRouter } = require('./ats/bulk-upload-routes');
const {
  DuplicateCandidateError,
  buildDedupKeys,
  buildResumeHash,
  buildResumeStoragePath,
  findExistingCandidate,
  getResumePublicUrl,
  isStorageAlreadyExistsError,
  isUniqueViolation,
  normalizeEmail,
  normalizePhone,
  withDedupLock
} = require('./ats/candidate-dedup');

function loadEnvFiles() {
  const envPaths = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '.env')
  ];

  let loadedAny = false;
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
      loadedAny = true;
    }
  }

  if (!loadedAny) {
    dotenv.config();
  }
}

loadEnvFiles();

// ------------------------
// SUPABASE CONFIG
// ------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rawAtsSupabaseUrl = process.env.ATS_SUPABASE_URL;
const rawAtsSupabaseServiceRoleKey = process.env.ATS_SUPABASE_SERVICE_ROLE_KEY;

function normalizeEnvValue(value) {
  return (value || '').trim().toLowerCase();
}

function isPlaceholderKey(value) {
  if (!value) {
    return false;
  }

  const normalized = normalizeEnvValue(value);
  return (
    normalized.includes('your-service-role-key') ||
    normalized.includes('your-ats-service-role-key') ||
    normalized.includes('your-service-role-key-here') ||
    normalized.includes('place your key') ||
    normalized.includes('place ur key') ||
    normalized.includes('replace-with-real-key')
  );
}

function isPlaceholderUrl(value) {
  if (!value) {
    return false;
  }

  const normalized = normalizeEnvValue(value);
  return (
    normalized.includes('your-project.supabase.co') ||
    normalized.includes('your-ats-project.supabase.co') ||
    normalized.includes('place your url') ||
    normalized.includes('place ur url') ||
    normalized.includes('replace-with-real-url')
  );
}

const hasExplicitAtsConfig =
  rawAtsSupabaseUrl &&
  rawAtsSupabaseServiceRoleKey &&
  !isPlaceholderUrl(rawAtsSupabaseUrl) &&
  !isPlaceholderKey(rawAtsSupabaseServiceRoleKey);

const ATS_SUPABASE_URL = hasExplicitAtsConfig ? rawAtsSupabaseUrl : SUPABASE_URL;
const ATS_SUPABASE_SERVICE_ROLE_KEY = hasExplicitAtsConfig
  ? rawAtsSupabaseServiceRoleKey
  : SUPABASE_SERVICE_ROLE_KEY;

function getProjectRef(url) {
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return 'unknown';
  }
}

function parseSkillsField(rawSkills) {
  if (!rawSkills) {
    return [];
  }

  if (Array.isArray(rawSkills)) {
    return Array.from(
      new Set(
        rawSkills
          .map((skill) => String(skill || '').trim())
          .filter(Boolean)
      )
    );
  }

  const input = String(rawSkills).trim();
  if (!input) {
    return [];
  }

  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return Array.from(
        new Set(
          parsed
            .map((skill) => String(skill || '').trim())
            .filter(Boolean)
        )
      );
    }
  } catch {
    // Ignore and treat as comma-separated text.
  }

  return Array.from(
    new Set(
      input
        .split(',')
        .map((skill) => skill.trim())
        .filter(Boolean)
    )
  );
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
  process.exit(1);
}

if (!hasExplicitAtsConfig && (rawAtsSupabaseUrl || rawAtsSupabaseServiceRoleKey)) {
  console.warn(
    'ATS_SUPABASE_* is missing or placeholder. Falling back to SUPABASE_* until ATS values are provided.'
  );
}

if (isPlaceholderUrl(SUPABASE_URL) || isPlaceholderKey(SUPABASE_SERVICE_ROLE_KEY)) {
  console.warn(
    'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY appears to be placeholder values. API requests may fail until real values are set.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const atsSupabase = createClient(ATS_SUPABASE_URL, ATS_SUPABASE_SERVICE_ROLE_KEY);

console.log(
  `[supabase] main=${getProjectRef(SUPABASE_URL)} ats=${getProjectRef(ATS_SUPABASE_URL)}`
);

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer();
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.use('/api/ats', createAtsRouter({ supabase: atsSupabase }));
app.use('/api/ats', createSearchRouter({ supabase: atsSupabase }));
app.use('/api/ats', createBulkUploadRouter({ supabase: atsSupabase }));

// ------------------------
// GMAIL SMTP CONFIG
// ------------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});


// ----------------------------------------------------
// UPLOAD RESUME API
// ----------------------------------------------------
app.post('/upload', upload.single('resume'), async (req, res) => {
  try {
    const file = req.file;
    const body = req.body || {};

    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const normalizedEmail = normalizeEmail(body.email);
    const normalizedPhone = normalizePhone(body.phone);
    const resumeHash = buildResumeHash(file.buffer);
    const storagePath = buildResumeStoragePath(resumeHash, 'resumes');
    const resumeUrl = getResumePublicUrl(supabase, 'resumes', storagePath);
    const dedupKeys = buildDedupKeys({
      email: normalizedEmail,
      phone: normalizedPhone
    });

    await withDedupLock(dedupKeys, async () => {
      const existingBeforeUpload = await findExistingCandidate({
        supabase,
        email: normalizedEmail,
        phone: normalizedPhone
      });

      if (existingBeforeUpload) {
        throw new DuplicateCandidateError(
          `Duplicate candidate skipped (matched by ${existingBeforeUpload.matchBy}).`,
          existingBeforeUpload
        );
      }

      const { error: uploadError } = await supabase.storage
        .from('resumes')
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });

      if (uploadError && !isStorageAlreadyExistsError(uploadError)) {
        console.error('Storage upload error:', uploadError);
        throw new Error(uploadError.message || String(uploadError));
      }

      const record = {
        name: body.name,
        email: normalizedEmail,
        phone: normalizedPhone,
        last_ctc: body.lastCtc || null,
        expected_ctc: body.expectedCtc || null,
        notice_period: body.noticePeriod || null,
        notice_end_date: body.noticeEndDate || null,
        experience: body.experience || null,
        skills: parseSkillsField(body.skills),
        resume_url: resumeUrl,
        current_location: body.current_location || null,
        status: 5,
        is_bookmarked: body.is_bookmarked === 'true',
        created_at: new Date().toISOString(),
      };

      const { error: insertError } = await supabase.from('candidates').insert([record]);
      if (insertError) {
        if (isUniqueViolation(insertError)) {
          const existingAfterConflict = await findExistingCandidate({
            supabase,
            email: normalizedEmail,
            phone: normalizedPhone
          });

          throw new DuplicateCandidateError(
            `Duplicate candidate skipped (matched by ${existingAfterConflict?.matchBy || 'constraint'}).`,
            existingAfterConflict || {}
          );
        }

        console.error('Insert error:', insertError);
        throw new Error(insertError.message || String(insertError));
      }
    });

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DuplicateCandidateError) {
      return res.status(409).json({
        error: 'User already exists with same email or phone number.',
        duplicateCandidateId: err.details?.candidate?.id || null
      });
    }

    console.error('Upload server error:', err);
    res.status(500).json({ error: String(err) });
  }
});


// ----------------------------------------------------
// SCHEDULE INTERVIEW API
// ----------------------------------------------------
app.post("/scheduleInterview", async (req, res) => {
  try {
    const body = req.body;

    const start = body.start || `${body.date}T${body.time}:00`;
    const endObj = new Date(start);
    endObj.setMinutes(endObj.getMinutes() + Number(body.duration));
    const end = endObj.toISOString();

    // 1️⃣ CREATE MEET LINK (NO ATTENDEES)
    const meetLink = await createGoogleMeetEvent({
      title: `Interview: ${body.candidate_name}`,
      start,
      end
    });

    // 2️⃣ SAVE TO SUPABASE
    await supabase.from("interviews").insert({
      candidate_id: body.candidate_id,
      interviewer_name: body.interviewer_name,
      interviewer_email: body.interviewer_email,
      scheduled_at: start,
      duration_minutes: body.duration,
      meet_link: meetLink,
    });

    // 3️⃣ SEND EMAIL MANUALLY
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: [body.candidate_email, body.interviewer_email],
      subject: "Interview Scheduled",
      html: 
      // `
      //   <h2>Your interview has been scheduled</h2>
      //   <p><b>Candidate:</b> ${body.candidate_name}</p>
      //   <p><b>Interviewer:</b> ${body.interviewer_name}</p>
      //   <p><b>Date:</b> ${body.date}</p>
      //   <p><b>Time:</b> ${body.time}</p>
      //   <p><b>Meet Link:</b> <a href="${meetLink}">${meetLink}</a></p>
      //   <p>Please join on time.</p>
      // `
      `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; 
      background: #ffffff; border-radius: 10px; border: 1px solid #e6e6e6;">
    
    <h2 style="text-align:center; color:#333;">🧭 Interview Scheduled</h2>

    <p style="font-size:16px; color:#444;">
      Hello <strong>${body.candidate_name}</strong>,
    </p>

    <p style="font-size:15px; color:#444;">
      Your interview has been successfully scheduled. Below are the details:
    </p>
    <div style="background:#f7f7f7; padding:15px; border-radius:8px; margin-top:15px;">
      <p><strong>👤 Candidate:</strong> ${body.candidate_name}</p>
      <p><strong>🧑‍💼 Interviewer:</strong> ${body.interviewer_name}</p>
      <p><strong>🧭 Date:</strong> ${body.date}</p>
      <p><strong>⏰ Time:</strong> ${body.time}</p>
      <p><strong>⏳ Duration:</strong> ${body.duration} minutes</p>
    </div>

    <div style="text-align:center; margin-top:25px;">
      <a href="${meetLink}" 
         style="background:#007bff; color:white; padding:12px 20px; border-radius:6px; 
                text-decoration:none; font-size:16px; display:inline-block;">
        Join Google Meet
      </a>
    </div>

    <p style="font-size:14px; color:#666; margin-top:20px;">
      Please join 5 minutes early to ensure a smooth start.
    </p>

    <hr style="margin-top:25px;">
    <p style="font-size:12px; color:#999; text-align:center;">
      This is an automated email from MimioTech Recruitment Portal. Please do not reply.
    </p>

  </div>
`
    });

    res.json({ ok: true, meetLink });

  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: err.message });
  }
});


// ----------------------------------------------------
app.use((error, _req, res, _next) => {
  const maxFilesPerRequestRaw = Number(process.env.MAX_FILES_PER_REQUEST);
  const maxFilesPerRequest =
    Number.isFinite(maxFilesPerRequestRaw) && maxFilesPerRequestRaw >= 0
      ? Math.floor(maxFilesPerRequestRaw)
      : 500;
  const maxFileSizeMbRaw = Number(process.env.MAX_RESUME_FILE_SIZE_MB);
  const maxFileSizeMb =
    Number.isFinite(maxFileSizeMbRaw) && maxFileSizeMbRaw > 0 ? maxFileSizeMbRaw : 10;

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `File too large. Max size is ${maxFileSizeMb}MB.`
    });
  }

  if (error.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      error: maxFilesPerRequest > 0
        ? `Too many files. Max ${maxFilesPerRequest} files per request.`
        : 'Too many files.'
    });
  }

  if (error.message === 'Only PDF files are allowed.') {
    return res.status(400).json({ error: error.message });
  }

  console.error(error);
  return res.status(500).json({ error: error.message || 'Internal server error' });
});

// ----------------------------------------------------
const port = process.env.PORT || 3333;
const server = app.listen(port, () => console.log(`Server running on port ${port}`));

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the old API process, then restart.`);
    return;
  }

  console.error('API server failed to start:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
