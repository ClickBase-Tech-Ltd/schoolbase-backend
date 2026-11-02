export interface BulkReportCardFailure {
  pupilId: string;
  error: unknown;
}

export class BulkReportCardGenerationError extends Error {
  constructor(readonly failures: BulkReportCardFailure[]) {
    const pupilIds = failures.map((failure) => failure.pupilId).join(', ');
    super(`Failed to generate report cards for ${failures.length} pupil${failures.length === 1 ? '' : 's'}: ${pupilIds}`);
    this.name = 'BulkReportCardGenerationError';
  }
}

export async function generateCompleteBulkReportCards<T>(
  pupilIds: string[],
  generate: (pupilId: string) => Promise<T>,
): Promise<T[]> {
  const reportCards: T[] = [];
  const failures: BulkReportCardFailure[] = [];

  for (const pupilId of pupilIds) {
    try {
      reportCards.push(await generate(pupilId));
    } catch (error) {
      failures.push({ pupilId, error });
    }
  }

  if (failures.length > 0) throw new BulkReportCardGenerationError(failures);
  return reportCards;
}
