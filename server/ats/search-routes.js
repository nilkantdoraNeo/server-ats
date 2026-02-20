const express = require('express');

function createSearchRouter({ supabase }) {
  const router = express.Router();

  function parseSkillsParam(rawSkills) {
    if (!rawSkills || typeof rawSkills !== 'string') {
      return [];
    }
    return rawSkills
      .split(',')
      .map((skill) => skill.trim().toLowerCase())
      .filter(Boolean);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function skillMatchesTerm(skill, term) {
    if (!skill || !term) {
      return false;
    }

    const normalizedSkill = String(skill).trim().toLowerCase();
    if (!normalizedSkill) {
      return false;
    }

    const pattern = new RegExp(`(^|[^a-z0-9+#.])${escapeRegExp(term)}($|[^a-z0-9+#.])`, 'i');
    return pattern.test(normalizedSkill);
  }

  function candidateHasAllTerms(candidate, terms) {
    const candidateSkills = Array.isArray(candidate?.skills)
      ? candidate.skills.map((skill) => String(skill || '').toLowerCase())
      : [];

    if (candidateSkills.length === 0) {
      return false;
    }

    return terms.every((term) => candidateSkills.some((skill) => skillMatchesTerm(skill, term)));
  }

  router.get('/search', async (req, res, next) => {
    const skills = parseSkillsParam(req.query.skills);

    if (skills.length === 0) {
      return res.status(400).json({
        error: 'Missing skills query parameter. Example: /api/ats/search?skills=java,spring'
      });
    }

    try {
      const [overlapResult, partialResult] = await Promise.all([
        supabase
          .from('candidates')
          .select('*')
          .overlaps('skills', skills)
          .order('created_at', { ascending: false }),
        supabase.rpc('search_candidates_by_skills_partial', {
          search_terms: skills
        })
      ]);

      const { data: overlapMatches, error: overlapError } = overlapResult;

      if (overlapError) {
        throw new Error(`Search failed: ${overlapError.message}`);
      }

      let mergedResults = overlapMatches || [];
      const { data: partialMatches, error: partialError } = partialResult;

      if (!partialError && Array.isArray(partialMatches) && partialMatches.length > 0) {
        const mergedById = new Map();
        for (const candidate of [...partialMatches, ...mergedResults]) {
          mergedById.set(candidate.id, candidate);
        }
        mergedResults = Array.from(mergedById.values());
      }

      const filteredResults = mergedResults
        .filter((candidate) => candidateHasAllTerms(candidate, skills))
        .sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at)
        );

      return res.status(200).json({
        count: filteredResults.length,
        candidates: filteredResults
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createSearchRouter };
