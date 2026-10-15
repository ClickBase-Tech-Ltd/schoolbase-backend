type AdmissionApplicationClient = {
  admissionApplication: {
    findFirst(args: any): Promise<any>;
  };
};

export async function findAdmissionByRequestKey(
  prisma: AdmissionApplicationClient,
  schoolId: string,
  requestKey: string,
  query: Record<string, unknown> = {},
) {
  return prisma.admissionApplication.findFirst({
    ...query,
    where: { ...(query.where as Record<string, unknown> | undefined), schoolId, requestKey },
  });
}

export async function findSchoolScopedAdmissionApplication(
  prisma: AdmissionApplicationClient,
  schoolId: string,
  applicationId: string,
  query: Record<string, unknown> = {},
) {
  return prisma.admissionApplication.findFirst({
    ...query,
    where: { ...(query.where as Record<string, unknown> | undefined), id: applicationId, schoolId },
  });
}
