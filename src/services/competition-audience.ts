export interface CompetitionAudience {
  classLabel: string;
}

function normalizeClassLabel(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
  const numberedGrade = normalized.match(/^(basic|primary|pry|p)([1-6])$/);
  if (numberedGrade) return `primary${numberedGrade[2]}`;
  const basicSecondaryGrade = normalized.match(/^basic([7-9])$/);
  if (basicSecondaryGrade) return `jss${Number(basicSecondaryGrade[1]) - 6}`;

  const juniorSecondary = normalized.match(/^(jss|js|juniorsecondary|juniorsecondaryschool)([1-3])$/);
  if (juniorSecondary) return `jss${juniorSecondary[2]}`;

  const seniorSecondary = normalized.match(/^(ss|sss|seniorsecondary|seniorsecondaryschool)([1-3])$/);
  if (seniorSecondary) return `ss${seniorSecondary[2]}`;

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