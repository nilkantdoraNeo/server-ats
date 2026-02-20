const crypto = require('crypto');

class DuplicateCandidateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DuplicateCandidateError';
    this.code = 'DUPLICATE_CANDIDATE';
    this.details = details;
  }
}

const inFlightDedupKeys = new Set();

function normalizeEmail(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizePhone(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (!digits) {
    return null;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function normalizeName(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function normalizeSkills(skills) {
  if (!Array.isArray(skills)) {
    return [];
  }

  return Array.from(
    new Set(
      skills
        .map((skill) => (typeof skill === 'string' ? skill.trim().toLowerCase() : ''))
        .filter(Boolean)
    )
  );
}

function normalizeCandidatePayload(parsed, resumeUrl) {
  return {
    name: normalizeName(parsed?.name),
    email: normalizeEmail(parsed?.email),
    phone: normalizePhone(parsed?.phone),
    skills: normalizeSkills(parsed?.skills),
    resume_url: resumeUrl || null
  };
}

function buildResumeHash(fileBuffer) {
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function buildResumeStoragePath(resumeHash, prefix = 'uploads') {
  const normalizedPrefix = String(prefix || 'uploads').replace(/^\/+|\/+$/g, '');
  return `${normalizedPrefix}/${resumeHash}.pdf`;
}

function getResumePublicUrl(supabase, bucket, storagePath) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data?.publicUrl || null;
}

function buildDedupKeys({ email, phone, resumeHash }) {
  return [email ? `email:${email}` : null, phone ? `phone:${phone}` : null, resumeHash ? `hash:${resumeHash}` : null]
    .filter(Boolean)
    .sort();
}

async function withDedupLock(keys, fn) {
  for (const key of keys) {
    if (inFlightDedupKeys.has(key)) {
      throw new DuplicateCandidateError('Duplicate candidate is already being processed.', {
        matchBy: key.split(':')[0]
      });
    }
  }

  keys.forEach((key) => inFlightDedupKeys.add(key));

  try {
    return await fn();
  } finally {
    keys.forEach((key) => inFlightDedupKeys.delete(key));
  }
}

async function queryCandidateByEmail(supabase, email) {
  if (!email) {
    return null;
  }

  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed duplicate check by email: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function queryCandidateByPhone(supabase, phone) {
  if (!phone) {
    return null;
  }

  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed duplicate check by phone: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function queryCandidateByResumeUrl(supabase, resumeUrl) {
  if (!resumeUrl) {
    return null;
  }

  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('resume_url', resumeUrl)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed duplicate check by resume URL: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function findExistingCandidate({ supabase, email, phone, resumeUrl }) {
  const byEmail = await queryCandidateByEmail(supabase, email);
  if (byEmail) {
    return { candidate: byEmail, matchBy: 'email' };
  }

  const byPhone = await queryCandidateByPhone(supabase, phone);
  if (byPhone) {
    return { candidate: byPhone, matchBy: 'phone' };
  }

  const byResumeUrl = await queryCandidateByResumeUrl(supabase, resumeUrl);
  if (byResumeUrl) {
    return { candidate: byResumeUrl, matchBy: 'resume' };
  }

  return null;
}

function isStorageAlreadyExistsError(error) {
  if (!error) {
    return false;
  }

  const statusCode = Number(error.statusCode);
  const message = (error.message || '').toLowerCase();
  return statusCode === 409 || message.includes('already exists');
}

function isUniqueViolation(error) {
  return error?.code === '23505';
}

module.exports = {
  DuplicateCandidateError,
  buildDedupKeys,
  buildResumeHash,
  buildResumeStoragePath,
  findExistingCandidate,
  getResumePublicUrl,
  isStorageAlreadyExistsError,
  isUniqueViolation,
  normalizeCandidatePayload,
  normalizeEmail,
  normalizePhone,
  withDedupLock
};
