export type CompetitionExamPracticeEligibility = {
  examCode: string;
  countryCode: string;
  gradeLabel: string;
  isActive?: boolean | null;
  subjectName?: string | null;
};

export type CompetitionExamCode = 'WAEC' | 'BECE' | 'JUNIOR_WAEC';

const examGradeAliases: Record<string, Record<string, Record<string, string>>> = {
  GH: {
    WAEC: Object.fromEntries([1, 2, 3].flatMap((level) => [[`shs${level}`, `SHS ${level}`], [`seniorhigh${level}`, `SHS ${level}`], [`seniorhighschool${level}`, `SHS ${level}`], [`seniorsecondary${level}`, `SHS ${level}`], [`year${9 + level}`, `SHS ${level}`], [`yr${9 + level}`, `SHS ${level}`]])),
    BECE: Object.fromEntries([1, 2, 3].flatMap((level) => [[`jhs${level}`, `JHS ${level}`], [`juniorhigh${level}`, `JHS ${level}`], [`juniorhighschool${level}`, `JHS ${level}`], [`year${6 + level}`, `JHS ${level}`], [`yr${6 + level}`, `JHS ${level}`]])),
  },
  NG: {
    WAEC: Object.fromEntries([1, 2, 3].flatMap((level) => [[`ss${level}`, `SS ${level}`], [`sss${level}`, `SS ${level}`], [`seniorsecondary${level}`, `SS ${level}`], [`seniorsecondaryschool${level}`, `SS ${level}`], [`year${9 + level}`, `SS ${level}`], [`yr${9 + level}`, `SS ${level}`]])),
    JUNIOR_WAEC: Object.fromEntries([1, 2, 3].flatMap((level) => [[`jss${level}`, `JSS ${level}`], [`juniorsecondary${level}`, `JSS ${level}`], [`juniorsecondaryschool${level}`, `JSS ${level}`], [`year${6 + level}`, `JSS ${level}`], [`yr${6 + level}`, `JSS ${level}`]])),
  },
};

function normalizeLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

export function getCompetitionExamPracticeGrades(countryCode: string, examCode: string): string[] {
  const aliases = examGradeAliases[countryCode.trim().toUpperCase()]?.[examCode];
  return aliases ? Array.from(new Set(Object.values(aliases))) : [];
}

export function normalizeCompetitionExamPracticeGrade(countryCode: string, examCode: string, gradeLabel: string | null | undefined): string | null {
  if (!gradeLabel) return null;
  return examGradeAliases[countryCode.trim().toUpperCase()]?.[examCode]?.[normalizeLabel(gradeLabel)] ?? null;
}

export function isCompetitionExamPracticeSubjectAllowed(input: {
  countryCode: string;
  examCode: string;
  gradeLabel: string;
  subjectName: string | null | undefined;
}): boolean {
  const grade = normalizeCompetitionExamPracticeGrade(input.countryCode, input.examCode, input.gradeLabel);
  if (!grade) return false;
  if (!/^(?:SS|SHS) [1-3]$/.test(grade)) return true;
  if (!input.subjectName) return true;
  const subject = input.subjectName.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
  return !['basicscience', 'socialstudies'].includes(subject);
}

export function isEligibleForCompetitionExamPractice(input: {
  practice: CompetitionExamPracticeEligibility;
  schoolCountry: string | null | undefined;
  className: string | null | undefined;
  challengeStatus?: string | null;
  questionSetStatus?: string | null;
  isActive?: boolean | null;
}): boolean {
  if (!input.schoolCountry || !input.className) return false;
  if (input.challengeStatus && input.challengeStatus !== 'ACTIVE') return false;
  if (input.questionSetStatus && input.questionSetStatus !== 'APPROVED') return false;
  if (input.isActive !== undefined && input.isActive !== null && input.isActive !== true) return false;
  if (input.practice.isActive !== undefined && input.practice.isActive !== null && input.practice.isActive !== true) return false;
  if (!isCompetitionExamPracticeSubjectAllowed({
    countryCode: input.practice.countryCode,
    examCode: input.practice.examCode,
    gradeLabel: input.practice.gradeLabel,
    subjectName: input.practice.subjectName,
  })) return false;
  const schoolCountry = input.schoolCountry.trim().toUpperCase();
  if (input.practice.countryCode.trim().toUpperCase() !== schoolCountry) return false;
  const offeredGrade = normalizeCompetitionExamPracticeGrade(schoolCountry, input.practice.examCode, input.practice.gradeLabel);
  const learnerGrade = normalizeCompetitionExamPracticeGrade(schoolCountry, input.practice.examCode, input.className);
  return Boolean(offeredGrade && learnerGrade && offeredGrade === learnerGrade);
}