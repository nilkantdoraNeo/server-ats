const SKILL_LIST = [
  'java',
  'spring',
  'spring boot',
  'javascript',
  'typescript',
  'node.js',
  'express',
  'react',
  'angular',
  'vue',
  'python',
  'django',
  'flask',
  'fastapi',
  'c',
  'c++',
  'c#',
  '.net',
  'go',
  'rust',
  'php',
  'laravel',
  'ruby',
  'rails',
  'sql',
  'postgresql',
  'mysql',
  'mongodb',
  'redis',
  'html',
  'css',
  'tailwind',
  'docker',
  'kubernetes',
  'aws',
  'azure',
  'gcp',
  'terraform',
  'git',
  'graphql',
  'rest',
  'microservices',
  'linux',
  'ci/cd',
  'jenkins',
  'github actions',
  'machine learning',
  'data analysis',
  'pandas',
  'numpy'
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toTitleCase(value) {
  return value
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function extractPhone(text) {
  const match = text.match(
    /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/
  );

  if (!match) {
    return null;
  }

  const digits = match[0].replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function extractName(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);

  for (const line of lines) {
    if (line.length < 3 || line.length > 60) {
      continue;
    }
    if (line.includes('@')) {
      continue;
    }
    if (/\d{3,}/.test(line)) {
      continue;
    }

    const cleaned = line.replace(/[^a-zA-Z\s'.-]/g, '').replace(/\s+/g, ' ').trim();
    const words = cleaned.split(' ').filter(Boolean);

    if (words.length >= 2 && words.length <= 4) {
      return toTitleCase(cleaned);
    }
  }

  return 'Unknown';
}

function extractSkills(text) {
  const normalizedText = text.toLowerCase();

  const found = SKILL_LIST.filter((skill) => {
    const pattern = new RegExp(`(^|[^a-z0-9+#.])${escapeRegExp(skill)}($|[^a-z0-9+#.])`, 'i');
    return pattern.test(normalizedText);
  }).map((skill) => skill.toLowerCase());

  return Array.from(new Set(found));
}

function parseResumeText(text) {
  return {
    name: extractName(text),
    email: extractEmail(text),
    phone: extractPhone(text),
    skills: extractSkills(text)
  };
}

module.exports = {
  parseResumeText
};
