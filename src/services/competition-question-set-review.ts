export function canApproveCompetitionQuestionSet(questionStatuses: readonly string[]): boolean {
  return questionStatuses.length > 0
    && questionStatuses.some((status) => status === 'APPROVED')
    && questionStatuses.every((status) => status === 'APPROVED' || status === 'REJECTED');
}