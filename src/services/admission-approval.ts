type AdmissionApprovalClient = {
  admissionApplication: {
    findFirst(args: any): Promise<{ id: string; schoolId: string; studentId: string | null; status: string } | null>;
  };
  pupil: {
    findFirst(args: any): Promise<any>;
  };
};

export async function findCompletedAdmissionConversion(
  prisma: AdmissionApprovalClient,
  schoolId: string,
  applicationId: string,
) {
  const application = await prisma.admissionApplication.findFirst({
    where: { id: applicationId, schoolId, status: 'APPROVED', studentId: { not: null } },
    select: { id: true, schoolId: true, studentId: true, status: true },
  });
  if (!application?.studentId) return null;

  const student = await prisma.pupil.findFirst({
    where: { id: application.studentId, schoolId },
    select: { id: true, admissionNo: true, firstName: true, lastName: true },
  });
  if (!student) return null;

  return { application, student };
}
