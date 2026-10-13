export interface CompetitionAudience {
  classLabel: string;
}

function normalizeClassLabel(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');

  const yearLevel = normalized.match(/^(?:year|yr)([1-9]|1[0-2])$/);
  if (yearLevel) {
    const level = Number(yearLevel[1]);
    if (level <= 6) return `primary${level}`;
    if (level <= 9) return `jss${level - 6}`;
    if (level <= 12) return `ss${level - 9}`;
  }

  const numberedGrade = normalized.match(/^(?:basic|primary|pry|p|grade)([1-6])$/);
  if (numberedGrade) return `primary${numberedGrade[1]}`;

  const basicSecondaryGrade = normalized.match(/^(?:basic|year|yr|grade)([7-9])$/);
  if (basicSecondaryGrade) return `jss${Number(basicSecondaryGrade[1]) - 6}`;

  const juniorSecondary = normalized.match(/^(?:jss|js|jhs|juniorsecondary|juniorsecondaryschool|juniorhigh|juniorhighschool)([1-3])$/);
  if (juniorSecondary) return `jss${juniorSecondary[1]}`;

  const seniorSecondary = normalized.match(/^(?:ss|sss|shs|seniorsecondary|seniorsecondaryschool|seniorhigh|seniorhighschool)([1-3])$/);
  if (seniorSecondary) return `ss${seniorSecondary[1]}`;

  return normalized;
}

export function parseCompetitionAudience(label: string | null | undefined): CompetitionAudience | null {
  if (!label) return null;
  const value = label.trim();
  const legacyMatch = value.match(/^Ages\s+\d{1,2}-\d{1,2}\s+·\s+(.+)$/i);
  const classLabel = (legacyMatch?.[1] ?? value).trim();
  if (!classLabel || /^ages\b/i.test(classLabel)) return null;
  return { classLabel };
}

export function calculateAge(dateOfBirth: Date, onDate = new Date()): number {
  let age = onDate.getFullYear() - dateOfBirth.getFullYear();
  const beforeBirthday = onDate.getMonth() < dateOfBirth.getMonth()
    || (onDate.getMonth() === dateOfBirth.getMonth() && onDate.getDate() < dateOfBirth.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function matchesCompetitionAudience(input: {
  audienceLabel: string | null | undefined;
  className: string | null | undefined;
}): boolean {
  const audience = parseCompetitionAudience(input.audienceLabel);
  if (!audience || !input.className) return false;
  const normalizedAudienceClass = normalizeClassLabel(audience.classLabel);
  return normalizedAudienceClass === normalizeClassLabel(input.className);
}