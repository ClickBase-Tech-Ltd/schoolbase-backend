import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { validateAccountingJournalEntry } from '../src/services/accounting-journal.js';
import { buildFinancialTransactionJournalLines } from '../src/services/accounting-transaction-posting.js';
import { classifyFinancialTransactionForBackfill } from '../src/services/financial-journal-backfill.js';

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const schoolIdArg = process.argv.find((argument) => argument.startsWith('--school-id='))?.slice('--school-id='.length);
const actorIdArg = process.argv.find((argument) => argument.startsWith('--actor-user-id='))?.slice('--actor-user-id='.length);
const apply = args.has('--apply');
const assumeDefaultAccounts = args.has('--assume-default-accounts');
const defaultAccounts = [
  { code: '1000', name: 'Cash on Hand', type: 'ASSET', description: 'Physical cash held by the school' },
  { code: '1010', name: 'Cash at Bank', type: 'ASSET', description: 'Primary bank cash account' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', description: 'Outstanding school fees receivable' },
  { code: '1200', name: 'Payment Processor Clearing', type: 'ASSET', description: 'Card and online receipts pending provider settlement' },
  { code: '2000', name: 'Fees Payable', type: 'LIABILITY', description: 'School fee liabilities or clearing balances' },
  { code: '2100', name: 'Accounts Payable', type: 'LIABILITY', description: 'Approved expenses payable to suppliers' },
  { code: '3000', name: 'Retained Earnings', type: 'EQUITY', description: 'Opening retained earnings' },
  { code: '4000', name: 'Fee Income', type: 'REVENUE', description: 'Fee collection income' },
  { code: '4100', name: 'Other Income', type: 'REVENUE', description: 'Non-fee operational income' },
  { code: '5000', name: 'Operating Expenses', type: 'EXPENSE', description: 'General operating expenses' },
] as const;

interface PaymentBackfillRow {
  id: string;
  invoiceId: string;
  amount: number;
  method: string;
  reference: string | null;
  paidAt: Date;
  schoolId: string;
  invoiceNo: string | null;
}

function feeIncomeCategory(name: string): boolean {
  const normalized = name.toLowerCase();
  return ['school fees', 'tuition fees', 'transport fees', 'exam fees', 'boarding fees', 'registration fees', 'books fees', 'uniform fees']
    .some((keyword) => normalized.includes(keyword));
}

function accountMapping(accounts: Array<{ id: string; code: string }>) {
  return new Map(accounts.map((account) => [account.code, account.id]));
}

async function schoolAccountIds(schoolId: string, codes: string[]) {
  const accounts = await prisma.accountingAccount.findMany({
    where: { schoolId, isActive: true, code: { in: codes } },
    select: { id: true, code: true },
  });
  return accountMapping(accounts);
}

async function run() {
  if (apply && (!schoolIdArg || !actorIdArg)) {
    throw new Error('Applying a backfill requires both --school-id=<school> and --actor-user-id=<authorized-school-user>.');
  }
  if (!apply) {
    console.log('DRY RUN ONLY. No financial records will be changed.');
    console.log('To apply a reviewed school-specific plan, rerun with --apply --school-id=<id> --actor-user-id=<id>.');
    if (assumeDefaultAccounts) console.log('Dry-run assumes missing standard chart accounts will be seeded by apply mode.');
  }

  const where = schoolIdArg ? { schoolId: schoolIdArg } : {};
  const transactions = await prisma.financialTransaction.findMany({
    where,
    include: { category: { select: { name: true } } },
    orderBy: [{ schoolId: 'asc' }, { id: 'asc' }],
  });
  if (apply) {
    const actor = await prisma.user.findFirst({
      where: { id: actorIdArg, schoolId: schoolIdArg, role: { in: ['SCHOOL_ADMIN', 'BURSAR'] } },
      select: { id: true },
    });
    if (!actor) throw new Error('The audit actor must be an existing BURSAR or SCHOOL_ADMIN in the target school.');
  }

  let defaultAccountsCreated = 0;
  if (apply) {
    const seeded = await prisma.accountingAccount.createMany({
      data: defaultAccounts.map((account) => ({ schoolId: schoolIdArg!, ...account })),
      skipDuplicates: true,
    });
    defaultAccountsCreated = seeded.count;
  }

  const summary = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    schoolId: schoolIdArg ?? 'ALL',
    scanned: transactions.length,
    paymentsScanned: 0,
    defaultAccountsCreated,
    defaultAccountsWouldBeSeeded: 0,
    schoolsWithDefaultAccountsToSeed: 0,
    feePaymentsEligible: 0,
    feePaymentJournalsCreated: 0,
    eligible: 0,
    created: 0,
    skippedStatus: 0,
    skippedSourceLinked: 0,
    skippedExisting: 0,
    skippedClosedPeriod: 0,
    skippedMissingAccount: 0,
    skippedInvalidJournal: 0,
    skippedConcurrent: 0,
  };
  const accountsBySchool = new Map<string, Map<string, string>>();
  const schoolsWithSimulatedAccounts = new Set<string>();

  const payments: PaymentBackfillRow[] = schoolIdArg
    ? await prisma.$queryRaw<PaymentBackfillRow[]>`
        SELECT p.id, p.invoiceId, p.amount, p.method, p.reference, p.paidAt, i.schoolId, i.invoiceNo
        FROM Payment p
        INNER JOIN Invoice i ON i.id = p.invoiceId
        WHERE i.schoolId = ${schoolIdArg}
        ORDER BY p.invoiceId ASC, p.paidAt ASC, p.id ASC
      `
    : await prisma.$queryRaw<PaymentBackfillRow[]>`
        SELECT p.id, p.invoiceId, p.amount, p.method, p.reference, p.paidAt, i.schoolId, i.invoiceNo
        FROM Payment p
        INNER JOIN Invoice i ON i.id = p.invoiceId
        ORDER BY i.schoolId ASC, p.invoiceId ASC, p.paidAt ASC, p.id ASC
      `;
  summary.paymentsScanned = payments.length;

  for (const payment of payments) {
    const paymentSchoolId = payment.schoolId;
    if (!paymentSchoolId) continue;
    const existing = await prisma.accountingJournalEntry.findFirst({
      where: { schoolId: paymentSchoolId, sourceType: 'FEE_PAYMENT', sourceId: payment.id },
      select: { id: true },
    });
    if (existing) { summary.skippedExisting += 1; continue; }
    if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0) { summary.skippedInvalidJournal += 1; continue; }

    const tenderCode = payment.method === 'CASH' ? '1000' : payment.method === 'CARD' || payment.method === 'ONLINE' ? '1200' : '1010';
    let accountIds = accountsBySchool.get(paymentSchoolId);
    if (!accountIds) {
      accountIds = await schoolAccountIds(paymentSchoolId, ['1000', '1010', '1200', '4000', '4100', '5000', '2100']);
      if (!apply && assumeDefaultAccounts) {
        const missingDefaults = defaultAccounts.filter((account) => !accountIds?.has(account.code));
        if (missingDefaults.length > 0) {
          summary.defaultAccountsWouldBeSeeded += missingDefaults.length;
          schoolsWithSimulatedAccounts.add(paymentSchoolId);
          for (const account of missingDefaults) accountIds.set(account.code, `DRY-RUN-${paymentSchoolId}-${account.code}`);
        }
      }
      accountsBySchool.set(paymentSchoolId, accountIds);
    }
    if (!accountIds.has(tenderCode) || !accountIds.has('4000')) { summary.skippedMissingAccount += 1; continue; }

    const closedPeriod = await prisma.accountingPeriod.findFirst({
      where: { schoolId: paymentSchoolId, status: 'CLOSED', startDate: { lte: payment.paidAt }, endDate: { gte: payment.paidAt } },
      select: { name: true },
    });
    if (closedPeriod) { summary.skippedClosedPeriod += 1; continue; }

    const lines = buildFinancialTransactionJournalLines({
      type: 'INCOME',
      amountMinor: payment.amount,
      paymentMethod: payment.method,
      accounts: {
        cashAccountId: accountIds.get('1000') ?? accountIds.get(tenderCode)!,
        bankAccountId: accountIds.get('1010') ?? accountIds.get(tenderCode)!,
        clearingAccountId: accountIds.get('1200') ?? accountIds.get(tenderCode)!,
        incomeAccountId: accountIds.get('4000')!,
        expenseAccountId: accountIds.get('5000') ?? accountIds.get('4000')!,
        accountsPayableAccountId: accountIds.get('2100') ?? accountIds.get('4000')!,
      },
      description: `Fee payment ${payment.reference || payment.id}`,
    });
    if (!lines || !validateAccountingJournalEntry({ lines }).valid) { summary.skippedInvalidJournal += 1; continue; }
    summary.feePaymentsEligible += 1;
    if (!apply) continue;

    try {
      await prisma.$transaction(async (tx) => {
        const duplicate = await tx.accountingJournalEntry.findFirst({
          where: { schoolId: paymentSchoolId, sourceType: 'FEE_PAYMENT', sourceId: payment.id },
          select: { id: true },
        });
        if (duplicate) throw new Error('BACKFILL_ALREADY_EXISTS');
        const periodClosed = await tx.accountingPeriod.findFirst({
          where: { schoolId: paymentSchoolId, status: 'CLOSED', startDate: { lte: payment.paidAt }, endDate: { gte: payment.paidAt } },
          select: { name: true },
        });
        if (periodClosed) throw new Error('BACKFILL_PERIOD_CLOSED');

        await tx.accountingJournalEntry.create({
          data: {
            schoolId: paymentSchoolId,
            reference: `FEE-PAY-${payment.id}`,
            description: `Historical fee payment backfill for ${payment.invoiceNo || payment.id}`,
            entryDate: payment.paidAt,
            status: 'POSTED',
            sourceType: 'FEE_PAYMENT',
            sourceId: payment.id,
            idempotencyKey: `fee-payment-${payment.id}`,
            createdBy: actorIdArg!,
            postedAt: payment.paidAt,
            lines: { create: lines },
          },
        });
      });
      summary.feePaymentJournalsCreated += 1;
      summary.created += 1;
    } catch (error) {
      if (error instanceof Error && error.message === 'BACKFILL_ALREADY_EXISTS') { summary.skippedConcurrent += 1; continue; }
      if (error instanceof Error && error.message === 'BACKFILL_PERIOD_CLOSED') { summary.skippedClosedPeriod += 1; continue; }
      if ((error as { code?: string })?.code === 'P2002') { summary.skippedConcurrent += 1; continue; }
      throw error;
    }
  }

  for (const transaction of transactions) {
    const existing = await prisma.accountingJournalEntry.findFirst({
      where: {
        schoolId: transaction.schoolId,
        OR: [
          { sourceType: 'FINANCIAL_TRANSACTION', sourceId: transaction.id },
          { idempotencyKey: `financial-transaction:${transaction.id}` },
        ],
      },
      select: { id: true },
    });
    let reversalOfLinkedSource = false;
    if (transaction.referenceNumber?.startsWith('REVERSAL:')) {
      const originalId = transaction.referenceNumber.slice('REVERSAL:'.length);
      const original = await prisma.financialTransaction.findFirst({
        where: { id: originalId, schoolId: transaction.schoolId },
        select: { invoiceId: true, paymentId: true },
      });
      reversalOfLinkedSource = !original || Boolean(original.invoiceId || original.paymentId);
    }

    const decision = classifyFinancialTransactionForBackfill({
      status: transaction.status,
      invoiceId: transaction.invoiceId,
      paymentId: transaction.paymentId,
      hasExistingJournal: Boolean(existing),
      reversalOfLinkedSource,
    });
    if (decision === 'SKIP_STATUS') { summary.skippedStatus += 1; continue; }
    if (decision === 'SKIP_SOURCE_LINK') { summary.skippedSourceLinked += 1; continue; }
    if (decision === 'SKIP_ALREADY_JOURNALIZED') { summary.skippedExisting += 1; continue; }
    summary.eligible += 1;

    let accountIds = accountsBySchool.get(transaction.schoolId);
    if (!accountIds) {
      accountIds = await schoolAccountIds(transaction.schoolId, ['1000', '1010', '1200', '2100', '4000', '4100', '5000']);
      if (!apply && assumeDefaultAccounts) {
        const missingDefaults = defaultAccounts.filter((account) => !accountIds?.has(account.code));
        if (missingDefaults.length > 0) {
          summary.defaultAccountsWouldBeSeeded += missingDefaults.length;
          schoolsWithSimulatedAccounts.add(transaction.schoolId);
          for (const account of missingDefaults) accountIds.set(account.code, `DRY-RUN-${transaction.schoolId}-${account.code}`);
        }
      }
      accountsBySchool.set(transaction.schoolId, accountIds);
    }

    const cashCode = transaction.paymentMethod === 'CASH' ? '1000' : transaction.paymentMethod === 'CARD' || transaction.paymentMethod === 'ONLINE' ? '1200' : '1010';
    const incomeCode = feeIncomeCategory(transaction.category.name) ? '4000' : '4100';
    const neededCodes = new Set([cashCode, transaction.type === 'INCOME' ? incomeCode : '5000']);
    if (transaction.type === 'EXPENSE' && transaction.paymentMethod === null) neededCodes.add('2100');
    if ([...neededCodes].some((code) => !accountIds?.has(code))) { summary.skippedMissingAccount += 1; continue; }

    const closedPeriod = await prisma.accountingPeriod.findFirst({
      where: {
        schoolId: transaction.schoolId,
        status: 'CLOSED',
        startDate: { lte: transaction.transactionDate },
        endDate: { gte: transaction.transactionDate },
      },
      select: { name: true },
    });
    if (closedPeriod) { summary.skippedClosedPeriod += 1; continue; }

    const lines = buildFinancialTransactionJournalLines({
      type: transaction.type,
      amountMinor: transaction.amount,
      paymentMethod: transaction.paymentMethod,
      accounts: {
        cashAccountId: accountIds.get('1000') ?? accountIds.get(cashCode)!,
        bankAccountId: accountIds.get('1010') ?? accountIds.get(cashCode)!,
        clearingAccountId: accountIds.get('1200') ?? accountIds.get(cashCode)!,
        incomeAccountId: accountIds.get(incomeCode) ?? accountIds.get('4100')!,
        expenseAccountId: accountIds.get('5000')!,
        accountsPayableAccountId: accountIds.get('2100') ?? accountIds.get('5000')!,
      },
      description: transaction.description,
    });
    if (!lines || !validateAccountingJournalEntry({ lines }).valid) { summary.skippedInvalidJournal += 1; continue; }
    if (!apply) continue;

    try {
      await prisma.$transaction(async (tx) => {
        const duplicate = await tx.accountingJournalEntry.findFirst({
          where: {
            schoolId: transaction.schoolId,
            OR: [
              { sourceType: 'FINANCIAL_TRANSACTION', sourceId: transaction.id },
              { idempotencyKey: `financial-transaction:${transaction.id}` },
            ],
          },
          select: { id: true },
        });
        if (duplicate) throw new Error('BACKFILL_ALREADY_EXISTS');

        const periodClosed = await tx.accountingPeriod.findFirst({
          where: {
            schoolId: transaction.schoolId,
            status: 'CLOSED',
            startDate: { lte: transaction.transactionDate },
            endDate: { gte: transaction.transactionDate },
          },
          select: { name: true },
        });
        if (periodClosed) throw new Error('BACKFILL_PERIOD_CLOSED');

        const journal = await tx.accountingJournalEntry.create({
          data: {
            schoolId: transaction.schoolId,
            reference: transaction.referenceNumber?.trim() || `BACKFILL-${transaction.id}`,
            description: `Historical ${transaction.type.toLowerCase()} backfill: ${transaction.description || transaction.category.name}`,
            entryDate: transaction.transactionDate,
            status: 'POSTED',
            sourceType: 'FINANCIAL_TRANSACTION',
            sourceId: transaction.id,
            idempotencyKey: `financial-transaction:${transaction.id}`,
            createdBy: actorIdArg!,
            postedAt: transaction.postedAt ?? transaction.createdAt,
            lines: { create: lines },
          },
        });
        await tx.financialAuditLog.create({
          data: {
            schoolId: transaction.schoolId,
            transactionId: transaction.id,
            action: 'HISTORICAL_JOURNAL_BACKFILLED',
            previousValues: null,
            newValues: JSON.stringify({ journalEntryId: journal.id, sourceType: 'FINANCIAL_TRANSACTION', sourceId: transaction.id, amountMinor: transaction.amount }),
            changedBy: actorIdArg!,
          },
        });
      });
      summary.created += 1;
    } catch (error) {
      if (error instanceof Error && error.message === 'BACKFILL_ALREADY_EXISTS') { summary.skippedConcurrent += 1; continue; }
      if (error instanceof Error && error.message === 'BACKFILL_PERIOD_CLOSED') { summary.skippedClosedPeriod += 1; continue; }
      if ((error as { code?: string })?.code === 'P2002') { summary.skippedConcurrent += 1; continue; }
      throw error;
    }
  }

  summary.schoolsWithDefaultAccountsToSeed = schoolsWithSimulatedAccounts.size;
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
