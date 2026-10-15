export function buildAdmissionInboxWhere(schoolId: string, recipientUserId: string) {
  return { schoolId, recipientUserId };
}

export function buildAdmissionNotificationRecipientWhere(
  notificationId: string,
  schoolId: string,
  recipientUserId: string,
) {
  return { id: notificationId, schoolId, recipientUserId };
}
