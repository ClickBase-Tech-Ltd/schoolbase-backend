export const REPORT_CARD_RATINGS = [
  'EXCELLENT',
  'VERY_GOOD',
  'GOOD',
  'SATISFACTORY',
  'NEEDS_IMPROVEMENT',
] as const;

export type ReportCardRating = (typeof REPORT_CARD_RATINGS)[number];

export interface ReportCardSectionsConfig {
  affectiveEnabled: boolean;
  psychomotorEnabled: boolean;
  attendanceEnabled: boolean;
  teacherCommentsEnabled: boolean;
  principalCommentsEnabled: boolean;
  affectiveIndicators: string[];
  psychomotorIndicators: string[];
}

export interface ReportCardAttendanceSummary {
  present: number;
  late: number;
  absent: number;
  excused: number;
  recordedDays: number;
  classRecordedDays: number;
  percentage: number | null;
  coverageComplete: boolean;
  unavailableReason: string | null;
}

export const DEFAULT_REPORT_CARD_SECTIONS: ReportCardSectionsConfig = {
  affectiveEnabled: false,
  psychomotorEnabled: false,
  attendanceEnabled: false,
  teacherCommentsEnabled: false,
  principalCommentsEnabled: false,
  affectiveIndicators: ['Attentiveness', 'Punctuality', 'Neatness', 'Cooperation', 'Self-control'],
  psychomotorIndicators: ['Handwriting', 'Sports', 'Drawing', 'Coordination'],
};

const configFlags = [
  'affectiveEnabled',
  'psychomotorEnabled',
  'attendanceEnabled',
  'teacherCommentsEnabled',
  'principalCommentsEnabled',
] as const;

function normalizeIndicators(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error('Each indicator list must contain no more than 12 items');
  }
  const indicators = value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 40) {
      throw new Error('Indicators must be non-empty text of at most 40 characters');
    }
    return item.trim();
  });
  if (new Set(indicators.map((item) => item.toLowerCase())).size !== indicators.length) {
    throw new Error('Indicators must be unique');
  }
  return indicators.length > 0 ? indicators : fallback;
}

export function normalizeReportCardSectionsConfig(input: unknown): ReportCardSectionsConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('A report-card sections configuration is required');
  }
  const value = input as Record<string, unknown>;
  for (const flag of configFlags) {
    if (typeof value[flag] !== 'boolean') {
      throw new Error(`${flag} must be a boolean`);
    }
  }
  return {
    affectiveEnabled: value.affectiveEnabled as boolean,
    psychomotorEnabled: value.psychomotorEnabled as boolean,
    attendanceEnabled: value.attendanceEnabled as boolean,
    teacherCommentsEnabled: value.teacherCommentsEnabled as boolean,
    principalCommentsEnabled: value.principalCommentsEnabled as boolean,
    affectiveIndicators: normalizeIndicators(value.affectiveIndicators, DEFAULT_REPORT_CARD_SECTIONS.affectiveIndicators),
    psychomotorIndicators: normalizeIndicators(value.psychomotorIndicators, DEFAULT_REPORT_CARD_SECTIONS.psychomotorIndicators),
  };
}

export function readReportCardSectionsConfig(value: string | null | undefined): ReportCardSectionsConfig {
  if (!value) return { ...DEFAULT_REPORT_CARD_SECTIONS };
  return normalizeReportCardSectionsConfig(JSON.parse(value));
}

export function isReportCardRating(value: unknown): value is ReportCardRating {
  return typeof value === 'string' && REPORT_CARD_RATINGS.includes(value as ReportCardRating);
}

export function buildReportCardAttendanceSummary(
  records: Array<{ status: string }>,
  classRecordedDays: number,
): ReportCardAttendanceSummary {
  const present = records.filter((row) => row.status === 'PRESENT').length;
  const late = records.filter((row) => row.status === 'LATE').length;
  const absent = records.filter((row) => row.status === 'ABSENT').length;
  const excused = records.filter((row) => row.status === 'EXCUSED').length;
  const eligibleDays = present + late + absent;
  const coverageComplete = classRecordedDays > 0 && records.length === classRecordedDays;

  return {
    present,
    late,
    absent,
    excused,
    recordedDays: records.length,
    classRecordedDays,
    percentage: coverageComplete && eligibleDays > 0
      ? Math.round(((present + late) / eligibleDays) * 10000) / 100
      : null,
    coverageComplete,
    unavailableReason: classRecordedDays === 0
      ? 'No attendance has been recorded for this class during the term'
      : coverageComplete ? null : 'Attendance records are incomplete for this pupil',
  };
}
