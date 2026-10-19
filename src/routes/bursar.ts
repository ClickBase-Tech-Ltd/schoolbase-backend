import { Router, Response } from 'express';
import { PaymentMethod, Prisma, PrismaClient } from '@prisma/client';
import { AuthenticatedRequest, requireBursar, verifyAuth } from '../middleware/roleAuth.js';
import { validateAccountingJournalEntry } from '../services/accounting-journal.js';
import { calculateAccountingBalances } from '../services/accounting-ledger.js';
import { buildFeePaymentJournalEntry, buildOpeningBalanceJournalLines } from '../services/accounting-posting.js';
import { buildFinancialTransactionJournalLines } from '../services/accounting-transaction-posting.js';
import { canCloseAccountingPeriod } from '../services/accounting-controls.js';
import { buildAccountingPeriodCloseState } from '../services/accounting-periods.js';
import { checksumBankStatement, parseBankStatementCsv } from '../services/bank-statement.js';
import { buildBankChargeJournalLines, canApproveStatement, canPrepareStatement, canReopenStatement, canVoidStatement, remainingReconciliationAmount, validateReconciliationAllocation } from '../services/bank-statement-workflow.js';
import { buildCashbookCsv } from '../services/cashbook-csv.js';
import { buildSchoolDateRange } from '../services/school-date-range.js';

const router = Router();
const prisma = new PrismaClient();

const DEFAULT_ACCOUNT_CATEGORIES = {
  INCOME: ['Other Income'],
  EXPENSE: ['Staff Salaries', 'Utilities', 'Maintenance', 'Stationery', 'Transport', 'Admin Expenses', 'Other Expenses'],
} as const;

function isFeeIncomeCategory(categoryName?: string | null) {
  if (!categoryName) return false;

  const normalized = categoryName.toLowerCase();
  return ['school fees', 'tuition fees', 'transport fees', 'exam fees', 'boarding fees', 'registration fees', 'books fees', 'uniform fees'].some((keyword) => normalized.includes(keyword));
}

export function parseAmountMinor(value: unknown) {
  const amount = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER / 100) {
    return null;
  }

  return Math.round(amount * 100);
}

export function parseTransactionDate(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parsePaymentMethod(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && Object.values(PaymentMethod).includes(value as PaymentMethod)
    ? value as PaymentMethod
    : undefined;
}

export function calculateSchoolFinanceSummary({
  monthlyTransactions,
  monthlyPayments,
}: {
  monthlyTransactions: Array<{
    type: 'INCOME' | 'EXPENSE';
    amount: number;
    invoiceId?: string | null;
    description?: string | null;
    category?: { name?: string | null } | null;
  }>;
  monthlyPayments: Array<{ amount: number }>; 
}) {
  const feeIncome = monthlyPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const otherIncome = monthlyTransactions
    .filter((transaction) => transaction.type === 'INCOME' && !transaction.invoiceId && !isFeeIncomeCategory(transaction.category?.name ?? null))
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);

  const expenses = monthlyTransactions
    .filter((transaction) => transaction.type === 'EXPENSE')
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);

  const monthlyIncome = feeIncome + otherIncome;

  const netMovement = monthlyIncome - expenses;

  return {
    feeIncome,
    otherIncome,
    monthlyIncome,
    monthlyExpenses: expenses,
    netMovement,
    cashPosition: netMovement,
  };
}

async function ensureDefaultAccountCategories(schoolId: string) {
  const existing = await prisma.accountCategory.findMany({
    where: { schoolId },
    select: { type: true, name: true },
  });

  for (const type of Object.keys(DEFAULT_ACCOUNT_CATEGORIES) as Array<keyof typeof DEFAULT_ACCOUNT_CATEGORIES>) {
    for (const name of DEFAULT_ACCOUNT_CATEGORIES[type]) {
      const alreadyExists = existing.some((category) => category.type === type && category.name === name);
      if (!alreadyExists) {
        await prisma.accountCategory.create({
          data: {
            schoolId,
            type,
            name,
            description: `${type === 'INCOME' ? 'Default income' : 'Default expense'} category`,
          },
        });
      }
    }
  }

  const [categories, feeItems] = await Promise.all([
    prisma.accountCategory.findMany({
      where: { schoolId, isActive: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    }),
    prisma.feeScheduleItem.findMany({
      where: { schoolId },
      select: { name: true },
      distinct: ['name'],
    }),
  ]);

  const feeNames = new Set(feeItems.map((item) => item.name.trim().toLowerCase()));
  return categories.filter((category) => {
    if (category.type !== 'INCOME') return true;
    return !feeNames.has(category.name.trim().toLowerCase()) && !isFeeIncomeCategory(category.name);
  });
}

async function resolveFeeInvoicesForAcademicContext(schoolId: string, academicYearId?: string, termId?: string) {
  if (!academicYearId && !termId) {
    return { ids: [], invoiceNos: [] };
  }

  const where: Record<string, any> = { schoolId };

  if (termId) {
    where.feeSchedule = { termId };
  }

  if (academicYearId) {
    where.feeSchedule = {
      ...where.feeSchedule,
      term: {
        academicYearId,
      },
    };
  }

  const invoices = await prisma.invoice.findMany({
    where: { ...where, status: { not: 'VOIDED' } },
    select: { id: true, invoiceNo: true },
  });

  return {
    ids: invoices.map((invoice) => invoice.id),
    invoiceNos: invoices.map((invoice) => invoice.invoiceNo).filter(Boolean),
  };
}

// Middleware: Apply to all routes
router.use(verifyAuth);
router.use(requireBursar);

/**
 * GET /api/bursar/overview
 * Dashboard overview with cash position, monthly income/expense
 */
router.get('/overview', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const today = new Date();
    const rawStartDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
    const rawEndDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;
    const rawAcademicYearId = typeof req.query.academicYearId === 'string' ? req.query.academicYearId : undefined;
    const rawTermId = typeof req.query.termId === 'string' ? req.query.termId : undefined;
    const requestedPage = Number.parseInt(String(req.query.page ?? '1'), 10);
    const requestedLimit = Number.parseInt(String(req.query.limit ?? '10'), 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 10;

    const startDate = rawStartDate ? new Date(rawStartDate) : null;
    const endDate = rawEndDate ? new Date(rawEndDate) : null;

    if ((startDate && Number.isNaN(startDate.getTime())) || (endDate && Number.isNaN(endDate.getTime()))) {
      return res.status(400).json({ error: 'Invalid date range' });
    }

    const feePaymentWhere: any = {
      invoice: {
        schoolId,
      },
    };

    if (startDate || endDate) {
      feePaymentWhere.paidAt = {};
      if (startDate) feePaymentWhere.paidAt.gte = startDate;
      if (endDate) feePaymentWhere.paidAt.lte = endDate;
    }

    const feeScheduleFilter: Record<string, any> = {};
    if (rawTermId) {
      feeScheduleFilter.termId = rawTermId;
    }
    if (rawAcademicYearId) {
      feeScheduleFilter.term = {
        academicYearId: rawAcademicYearId,
      };
    }

    if (Object.keys(feeScheduleFilter).length > 0) {
      feePaymentWhere.invoice = {
        ...feePaymentWhere.invoice,
        feeSchedule: feeScheduleFilter,
      };
    }

    const feeInvoices = await resolveFeeInvoicesForAcademicContext(schoolId, rawAcademicYearId, rawTermId);

    const financialTransactionWhere: Record<string, any> = {
      schoolId,
      status: 'POSTED',
    };

    if (startDate || endDate) {
      financialTransactionWhere.transactionDate = {};
      if (startDate) financialTransactionWhere.transactionDate.gte = startDate;
      if (endDate) financialTransactionWhere.transactionDate.lte = endDate;
    }

    if (rawAcademicYearId || rawTermId) {
      financialTransactionWhere.OR = [
        { invoiceId: { in: feeInvoices.ids.length > 0 ? feeInvoices.ids : ['__NO_MATCH__'] } },
        { invoiceId: null, referenceNumber: { in: feeInvoices.invoiceNos.length > 0 ? feeInvoices.invoiceNos : ['__NO_MATCH__'] } },
        { invoiceId: null },
      ];
    }

    const [monthlyTransactions, monthlyPayments, school] = await Promise.all([
      prisma.financialTransaction.findMany({
        where: financialTransactionWhere,
        include: {
          category: true,
        },
      }),
      prisma.payment.findMany({
        where: feePaymentWhere,
        select: {
          amount: true,
          paidAt: true,
        },
      }),
      prisma.school.findUnique({
        where: { id: schoolId },
        select: { currency: true },
      }),
    ]);

    const { feeIncome, otherIncome, monthlyIncome, monthlyExpenses, netMovement, cashPosition } = calculateSchoolFinanceSummary({
      monthlyTransactions: monthlyTransactions.map((transaction) => ({
        type: transaction.type,
        amount: transaction.amount,
        description: transaction.description,
        invoiceId: transaction.invoiceId,
        category: transaction.category,
      })),
      monthlyPayments: monthlyPayments.map((payment) => ({
        amount: payment.amount,
      })),
    });

    const recentTransactionWhere: Record<string, any> = {
      schoolId,
      status: 'POSTED',
    };

    if (startDate || endDate) {
      recentTransactionWhere.transactionDate = {};
      if (startDate) recentTransactionWhere.transactionDate.gte = startDate;
      if (endDate) recentTransactionWhere.transactionDate.lte = endDate;
    }

    if (rawAcademicYearId || rawTermId) {
      recentTransactionWhere.OR = [
        { invoiceId: { in: feeInvoices.ids.length > 0 ? feeInvoices.ids : ['__NO_MATCH__'] } },
        { invoiceId: null, referenceNumber: { in: feeInvoices.invoiceNos.length > 0 ? feeInvoices.invoiceNos : ['__NO_MATCH__'] } },
        { invoiceId: null },
      ];
    }

    const [recentTransactions, transactionTotal] = await Promise.all([
      prisma.financialTransaction.findMany({
        where: recentTransactionWhere,
        include: {
          category: true,
          createdByUser: {
            select: { name: true, email: true },
          },
        },
        orderBy: { transactionDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.financialTransaction.count({ where: recentTransactionWhere }),
    ]);

    res.json({
      cashPosition,
      netMovement,
      feeIncome,
      otherIncome,
      monthlyIncome,
      monthlyExpenses,
      currency: school?.currency || 'NGN',
      recentTransactions,
      transactionTotal,
      transactionPage: page,
      transactionLimit: limit,
      range: {
        startDate: startDate?.toISOString() ?? null,
        endDate: endDate?.toISOString() ?? today.toISOString(),
      },
    });
  } catch (error) {
    console.error('Bursar overview error:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

/**
 * GET /api/bursar/categories
 * List all account categories
 */
router.get('/categories', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const categories = await ensureDefaultAccountCategories(schoolId);
    res.json(categories);
  } catch (error) {
    console.error('Categories fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

async function ensureDefaultAccountingAccounts(schoolId: string) {
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
    { code: '5200', name: 'Bank Charges', type: 'EXPENSE', description: 'Bank fees and service charges' },
  ] as const;

  await prisma.accountingAccount.createMany({
    data: defaultAccounts.map((account) => ({
      schoolId,
      code: account.code,
      name: account.name,
      type: account.type,
      description: account.description,
    })),
    skipDuplicates: true,
  });

  return prisma.accountingAccount.findMany({
    where: { schoolId, isActive: true },
    orderBy: [{ type: 'asc' }, { code: 'asc' }],
  });
}

async function postFinancialTransactionJournal(transactionClient: Prisma.TransactionClient, {
  schoolId,
  userId,
  transactionId,
  type,
  amountMinor,
  paymentMethod,
  transactionDate,
  description,
  referenceNumber,
  incomeAccountCode = '4100',
}: {
  schoolId: string;
  userId: string;
  transactionId: string;
  type: 'INCOME' | 'EXPENSE';
  amountMinor: number;
  paymentMethod: string | null;
  transactionDate: Date;
  description?: string | null;
  referenceNumber?: string | null;
  incomeAccountCode?: '4000' | '4100';
}) {
  const closedPeriod = await transactionClient.accountingPeriod.findFirst({
    where: { schoolId, status: 'CLOSED', startDate: { lte: transactionDate }, endDate: { gte: transactionDate } },
    select: { name: true },
  });
  if (closedPeriod) throw new Error(`ACCOUNTING_PERIOD_CLOSED:${closedPeriod.name}`);

  const cashCode = paymentMethod === 'CASH' ? '1000' : paymentMethod === 'CARD' || paymentMethod === 'ONLINE' ? '1200' : '1010';
  const operatingCode = type === 'INCOME' ? incomeAccountCode : '5000';
  const requiredCodes = [...new Set([cashCode, operatingCode, '2100'])];
  const postingAccounts = await transactionClient.accountingAccount.findMany({
    where: { schoolId, isActive: true, code: { in: requiredCodes } },
    select: { id: true, code: true },
  });
  const accountIds = new Map(postingAccounts.map((account) => [account.code, account.id]));
  if (requiredCodes.some((code) => !accountIds.has(code))) throw new Error('FINANCIAL_POSTING_ACCOUNT_MISSING');

  const lines = buildFinancialTransactionJournalLines({
    type,
    amountMinor,
    paymentMethod,
    accounts: {
      cashAccountId: accountIds.get('1000') ?? accountIds.get(cashCode)!,
      bankAccountId: accountIds.get('1010') ?? accountIds.get(cashCode)!,
      clearingAccountId: accountIds.get('1200') ?? accountIds.get(cashCode)!,
      incomeAccountId: accountIds.get(incomeAccountCode) ?? accountIds.get(operatingCode)!,
      expenseAccountId: accountIds.get('5000') ?? accountIds.get(operatingCode)!,
      accountsPayableAccountId: accountIds.get('2100')!,
    },
    description,
  });
  if (!lines) throw new Error('FINANCIAL_JOURNAL_BUILD_FAILED');

  const validation = validateAccountingJournalEntry({ lines });
  if (!validation.valid) throw new Error(validation.error || 'FINANCIAL_JOURNAL_UNBALANCED');

  return transactionClient.accountingJournalEntry.create({
    data: {
      schoolId,
      reference: referenceNumber?.trim() || `TXN-${transactionId}`,
      description: description?.trim() || `${type === 'INCOME' ? 'Income' : 'Expense'} transaction ${transactionId}`,
      entryDate: transactionDate,
      status: 'POSTED',
      sourceType: 'FINANCIAL_TRANSACTION',
      sourceId: transactionId,
      idempotencyKey: `financial-transaction:${transactionId}`,
      createdBy: userId,
      postedAt: new Date(),
      lines: { create: lines },
    },
    include: { lines: true },
  });
}

router.get('/chart-of-accounts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const accounts = await ensureDefaultAccountingAccounts(schoolId);
    res.json({ accounts });
  } catch (error) {
    console.error('Chart of accounts fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch chart of accounts' });
  }
});

router.post('/chart-of-accounts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    if (!schoolId || !userId) {
      return res.status(400).json({ error: 'Missing required auth data' });
    }

    const { code, name, type, description } = req.body ?? {};
    if (!code || !name || !type) {
      return res.status(400).json({ error: 'Account code, name, and type are required' });
    }

    const normalizedCode = String(code).trim();
    const normalizedName = String(name).trim();
    const validTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
    if (!validTypes.includes(String(type))) {
      return res.status(400).json({ error: 'Account type is invalid' });
    }

    const account = await prisma.accountingAccount.upsert({
      where: { schoolId_code: { schoolId, code: normalizedCode } },
      update: {
        name: normalizedName,
        type: String(type) as any,
        description: typeof description === 'string' ? description : undefined,
        isActive: true,
      },
      create: {
        schoolId,
        code: normalizedCode,
        name: normalizedName,
        type: String(type) as any,
        description: typeof description === 'string' ? description : undefined,
      },
    });

    res.status(201).json(account);
  } catch (error) {
    console.error('Account creation error:', error);
    res.status(500).json({ error: 'Failed to create accounting account' });
  }
});
router.post('/chart-of-accounts/:accountId/opening-balance', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    if (!schoolId || !userId) return res.status(400).json({ error: 'Missing required auth data' });

    const openingBalanceMinor = typeof req.body?.openingBalanceMinor === 'number'
      ? req.body.openingBalanceMinor
      : Number(req.body?.openingBalanceMinor);
    const effectiveDate = parseTransactionDate(req.body?.effectiveDate);
    if (!Number.isSafeInteger(openingBalanceMinor) || openingBalanceMinor === 0 || !effectiveDate) {
      return res.status(400).json({ error: 'A non-zero integer opening balance in minor units and a valid effective date are required.' });
    }

    const assetAccount = await prisma.accountingAccount.findFirst({
      where: { id: req.params.accountId, schoolId, isActive: true, type: 'ASSET' },
      select: { id: true, code: true, name: true },
    });
    if (!assetAccount) return res.status(404).json({ error: 'Active asset account not found for this school.' });

    const existing = await prisma.accountingJournalEntry.findFirst({
      where: { schoolId, sourceType: 'OPENING_BALANCE', sourceId: assetAccount.id },
      include: { lines: true },
    });
    if (existing) {
      const assetLine = existing.lines.find((line) => line.accountId === assetAccount.id);
      const sameOpening = assetLine?.amount === Math.abs(openingBalanceMinor)
        && assetLine.side === (openingBalanceMinor > 0 ? 'DEBIT' : 'CREDIT')
        && existing.entryDate.getTime() === effectiveDate.getTime();
      if (!sameOpening) return res.status(409).json({ error: 'An opening balance already exists for this account. Correct it with an approved reversal and adjustment.' });
      return res.status(200).json({ journalEntry: existing, alreadyExists: true });
    }

    const closedPeriod = await prisma.accountingPeriod.findFirst({
      where: { schoolId, status: 'CLOSED', startDate: { lte: effectiveDate }, endDate: { gte: effectiveDate } },
      select: { name: true },
    });
    if (closedPeriod) return res.status(409).json({ error: `Accounting period ${closedPeriod.name} is closed.` });

    const equityAccount = await prisma.accountingAccount.findFirst({
      where: { schoolId, isActive: true, type: 'EQUITY', code: '3000' },
      select: { id: true },
    });
    if (!equityAccount) return res.status(409).json({ error: 'Active opening-balance equity account 3000 is required.' });

    const lines = buildOpeningBalanceJournalLines({
      assetAccountId: assetAccount.id,
      equityAccountId: equityAccount.id,
      openingBalanceMinor,
    });
    if (!lines) return res.status(400).json({ error: 'Opening balance could not be represented as a balanced journal entry.' });

    const idempotencyKey = `opening-balance:${assetAccount.id}`;
    const journalEntry = await prisma.$transaction(async (transaction) => {
      const periodChangedToClosed = await transaction.accountingPeriod.findFirst({
        where: { schoolId, status: 'CLOSED', startDate: { lte: effectiveDate }, endDate: { gte: effectiveDate } },
        select: { name: true },
      });
      if (periodChangedToClosed) throw new Error('ACCOUNTING_PERIOD_CLOSED');

      const created = await transaction.accountingJournalEntry.create({
        data: {
          schoolId,
          reference: `OPEN-${assetAccount.code}-${effectiveDate.toISOString().slice(0, 10)}`,
          description: `Opening balance for ${assetAccount.name}`,
          entryDate: effectiveDate,
          status: 'POSTED',
          sourceType: 'OPENING_BALANCE',
          sourceId: assetAccount.id,
          idempotencyKey,
          createdBy: userId,
          postedAt: new Date(),
          lines: { create: lines },
        },
        include: { lines: true },
      });
      return created;
    });
    return res.status(201).json({ journalEntry, alreadyExists: false });
  } catch (error) {
    if (error instanceof Error && error.message === 'ACCOUNTING_PERIOD_CLOSED') return res.status(409).json({ error: 'The effective date belongs to a closed accounting period.' });
    if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'An opening balance was recorded concurrently for this account.' });
    console.error('Opening balance posting error:', error);
    return res.status(500).json({ error: 'Failed to record the opening balance.' });
  }
});

router.get('/trial-balance', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const startDate = typeof req.query.startDate === 'string' && req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = typeof req.query.endDate === 'string' && req.query.endDate ? new Date(req.query.endDate) : null;

    if ((startDate && Number.isNaN(startDate.getTime())) || (endDate && Number.isNaN(endDate.getTime()))) {
      return res.status(400).json({ error: 'Invalid date range' });
    }

    const where: Record<string, any> = {
      schoolId,
      status: 'POSTED',
    };

    if (startDate || endDate) {
      where.entryDate = {};
      if (startDate) where.entryDate.gte = startDate;
      if (endDate) where.entryDate.lte = endDate;
    }

    const [accounts, journalEntries] = await Promise.all([
      prisma.accountingAccount.findMany({
        where: { schoolId, isActive: true },
        orderBy: [{ type: 'asc' }, { code: 'asc' }],
      }),
      prisma.accountingJournalEntry.findMany({
        where,
        include: {
          lines: true,
        },
        orderBy: { entryDate: 'asc' },
      }),
    ]);

    const balances = calculateAccountingBalances({
      accounts: accounts.map((account) => ({
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
      })),
      journalLines: journalEntries.flatMap((entry) => entry.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amount: line.amount,
      }))),
    });

    res.json({
      accounts: balances,
      totalDebit: balances.reduce((sum, row) => sum + Math.max(row.debitTotal, 0), 0),
      totalCredit: balances.reduce((sum, row) => sum + Math.max(row.creditTotal, 0), 0),
      isBalanced: balances.every((row) => row.balanceMinor === 0) || balances.reduce((sum, row) => sum + row.balanceMinor, 0) === 0,
    });
  } catch (error) {
    console.error('Trial balance fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch trial balance' });
  }
});

router.post('/bank-statement-imports', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    if (!schoolId || !userId) return res.status(400).json({ error: 'Missing required auth data' });

    const { accountingAccountId, periodStart, periodEnd, openingBalanceMinor, closingBalanceMinor, fileName, csvContent } = req.body ?? {};
    const parsedStart = typeof periodStart === 'string' ? new Date(periodStart) : null;
    const parsedEnd = typeof periodEnd === 'string' ? new Date(periodEnd) : null;
    const openingBalance = Number(openingBalanceMinor);
    const closingBalance = Number(closingBalanceMinor);
    if (!accountingAccountId || !parsedStart || Number.isNaN(parsedStart.getTime()) || !parsedEnd || Number.isNaN(parsedEnd.getTime()) || parsedStart > parsedEnd) {
      return res.status(400).json({ error: 'A valid account and statement date range are required.' });
    }
    if (!Number.isSafeInteger(openingBalance) || !Number.isSafeInteger(closingBalance)) {
      return res.status(400).json({ error: 'Opening and closing balances must be integer minor-unit amounts.' });
    }
    if (typeof csvContent !== 'string' || !csvContent.trim()) return res.status(400).json({ error: 'CSV statement content is required.' });

    const account = await prisma.accountingAccount.findFirst({
      where: { id: String(accountingAccountId), schoolId, isActive: true, type: 'ASSET' },
      select: { id: true },
    });
    if (!account) return res.status(404).json({ error: 'Active asset account not found for this school.' });

    const lines = parseBankStatementCsv(csvContent);
    if (lines.length > 5000) return res.status(400).json({ error: 'CSV statement cannot contain more than 5,000 transaction rows.' });
    const startDay = new Date(parsedStart.getFullYear(), parsedStart.getMonth(), parsedStart.getDate());
    const endDay = new Date(parsedEnd.getFullYear(), parsedEnd.getMonth(), parsedEnd.getDate(), 23, 59, 59, 999);
    if (lines.some((line) => line.transactionDate < startDay || line.transactionDate > endDay)) {
      return res.status(400).json({ error: 'Every statement row must fall within the selected statement period.' });
    }

    const statementMovement = lines.reduce((sum, line) => sum + (line.direction === 'CREDIT' ? line.amountMinor : -line.amountMinor), 0);
    if (openingBalance + statementMovement !== closingBalance) {
      return res.status(400).json({ error: 'Opening balance plus statement transactions must equal the closing balance.' });
    }

    const checksum = checksumBankStatement(csvContent);
    const existing = await prisma.bankStatementImport.findFirst({
      where: { schoolId, accountingAccountId: account.id, checksum, status: { not: 'VOIDED' } },
      select: { id: true, status: true },
    });
    if (existing) return res.status(409).json({ error: 'This statement file has already been imported.', importId: existing.id, status: existing.status });

    const statementImport = await prisma.bankStatementImport.create({
      data: {
        schoolId,
        accountingAccountId: account.id,
        periodStart: startDay,
        periodEnd: endDay,
        openingBalanceMinor: openingBalance,
        closingBalanceMinor: closingBalance,
        fileName: typeof fileName === 'string' && fileName.trim() ? fileName.trim().slice(0, 191) : 'bank-statement.csv',
        checksum,
        importedBy: userId,
        lines: {
          create: lines.map((line) => ({
            transactionDate: line.transactionDate,
            description: line.description.slice(0, 191),
            reference: line.reference?.slice(0, 191) ?? null,
            direction: line.direction,
            amountMinor: line.amountMinor,
          })),
        },
      },
      include: { _count: { select: { lines: true } }, accountingAccount: { select: { code: true, name: true } } },
    });
    return res.status(201).json(statementImport);
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      return res.status(409).json({ error: 'This statement file has already been imported.' });
    }
    if (error instanceof Error && /CSV|statement row|Opening balance/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Bank statement import error:', error);
    return res.status(500).json({ error: 'Failed to import the bank statement.' });
  }
});

router.get('/bank-statement-imports', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const imports = await prisma.bankStatementImport.findMany({
      where: { schoolId },
      include: {
        accountingAccount: { select: { code: true, name: true } },
        _count: { select: { lines: true } },
        lines: { select: { amountMinor: true, matches: { select: { amountMinor: true } } } },
      },
      orderBy: { importedAt: 'desc' },
      take: 30,
    });
    res.json({ imports: imports.map(({ lines, ...statementImport }) => ({
      ...statementImport,
      matchedCount: lines.filter((line) => remainingReconciliationAmount(line.amountMinor, line.matches.reduce((sum, match) => sum + match.amountMinor, 0)) === 0).length,
      canApprove: statementImport.status === 'PREPARED' && statementImport.preparedBy !== req.user?.userId,
      canReopen: statementImport.status === 'RECONCILED' && req.user?.role === 'SCHOOL_ADMIN',
    })) });
  } catch (error) {
    console.error('Bank statement imports fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bank statement imports.' });
  }
});

router.get('/bank-statement-imports/:importId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const statementImport = await prisma.bankStatementImport.findFirst({
      where: { id: req.params.importId, schoolId },
      include: {
        accountingAccount: { select: { id: true, code: true, name: true } },
        lines: {
          orderBy: [{ transactionDate: 'asc' }, { id: 'asc' }],
          include: {
            matches: {
              include: {
                journalLine: {
                  include: {
                    journalEntry: { select: { id: true, reference: true, description: true, entryDate: true } },
                  },
                },
              },
            },
          },
        },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!statementImport) return res.status(404).json({ error: 'Bank statement import not found.' });

    const journalLines = await prisma.accountingJournalLine.findMany({
      where: {
        accountId: statementImport.accountingAccountId,
        journalEntry: {
          schoolId,
          status: 'POSTED',
          entryDate: { gte: statementImport.periodStart, lte: statementImport.periodEnd },
        },
      },
      include: {
        journalEntry: { select: { id: true, reference: true, description: true, entryDate: true } },
        bankStatementMatches: { select: { amountMinor: true } },
      },
      orderBy: [{ journalEntry: { entryDate: 'asc' } }, { id: 'asc' }],
      take: 5000,
    });
    res.json({
      ...statementImport,
      canApprove: statementImport.status === 'PREPARED' && statementImport.preparedBy !== req.user?.userId,
      canReopen: statementImport.status === 'RECONCILED' && req.user?.role === 'SCHOOL_ADMIN',
      lines: statementImport.lines.map((line) => {
        const expectedSide = line.direction === 'CREDIT' ? 'DEBIT' : 'CREDIT';
        const matchedAmountMinor = line.matches.reduce((sum, match) => sum + match.amountMinor, 0);
        const remainingAmountMinor = remainingReconciliationAmount(line.amountMinor, matchedAmountMinor);
        const candidates = journalLines.flatMap((journalLine) => {
          const allocatedMinor = journalLine.bankStatementMatches.reduce((sum, match) => sum + match.amountMinor, 0);
          const availableMinor = remainingReconciliationAmount(journalLine.amount, allocatedMinor);
          return journalLine.side === expectedSide && availableMinor > 0
            ? [{ ...journalLine, remainingAmountMinor: availableMinor }]
            : [];
        });
        return { ...line, matchedAmountMinor, remainingAmountMinor, candidates };
      }),
      unmatchedLedgerLines: journalLines.filter((line) => remainingReconciliationAmount(line.amount, line.bankStatementMatches.reduce((sum, match) => sum + match.amountMinor, 0)) > 0).length,
      matchedStatementLines: statementImport.lines.filter((line) => remainingReconciliationAmount(line.amountMinor, line.matches.reduce((sum, match) => sum + match.amountMinor, 0)) === 0).length,
    });
  } catch (error) {
    console.error('Bank statement import detail error:', error);
    res.status(500).json({ error: 'Failed to fetch the statement matching workspace.' });
  }
});

router.post('/bank-statement-imports/:importId/match', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    const { statementLineId, journalLineId, amountMinor } = req.body ?? {};
    if (!schoolId || !userId || !statementLineId || !journalLineId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      return res.status(400).json({ error: 'Statement line, ledger line, and a positive match amount in minor units are required.' });
    }

    const result = await prisma.$transaction(async (transaction) => {
      const [statementImport, statementLine, journalLine] = await Promise.all([
        transaction.bankStatementImport.findFirst({ where: { id: req.params.importId, schoolId } }),
        transaction.bankStatementLine.findFirst({
          where: { id: String(statementLineId), importId: req.params.importId },
          include: { matches: { select: { amountMinor: true } } },
        }),
        transaction.accountingJournalLine.findFirst({
          where: { id: String(journalLineId) },
          include: { journalEntry: true, bankStatementMatches: { select: { amountMinor: true } } },
        }),
      ]);
      if (!statementImport || !statementLine) throw new Error('STATEMENT_LINE_NOT_FOUND');
      if (statementImport.status !== 'IMPORTED') throw new Error('STATEMENT_LOCKED');
      if (!journalLine || journalLine.journalEntry.schoolId !== schoolId || journalLine.journalEntry.status !== 'POSTED' || journalLine.journalEntry.entryDate < statementImport.periodStart || journalLine.journalEntry.entryDate > statementImport.periodEnd || journalLine.accountId !== statementImport.accountingAccountId) {
        throw new Error('JOURNAL_LINE_NOT_ELIGIBLE');
      }
      const expectedSide = statementLine.direction === 'CREDIT' ? 'DEBIT' : 'CREDIT';
      if (journalLine.side !== expectedSide) throw new Error('JOURNAL_LINE_DIRECTION_MISMATCH');
      const statementAllocatedMinor = statementLine.matches.reduce((sum, match) => sum + match.amountMinor, 0);
      const journalAllocatedMinor = journalLine.bankStatementMatches.reduce((sum, match) => sum + match.amountMinor, 0);
      const allocation = validateReconciliationAllocation({
        statementAmountMinor: statementLine.amountMinor,
        statementAllocatedMinor,
        journalAmountMinor: journalLine.amount,
        journalAllocatedMinor,
        allocationAmountMinor: amountMinor,
      });
      if (!allocation.allowed) throw new Error(allocation.reason);

      const match = await transaction.bankStatementMatch.create({
        data: { statementLineId: statementLine.id, journalLineId: journalLine.id, amountMinor, matchedBy: userId },
      });
      return { matchId: match.id, statementLineId: statementLine.id, journalLineId: journalLine.id, amountMinor };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json({ matched: true, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === 'STATEMENT_LINE_NOT_FOUND') return res.status(404).json({ error: 'Statement import or line not found.' });
    if (error instanceof Error && ['STATEMENT_LOCKED', 'JOURNAL_LINE_NOT_ELIGIBLE', 'JOURNAL_LINE_DIRECTION_MISMATCH'].includes(error.message)) {
      return res.status(409).json({ error: error.message === 'STATEMENT_LOCKED' ? 'Only an imported statement can be matched.' : error.message === 'JOURNAL_LINE_DIRECTION_MISMATCH' ? 'Ledger entry direction does not match this bank line.' : 'Ledger entry must be posted to the selected account within this statement period.' });
    }
    if (error instanceof Error && /remaining bank statement|remaining ledger|positive integer/.test(error.message)) return res.status(400).json({ error: error.message });
    if (['P2002', 'P2034'].includes((error as { code?: string })?.code ?? '')) return res.status(409).json({ error: 'The match changed concurrently. Refresh the statement and try again.' });
    console.error('Bank statement match error:', error);
    res.status(500).json({ error: 'Failed to match the statement line.' });
  }
});

router.post('/bank-statement-imports/:importId/lines/:statementLineId/bank-charge', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!schoolId || !userId) return res.status(400).json({ error: 'Missing required auth data' });
    if (!reason || reason.length > 1000) return res.status(400).json({ error: 'A bank charge description/reason between 1 and 1,000 characters is required.' });

    await ensureDefaultAccountingAccounts(schoolId);
    const result = await prisma.$transaction(async (transaction) => {
      const statementImport = await transaction.bankStatementImport.findFirst({
        where: { id: req.params.importId, schoolId },
        select: { id: true, accountingAccountId: true, periodStart: true, periodEnd: true, status: true },
      });
      if (!statementImport) throw new Error('STATEMENT_IMPORT_NOT_FOUND');
      if (statementImport.status !== 'IMPORTED') throw new Error('STATEMENT_LOCKED');

      const statementLine = await transaction.bankStatementLine.findFirst({
        where: { id: req.params.statementLineId, importId: statementImport.id },
        include: { matches: { select: { amountMinor: true } } },
      });
      if (!statementLine) throw new Error('STATEMENT_LINE_NOT_FOUND');
      if (statementLine.direction !== 'DEBIT') throw new Error('BANK_CHARGE_MUST_BE_DEBIT');

      const amountMinor = remainingReconciliationAmount(
        statementLine.amountMinor,
        statementLine.matches.reduce((sum, match) => sum + match.amountMinor, 0),
      );
      if (amountMinor <= 0) throw new Error('STATEMENT_LINE_FULLY_ALLOCATED');

      const period = await transaction.accountingPeriod.findFirst({
        where: { schoolId, status: 'CLOSED', startDate: { lte: statementLine.transactionDate }, endDate: { gte: statementLine.transactionDate } },
        select: { name: true },
      });
      if (period) throw new Error(`ACCOUNTING_PERIOD_CLOSED:${period.name}`);

      const [bankAccount, bankChargesAccount] = await Promise.all([
        transaction.accountingAccount.findFirst({ where: { id: statementImport.accountingAccountId, schoolId, isActive: true, type: 'ASSET' }, select: { id: true } }),
        transaction.accountingAccount.findFirst({ where: { schoolId, code: '5200', isActive: true, type: 'EXPENSE' }, select: { id: true } }),
      ]);
      if (!bankAccount || !bankChargesAccount) throw new Error('BANK_CHARGE_ACCOUNT_MISSING');

      const lines = buildBankChargeJournalLines({
        bankAccountId: bankAccount.id,
        bankChargesAccountId: bankChargesAccount.id,
        amountMinor,
        reason,
      });
      if (!lines) throw new Error('BANK_CHARGE_BUILD_FAILED');
      const validation = validateAccountingJournalEntry({ lines });
      if (!validation.valid) throw new Error(validation.error || 'BANK_CHARGE_JOURNAL_UNBALANCED');

      const journal = await transaction.accountingJournalEntry.create({
        data: {
          schoolId,
          reference: `BANK-FEE-${statementLine.id}`,
          description: `Bank charge: ${reason}`,
          entryDate: statementLine.transactionDate,
          status: 'POSTED',
          sourceType: 'BANK_CHARGE',
          sourceId: statementLine.id,
          idempotencyKey: `bank-charge:${statementLine.id}`,
          createdBy: userId,
          postedAt: new Date(),
          lines: { create: lines },
        },
        include: { lines: true },
      });
      const bankLine = journal.lines.find((line) => line.accountId === bankAccount.id && line.side === 'CREDIT');
      if (!bankLine) throw new Error('BANK_CHARGE_LEDGER_LINE_MISSING');

      const allocation = await transaction.bankStatementMatch.create({
        data: { statementLineId: statementLine.id, journalLineId: bankLine.id, amountMinor, matchedBy: userId },
      });
      await transaction.bankStatementReconciliationEvent.create({
        data: {
          schoolId,
          importId: statementImport.id,
          actorId: userId,
          action: 'BANK_CHARGE_RECORDED',
          reason,
          metadata: JSON.stringify({ statementLineId: statementLine.id, journalEntryId: journal.id, matchId: allocation.id, amountMinor, expenseAccountId: bankChargesAccount.id }),
        },
      });
      return { journalEntryId: journal.id, matchId: allocation.id, amountMinor };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return res.status(201).json({ bankChargeRecorded: true, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === 'STATEMENT_IMPORT_NOT_FOUND') return res.status(404).json({ error: 'Bank statement import not found.' });
    if (error instanceof Error && error.message === 'STATEMENT_LINE_NOT_FOUND') return res.status(404).json({ error: 'Statement line not found.' });
    if (error instanceof Error && ['STATEMENT_LOCKED', 'BANK_CHARGE_MUST_BE_DEBIT', 'STATEMENT_LINE_FULLY_ALLOCATED'].includes(error.message)) {
      return res.status(409).json({ error: error.message === 'STATEMENT_LOCKED' ? 'Only an imported statement can be adjusted.' : error.message === 'BANK_CHARGE_MUST_BE_DEBIT' ? 'Bank charges can only be recorded against a statement debit.' : 'This statement line is already fully allocated.' });
    }
    if (error instanceof Error && error.message.startsWith('ACCOUNTING_PERIOD_CLOSED:')) return res.status(409).json({ error: `Accounting period ${error.message.split(':')[1]} is closed.` });
    if (error instanceof Error && error.message === 'BANK_CHARGE_ACCOUNT_MISSING') return res.status(409).json({ error: 'The selected bank account or Bank Charges expense account is unavailable.' });
    if (['P2002', 'P2034'].includes((error as { code?: string })?.code ?? '')) return res.status(409).json({ error: 'The statement line was adjusted concurrently or already has a bank-charge journal.' });
    console.error('Bank charge adjustment error:', error);
    return res.status(500).json({ error: 'Failed to record the bank charge.' });
  }
});

router.delete('/bank-statement-imports/:importId/matches/:statementLineId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const statementImport = await prisma.bankStatementImport.findFirst({ where: { id: req.params.importId, schoolId } });
    if (!statementImport) return res.status(404).json({ error: 'Bank statement import not found.' });
    if (statementImport.status !== 'IMPORTED') return res.status(409).json({ error: 'A reconciled statement cannot be changed.' });
    const removed = await prisma.bankStatementMatch.deleteMany({ where: { statementLineId: req.params.statementLineId, statementLine: { importId: statementImport.id } } });
    res.json({ unmatched: true, removedAllocationCount: removed.count });
  } catch (error) {
    console.error('Bank statement unmatch error:', error);
    res.status(500).json({ error: 'Failed to remove the statement match.' });
  }
});

router.post('/bank-statement-imports/:importId/finalize', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    if (!schoolId || !userId) return res.status(400).json({ error: 'Missing required auth data' });
    const statementImport = await prisma.bankStatementImport.findFirst({
      where: { id: req.params.importId, schoolId },
      include: { lines: { select: { amountMinor: true, matches: { select: { amountMinor: true } } } } },
    });
    if (!statementImport) return res.status(404).json({ error: 'Bank statement import not found.' });
    if (statementImport.status === 'RECONCILED') return res.json({ prepared: true, status: statementImport.status, reconciledAt: statementImport.reconciledAt });
    if (statementImport.status === 'PREPARED') return res.json({ prepared: true, status: statementImport.status, preparedAt: statementImport.preparedAt });

    const matchedCount = statementImport.lines.filter((line) => remainingReconciliationAmount(line.amountMinor, line.matches.reduce((sum, match) => sum + match.amountMinor, 0)) === 0).length;
    const ledgerLines = await prisma.accountingJournalLine.findMany({
      where: {
        accountId: statementImport.accountingAccountId,
        journalEntry: { schoolId, status: 'POSTED', entryDate: { gte: statementImport.periodStart, lte: statementImport.periodEnd } },
      },
      select: { amount: true, bankStatementMatches: { select: { amountMinor: true } } },
    });
    const unmatchedLedgerCount = ledgerLines.filter((line) => remainingReconciliationAmount(line.amount, line.bankStatementMatches.reduce((sum, match) => sum + match.amountMinor, 0)) > 0).length;
    const preparation = canPrepareStatement({
      status: statementImport.status,
      statementLineCount: statementImport.lines.length,
      matchedStatementLineCount: matchedCount,
      unmatchedLedgerLineCount: unmatchedLedgerCount,
    });
    if (!preparation.allowed) return res.status(409).json({ error: preparation.reason, matchedCount, statementLineCount: statementImport.lines.length, unmatchedLedgerCount });

    const preparedAt = new Date();
    const prepared = await prisma.$transaction(async (transaction) => {
      const result = await transaction.bankStatementImport.updateMany({
        where: { id: statementImport.id, schoolId, status: 'IMPORTED' },
        data: { status: 'PREPARED', preparedBy: userId, preparedAt },
      });
      if (result.count !== 1) return false;
      await transaction.bankStatementReconciliationEvent.create({
        data: { schoolId, importId: statementImport.id, actorId: userId, action: 'PREPARED', metadata: JSON.stringify({ matchedCount, statementLineCount: statementImport.lines.length }) },
      });
      return true;
    });
    if (!prepared) return res.status(409).json({ error: 'Statement status changed while submitting it for review.' });
    res.json({ prepared: true, status: 'PREPARED', preparedAt: preparedAt.toISOString() });
  } catch (error) {
    console.error('Bank statement finalize error:', error);
    res.status(500).json({ error: 'Failed to submit the bank reconciliation for review.' });
  }
});

router.post('/bank-statement-imports/:importId/approve', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const reviewerId = req.user?.userId;
    if (!schoolId || !reviewerId) return res.status(400).json({ error: 'Missing required auth data' });
    const statementImport = await prisma.bankStatementImport.findFirst({
      where: { id: req.params.importId, schoolId },
      include: { lines: { select: { amountMinor: true, matches: { select: { amountMinor: true } } } } },
    });
    if (!statementImport) return res.status(404).json({ error: 'Bank statement import not found.' });
    const approval = canApproveStatement({ status: statementImport.status, preparerId: statementImport.preparedBy, reviewerId });
    if (!approval.allowed) return res.status(409).json({ error: approval.reason });

    const matchedCount = statementImport.lines.filter((line) => remainingReconciliationAmount(line.amountMinor, line.matches.reduce((sum, match) => sum + match.amountMinor, 0)) === 0).length;
    const ledgerLines = await prisma.accountingJournalLine.findMany({
      where: {
        accountId: statementImport.accountingAccountId,
        journalEntry: { schoolId, status: 'POSTED', entryDate: { gte: statementImport.periodStart, lte: statementImport.periodEnd } },
      },
      select: { amount: true, bankStatementMatches: { select: { amountMinor: true } } },
    });
    const unmatchedLedgerCount = ledgerLines.filter((line) => remainingReconciliationAmount(line.amount, line.bankStatementMatches.reduce((sum, match) => sum + match.amountMinor, 0)) > 0).length;
    if (matchedCount !== statementImport.lines.length || statementImport.lines.length === 0 || unmatchedLedgerCount > 0) {
      return res.status(409).json({ error: 'Reconciliation changed after preparation. Return it for matching again.', matchedCount, statementLineCount: statementImport.lines.length, unmatchedLedgerCount });
    }

    const reconciledAt = new Date();
    const approved = await prisma.$transaction(async (transaction) => {
      const result = await transaction.bankStatementImport.updateMany({
        where: { id: statementImport.id, schoolId, status: 'PREPARED', preparedBy: { not: reviewerId } },
        data: { status: 'RECONCILED', reconciledBy: reviewerId, reconciledAt },
      });
      if (result.count !== 1) return false;
      await transaction.bankStatementReconciliationEvent.create({
        data: { schoolId, importId: statementImport.id, actorId: reviewerId, action: 'APPROVED', metadata: JSON.stringify({ matchedCount, statementLineCount: statementImport.lines.length }) },
      });
      return true;
    });
    if (!approved) return res.status(409).json({ error: 'Statement status changed while it was being approved.' });
    res.json({ reconciled: true, status: 'RECONCILED', reconciledAt: reconciledAt.toISOString() });
  } catch (error) {
    console.error('Bank statement approval error:', error);
    res.status(500).json({ error: 'Failed to approve the bank reconciliation.' });
  }
});

router.post('/bank-statement-imports/:importId/reopen', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const actorId = req.user?.userId;
    if (!schoolId || !actorId) return res.status(400).json({ error: 'Missing required auth data' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const statementImport = await prisma.bankStatementImport.findFirst({ where: { id: req.params.importId, schoolId } });
    if (!statementImport) return res.status(404).json({ error: 'Bank statement import not found.' });
    const decision = canReopenStatement({ status: statementImport.status, role: req.user?.role ?? '', reason });
    if (!decision.allowed) return res.status(403).json({ error: decision.reason });

    const reopenedAt = new Date();
    const reopened = await prisma.$transaction(async (transaction) => {
      const matches = await transaction.bankStatementMatch.findMany({
        where: { statementLine: { importId: statementImport.id } },
        select: { id: true, statementLineId: true, journalLineId: true, amountMinor: true, matchedBy: true, matchedAt: true },
      });
      const result = await transaction.bankStatementImport.updateMany({
        where: { id: statementImport.id, schoolId, status: 'RECONCILED' },
        data: { status: 'IMPORTED', preparedBy: null, preparedAt: null, reconciledBy: null, reconciledAt: null },
      });
      if (result.count !== 1) return false;
      await transaction.bankStatementMatch.deleteMany({ where: { statementLine: { importId: statementImport.id } } });
      const periodName = `${statementImport.periodStart.getFullYear()}-${String(statementImport.periodStart.getMonth() + 1).padStart(2, '0')}`;
      const reopenedPeriod = await transaction.accountingPeriod.updateMany({
        where: { schoolId, name: periodName, status: 'CLOSED' },
        data: { status: 'OPEN', isBankReconciled: false, closedAt: null, closedBy: null },
      });
      await transaction.bankStatementReconciliationEvent.create({
        data: { schoolId, importId: statementImport.id, actorId, action: 'REOPENED', reason, metadata: JSON.stringify({ previousReviewerId: statementImport.reconciledBy, previousReconciledAt: statementImport.reconciledAt, matches, reopenedAccountingPeriod: reopenedPeriod.count === 1 ? periodName : null }) },
      });
      return true;
    });
    if (!reopened) return res.status(409).json({ error: 'Statement status changed while it was being reopened.' });
    res.json({ reopened: true, status: 'IMPORTED', reopenedAt: reopenedAt.toISOString() });
  } catch (error) {
    console.error('Bank statement reopen error:', error);
    res.status(500).json({ error: 'Failed to reopen the bank reconciliation.' });
  }
});

router.post('/bank-statement-imports/:importId/void', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const actorId = req.user?.userId;
    if (!schoolId || !actorId) return res.status(400).json({ error: 'Missing required auth data' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const statementImport = await prisma.bankStatementImport.findFirst({ where: { id: req.params.importId, schoolId } });
    if (!statementImport) return res.status(404).json({ error: 'Bank statement import not found.' });
    const decision = canVoidStatement({ status: statementImport.status, reason });
    if (!decision.allowed) return res.status(409).json({ error: decision.reason });

    const voided = await prisma.$transaction(async (transaction) => {
      const matches = await transaction.bankStatementMatch.findMany({
        where: { statementLine: { importId: statementImport.id } },
        select: { id: true, statementLineId: true, journalLineId: true, amountMinor: true, matchedBy: true, matchedAt: true },
      });
      const result = await transaction.bankStatementImport.updateMany({
        where: { id: statementImport.id, schoolId, status: statementImport.status },
        data: { status: 'VOIDED' },
      });
      if (result.count !== 1) return false;
      await transaction.bankStatementMatch.deleteMany({ where: { statementLine: { importId: statementImport.id } } });
      await transaction.bankStatementReconciliationEvent.create({
        data: { schoolId, importId: statementImport.id, actorId, action: 'VOIDED', reason, metadata: JSON.stringify({ previousStatus: statementImport.status, matches }) },
      });
      return true;
    });
    if (!voided) return res.status(409).json({ error: 'Statement status changed while voiding the import.' });
    res.json({ voided: true, status: 'VOIDED' });
  } catch (error) {
    console.error('Bank statement void error:', error);
    res.status(500).json({ error: 'Failed to void the statement import.' });
  }
});

router.get('/reconciliation', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const imports = await prisma.bankStatementImport.findMany({
      where: { schoolId },
      select: {
        id: true,
        fileName: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        closingBalanceMinor: true,
        accountingAccount: { select: { code: true, name: true } },
        reconciledAt: true,
      },
      orderBy: { importedAt: 'desc' },
      take: 30,
    });
    res.json({
      status: imports.some((statementImport) => statementImport.status === 'RECONCILED') ? 'MATCHED' : 'DISCREPANT',
      isReconciled: imports.some((statementImport) => statementImport.status === 'RECONCILED'),
      imports,
    });
  } catch (error) {
    console.error('Reconciliation check error:', error);
    res.status(500).json({ error: 'Failed to reconcile the account balance' });
  }
});

router.post('/period-close', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { startDate, endDate } = req.body ?? {};
    const parsedStart = typeof startDate === 'string' ? new Date(startDate) : null;
    const parsedEnd = typeof endDate === 'string' ? new Date(endDate) : null;

    if ((parsedStart && Number.isNaN(parsedStart.getTime())) || (parsedEnd && Number.isNaN(parsedEnd.getTime()))) {
      return res.status(400).json({ error: 'Invalid period dates' });
    }
    if (!parsedStart || !parsedEnd) {
      return res.status(400).json({ error: 'Period start and end dates are required' });
    }
    if (parsedStart > parsedEnd) return res.status(400).json({ error: 'Period start must be on or before its end.' });

    const [postedEntries, draftEntryCount, reconciledStatements] = await Promise.all([
      prisma.accountingJournalEntry.findMany({
        where: { schoolId, status: 'POSTED', entryDate: { gte: parsedStart, lte: parsedEnd } },
        select: { lines: { select: { accountId: true, side: true, amount: true } } },
      }),
      prisma.accountingJournalEntry.count({
        where: { schoolId, status: 'DRAFT', entryDate: { gte: parsedStart, lte: parsedEnd } },
      }),
      prisma.bankStatementImport.findMany({
        where: {
          schoolId,
          status: 'RECONCILED',
          periodStart: { lte: parsedStart },
          periodEnd: { gte: parsedEnd },
        },
        orderBy: { reconciledAt: 'desc' },
        select: { accountingAccountId: true, openingBalanceMinor: true, closingBalanceMinor: true },
      }),
    ]);
    const totalDebitMinor = postedEntries.reduce((sum, entry) => sum + entry.lines.reduce((lineSum, line) => lineSum + (line.side === 'DEBIT' ? line.amount : 0), 0), 0);
    const totalCreditMinor = postedEntries.reduce((sum, entry) => sum + entry.lines.reduce((lineSum, line) => lineSum + (line.side === 'CREDIT' ? line.amount : 0), 0), 0);
    const hasOpenEntries = draftEntryCount > 0;
    const statementsByAccount = new Map(reconciledStatements.map((statement) => [statement.accountingAccountId, statement]));
    const isBankReconciled = statementsByAccount.size > 0;
    const bankStatementMinor = [...statementsByAccount.values()].reduce((sum, statement) => sum + statement.closingBalanceMinor, 0);
    const ledgerBalanceMinor = [...statementsByAccount.entries()].reduce((total, [accountId, statement]) => {
      const periodMovement = postedEntries.reduce((entryTotal, entry) => entryTotal + entry.lines.reduce((lineTotal, line) => {
        if (line.accountId !== accountId) return lineTotal;
        return lineTotal + (line.side === 'DEBIT' ? line.amount : -line.amount);
      }, 0), 0);
      return total + statement.openingBalanceMinor + periodMovement;
    }, 0);

    const closeState = buildAccountingPeriodCloseState({
      startDate: parsedStart,
      endDate: parsedEnd,
      totalDebitMinor,
      totalCreditMinor,
      ledgerBalanceMinor,
      bankStatementMinor,
      hasOpenEntries,
      isBankReconciled,
    });

    const persisted = await prisma.accountingPeriod.upsert({
      where: {
        schoolId_name: {
          schoolId,
          name: closeState.name,
        },
      },
      update: {
        status: closeState.allowed ? 'CLOSED' : 'OPEN',
        ledgerBalanceMinor: closeState.ledgerBalanceMinor,
        bankStatementMinor: closeState.bankStatementMinor,
        differenceMinor: closeState.differenceMinor,
        totalDebitMinor: closeState.totalDebitMinor,
        totalCreditMinor: closeState.totalCreditMinor,
        hasOpenEntries,
        isBankReconciled,
        closedAt: closeState.allowed ? new Date() : null,
        closedBy: closeState.allowed ? userId ?? null : null,
        startDate: parsedStart,
        endDate: parsedEnd,
      },
      create: {
        schoolId,
        name: closeState.name,
        startDate: parsedStart,
        endDate: parsedEnd,
        status: closeState.allowed ? 'CLOSED' : 'OPEN',
        ledgerBalanceMinor: closeState.ledgerBalanceMinor,
        bankStatementMinor: closeState.bankStatementMinor,
        differenceMinor: closeState.differenceMinor,
        totalDebitMinor: closeState.totalDebitMinor,
        totalCreditMinor: closeState.totalCreditMinor,
        hasOpenEntries,
        isBankReconciled,
        closedAt: closeState.allowed ? new Date() : null,
        closedBy: closeState.allowed ? userId ?? null : null,
      },
    });

    if (!closeState.allowed) {
      return res.status(409).json({
        allowed: false,
        reason: closeState.reason,
        status: persisted.status,
        period: {
          name: persisted.name,
          startDate: persisted.startDate.toISOString(),
          endDate: persisted.endDate.toISOString(),
        },
      });
    }

    res.status(200).json({
      allowed: true,
      reason: closeState.reason,
      status: persisted.status,
      closedAt: persisted.closedAt?.toISOString() ?? closeState.closedAt,
      period: {
        name: persisted.name,
        startDate: persisted.startDate.toISOString(),
        endDate: persisted.endDate.toISOString(),
      },
    });
  } catch (error) {
    console.error('Period close error:', error);
    res.status(500).json({ error: 'Failed to close the accounting period' });
  }
});

router.post('/journal-entries', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    if (!schoolId || !userId) {
      return res.status(400).json({ error: 'Missing required auth data' });
    }

    const { reference, description, entryDate, sourceType, sourceId, idempotencyKey, lines } = req.body ?? {};
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'Journal entry requires at least one line' });
    }

    const parsedDate = parseTransactionDate(entryDate);
    if (!parsedDate) {
      return res.status(400).json({ error: 'A valid entry date is required' });
    }

    const closedPeriod = await prisma.accountingPeriod.findFirst({
      where: { schoolId, status: 'CLOSED', startDate: { lte: parsedDate }, endDate: { gte: parsedDate } },
      select: { name: true },
    });
    if (closedPeriod) return res.status(409).json({ error: `Accounting period ${closedPeriod.name} is closed.` });

    const normalizedIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
    if (idempotencyKey !== undefined && idempotencyKey !== null && !normalizedIdempotencyKey) {
      return res.status(400).json({ error: 'Idempotency key is invalid' });
    }

    const normalizedLines = lines.map((line: any) => ({
      accountId: typeof line?.accountId === 'string' ? line.accountId : '',
      side: typeof line?.side === 'string' ? line.side : '',
      amount: typeof line?.amount === 'number' || typeof line?.amount === 'string' ? Number(line.amount) : NaN,
      description: typeof line?.description === 'string' ? line.description : undefined,
    }));

    const validationErrors = validateAccountingJournalEntry({
      lines: normalizedLines.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amount: line.amount,
        description: line.description,
      })),
    });
    if (!validationErrors.valid) {
      return res.status(400).json({ error: validationErrors.error });
    }

    const accounts = await prisma.accountingAccount.findMany({
      where: { schoolId, isActive: true, id: { in: normalizedLines.map((line) => line.accountId) } },
      select: { id: true },
    });

    const validAccountIds = new Set(accounts.map((account) => account.id));
    const invalidAccount = normalizedLines.find((line) => !validAccountIds.has(line.accountId));
    if (invalidAccount) {
      return res.status(400).json({ error: 'One or more journal lines reference an invalid accounting account' });
    }

    const result = await prisma.$transaction(async (tx) => {
      if (normalizedIdempotencyKey) {
        const existing = await tx.accountingJournalEntry.findFirst({
          where: { schoolId, idempotencyKey: normalizedIdempotencyKey },
        });
        if (existing) {
          throw new Error('JOURNAL_IDEMPOTENCY_CONFLICT');
        }
      }

      const journalEntry = await tx.accountingJournalEntry.create({
        data: {
          schoolId,
          reference: typeof reference === 'string' && reference.trim() ? reference.trim() : `JNL-${Date.now()}`,
          description: typeof description === 'string' ? description.trim() || null : null,
          entryDate: parsedDate,
          status: 'POSTED',
          sourceType: typeof sourceType === 'string' ? sourceType : null,
          sourceId: typeof sourceId === 'string' ? sourceId : null,
          idempotencyKey: normalizedIdempotencyKey,
          createdBy: userId,
          postedAt: new Date(),
        },
      });

      const linesToCreate = normalizedLines.map((line) => ({
        journalEntryId: journalEntry.id,
        accountId: line.accountId,
        side: line.side as 'DEBIT' | 'CREDIT',
        amount: Math.round(Number(line.amount)),
        description: line.description,
      }));

      await tx.accountingJournalLine.createMany({
        data: linesToCreate,
      });

      return { journalEntry, lines: linesToCreate };
    });

    res.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'JOURNAL_IDEMPOTENCY_CONFLICT') {
      return res.status(409).json({ error: 'A journal entry with this idempotency key already exists' });
    }
    console.error('Journal entry creation error:', error);
    res.status(500).json({ error: 'Failed to create journal entry' });
  }
});

/**
 * POST /api/bursar/categories
 * Create a custom account category
 */
router.post('/categories', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { name, type, description } = req.body ?? {};

    if (!name || !type || !['INCOME', 'EXPENSE'].includes(type)) {
      return res.status(400).json({ error: 'Name and type (INCOME or EXPENSE) are required' });
    }

    const normalizedName = String(name).trim();
    if (!normalizedName) {
      return res.status(400).json({ error: 'Category name cannot be empty' });
    }

    const category = await prisma.accountCategory.upsert({
      where: {
        schoolId_type_name: {
          schoolId,
          type,
          name: normalizedName,
        },
      },
      update: {
        description: description ?? undefined,
        isActive: true,
      },
      create: {
        schoolId,
        type,
        name: normalizedName,
        description,
      },
    });

    res.status(201).json(category);
  } catch (error) {
    console.error('Category creation error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

/**
 * POST /api/bursar/income
 * Record income entry
 */
router.post('/income', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;

    if (!schoolId || !userId) {
      return res.status(400).json({ error: 'Missing required auth data' });
    }

    const {
      categoryId,
      amount,
      description,
      referenceNumber,
      transactionDate,
      paymentMethod,
    } = req.body;

    const amountMinor = parseAmountMinor(amount);
    const parsedDate = parseTransactionDate(transactionDate);
    const normalizedPaymentMethod = parsePaymentMethod(paymentMethod);

    if (!categoryId || amountMinor === null || !parsedDate || normalizedPaymentMethod === undefined) {
      return res.status(400).json({
        error: 'Category, a positive amount, a valid date, and a valid payment method are required',
      });
    }

    // Verify category belongs to school and is for income
    const category = await prisma.accountCategory.findFirst({
      where: {
        id: categoryId,
        schoolId,
        type: 'INCOME',
        isActive: true,
      },
    });

    if (!category) {
      return res.status(404).json({ error: 'Income category not found' });
    }

    const [school] = await Promise.all([
      prisma.school.findUnique({ where: { id: schoolId }, select: { currency: true } }),
      ensureDefaultAccountingAccounts(schoolId),
    ]);

    // Income is posted immediately because it represents money already received.
    const transaction = await prisma.$transaction(async (transactionClient) => {
      const created = await transactionClient.financialTransaction.create({
        data: {
          schoolId,
          categoryId,
          type: 'INCOME',
          amount: amountMinor,
          currency: school?.currency || 'NGN',
          paymentMethod: normalizedPaymentMethod,
          description,
          referenceNumber,
          transactionDate: parsedDate,
          status: 'POSTED',
          createdBy: userId,
          postedAt: new Date(),
          postedBy: userId,
        },
        include: { category: true },
      });
      await postFinancialTransactionJournal(transactionClient, {
        schoolId,
        userId,
        transactionId: created.id,
        type: created.type,
        amountMinor: created.amount,
        paymentMethod: created.paymentMethod,
        transactionDate: created.transactionDate,
        description: created.description,
        referenceNumber: created.referenceNumber,
        incomeAccountCode: isFeeIncomeCategory(category.name) ? '4000' : '4100',
      });
      await transactionClient.financialAuditLog.create({
        data: {
          schoolId,
          transactionId: created.id,
          action: 'TRANSACTION_CREATED_AND_POSTED',
          previousValues: null,
          newValues: JSON.stringify({ type: created.type, amount: created.amount, status: created.status }),
          changedBy: userId,
        },
      });
      return created;
    });

    res.status(201).json(transaction);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ACCOUNTING_PERIOD_CLOSED:')) {
      return res.status(409).json({ error: `Accounting period ${error.message.split(':')[1]} is closed.` });
    }
    if (error instanceof Error && error.message === 'FINANCIAL_POSTING_ACCOUNT_MISSING') {
      return res.status(409).json({ error: 'Required accounting posting accounts are not configured.' });
    }
    console.error('Income creation error:', error);
    res.status(500).json({ error: 'Failed to create income entry' });
  }
});

/**
 * POST /api/bursar/expenses
 * Record expense entry
 */
router.post('/expenses', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;

    if (!schoolId || !userId) {
      return res.status(400).json({ error: 'Missing required auth data' });
    }

    const {
      categoryId,
      amount,
      description,
      referenceNumber,
      transactionDate,
      paymentMethod,
    } = req.body;

    const amountMinor = parseAmountMinor(amount);
    const parsedDate = parseTransactionDate(transactionDate);
    const normalizedPaymentMethod = parsePaymentMethod(paymentMethod);

    if (!categoryId || amountMinor === null || !parsedDate || normalizedPaymentMethod === undefined) {
      return res.status(400).json({
        error: 'Category, a positive amount, a valid date, and a valid payment method are required',
      });
    }

    // Verify category belongs to school and is for expenses
    const category = await prisma.accountCategory.findFirst({
      where: {
        id: categoryId,
        schoolId,
        type: 'EXPENSE',
        isActive: true,
      },
    });

    if (!category) {
      return res.status(404).json({ error: 'Expense category not found' });
    }

    const [school] = await Promise.all([
      prisma.school.findUnique({ where: { id: schoolId }, select: { currency: true } }),
      ensureDefaultAccountingAccounts(schoolId),
    ]);

    // Expenses require review before they affect posted cashbook totals.
    const transaction = await prisma.financialTransaction.create({
      data: {
        schoolId,
        categoryId,
        type: 'EXPENSE',
        amount: amountMinor,
        currency: school?.currency || 'NGN',
        paymentMethod: normalizedPaymentMethod,
        description,
        referenceNumber,
        transactionDate: parsedDate,
        status: 'DRAFT',
        createdBy: userId,
      },
      include: {
        category: true,
      },
    });

    res.status(201).json(transaction);
  } catch (error) {
    console.error('Expense creation error:', error);
    res.status(500).json({ error: 'Failed to create expense entry' });
  }
});

/**
 * PATCH /api/bursar/transactions/:id/post
 * Post (approve) a transaction
 */
router.patch('/transactions/:id/post', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!schoolId || !userId) {
      return res.status(400).json({ error: 'Missing required auth data' });
    }

    // Verify transaction belongs to school and is in DRAFT status
    const transaction = await prisma.financialTransaction.findFirst({
      where: {
        id,
        schoolId,
        status: 'DRAFT',
      },
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found or not in DRAFT status' });
    }

    if (transaction.createdBy === userId && req.user?.role !== 'SCHOOL_ADMIN') {
      return res.status(403).json({ error: 'A second staff member or school admin must approve this expense' });
    }

    await ensureDefaultAccountingAccounts(schoolId);
    const updated = await prisma.$transaction(async (transactionClient) => {
      const postedAt = new Date();
      const changed = await transactionClient.financialTransaction.updateMany({
        where: { id, schoolId, status: 'DRAFT' },
        data: { status: 'POSTED', postedAt, postedBy: userId },
      });
      if (changed.count !== 1) throw new Error('TRANSACTION_STATE_CHANGED');

      const posted = await transactionClient.financialTransaction.findFirst({
        where: { id, schoolId, status: 'POSTED' },
        include: { category: true },
      });
      if (!posted) throw new Error('TRANSACTION_STATE_CHANGED');

      await postFinancialTransactionJournal(transactionClient, {
        schoolId,
        userId,
        transactionId: posted.id,
        type: posted.type,
        amountMinor: posted.amount,
        paymentMethod: posted.paymentMethod,
        transactionDate: posted.transactionDate,
        description: posted.description,
        referenceNumber: posted.referenceNumber,
        incomeAccountCode: isFeeIncomeCategory(posted.category.name) ? '4000' : '4100',
      });

      await transactionClient.financialAuditLog.create({
        data: {
          schoolId,
          transactionId: id,
          action: 'TRANSACTION_POSTED',
          previousValues: JSON.stringify({ status: 'DRAFT' }),
          newValues: JSON.stringify({ status: 'POSTED', postedBy: userId }),
          changedBy: userId,
        },
      });

      return posted;
    });

    res.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ACCOUNTING_PERIOD_CLOSED:')) {
      return res.status(409).json({ error: `Accounting period ${error.message.split(':')[1]} is closed.` });
    }
    if (error instanceof Error && error.message === 'FINANCIAL_POSTING_ACCOUNT_MISSING') {
      return res.status(409).json({ error: 'Required accounting posting accounts are not configured.' });
    }
    if (error instanceof Error && error.message === 'TRANSACTION_STATE_CHANGED') {
      return res.status(409).json({ error: 'Transaction was already changed or approved.' });
    }
    console.error('Transaction post error:', error);
    res.status(500).json({ error: 'Failed to post transaction' });
  }
});

/**
 * POST /api/bursar/transactions/:id/reverse
 * Reverse a posted transaction without deleting or editing the original.
 */
router.post('/transactions/:id/reverse', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const userId = req.user?.userId;
    const { id } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!schoolId || !userId) {
      return res.status(400).json({ error: 'Missing required auth data' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'A reversal reason is required' });
    }

    await ensureDefaultAccountingAccounts(schoolId);
    const result = await prisma.$transaction(async (transaction) => {
      const original = await transaction.financialTransaction.findFirst({
        where: { id, schoolId, status: 'POSTED' },
        include: { category: true },
      });

      if (!original) {
        throw new Error('TRANSACTION_NOT_FOUND');
      }

      const originalJournal = await transaction.accountingJournalEntry.findFirst({
        where: { schoolId, sourceType: 'FINANCIAL_TRANSACTION', sourceId: original.id, status: 'POSTED' },
        select: { id: true },
      });

      const claimed = await transaction.financialTransaction.updateMany({
        where: { id: original.id, schoolId, status: 'POSTED' },
        data: {
          status: 'REVERSED',
          reversalDate: new Date(),
          reversalReason: reason,
          reversedBy: userId,
        },
      });
      if (claimed.count !== 1) throw new Error('TRANSACTION_STATE_CHANGED');

      const reversal = await transaction.financialTransaction.create({
        data: {
          schoolId,
          categoryId: original.categoryId,
          type: original.type,
          amount: -original.amount,
          currency: original.currency,
          paymentMethod: original.paymentMethod,
          description: `Reversal: ${original.description || original.category.name}`,
          referenceNumber: `REVERSAL:${original.id}`,
          transactionDate: new Date(),
          status: 'POSTED',
          createdBy: userId,
          postedAt: new Date(),
          postedBy: userId,
        },
        include: { category: true },
      });

      const updatedOriginal = await transaction.financialTransaction.findUniqueOrThrow({
        where: { id: original.id },
        include: { category: true },
      });

      let reversalJournalId: string | null = null;
      if (originalJournal) {
        const reversalJournal = await postFinancialTransactionJournal(transaction, {
          schoolId,
          userId,
          transactionId: reversal.id,
          type: reversal.type,
          amountMinor: reversal.amount,
          paymentMethod: reversal.paymentMethod,
          transactionDate: reversal.transactionDate,
          description: reversal.description,
          referenceNumber: reversal.referenceNumber,
          incomeAccountCode: isFeeIncomeCategory(original.category.name) ? '4000' : '4100',
        });
        reversalJournalId = reversalJournal.id;
      }

      await transaction.financialAuditLog.create({
        data: {
          schoolId,
          transactionId: original.id,
          action: 'TRANSACTION_REVERSED',
          previousValues: JSON.stringify({ status: original.status, amount: original.amount }),
          newValues: JSON.stringify({ status: updatedOriginal.status, reversalId: reversal.id, reversalJournalId, reason }),
          changedBy: userId,
        },
      });

      return { original: updatedOriginal, reversal };
    });

    res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'TRANSACTION_NOT_FOUND') {
      return res.status(404).json({ error: 'Posted transaction not found or already reversed' });
    }
    if (error instanceof Error && error.message === 'TRANSACTION_STATE_CHANGED') {
      return res.status(409).json({ error: 'Transaction was reversed by another request.' });
    }
    if (error instanceof Error && error.message.startsWith('ACCOUNTING_PERIOD_CLOSED:')) {
      return res.status(409).json({ error: `Accounting period ${error.message.split(':')[1]} is closed.` });
    }
    console.error('Transaction reversal error:', error);
    res.status(500).json({ error: 'Failed to reverse transaction' });
  }
});

/**
 * GET /api/bursar/cashbook
 * Get chronological transaction ledger
 */
function cashbookQueryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseCashbookAmountMinor(value: string): number | null {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Math.round(Number(value) * 100);
  return Number.isSafeInteger(amount) ? amount : null;
}

function buildCashbookWhere({ schoolId, timeZone, query }: { schoolId: string; timeZone: string; query: Record<string, unknown> }) {
  const type = cashbookQueryString(query.type) || 'ALL';
  const status = cashbookQueryString(query.status) || 'POSTED';
  const startDate = cashbookQueryString(query.startDate);
  const endDate = cashbookQueryString(query.endDate);
  const search = cashbookQueryString(query.search);
  const categoryId = cashbookQueryString(query.categoryId);
  const creatorId = cashbookQueryString(query.creatorId);
  const approverId = cashbookQueryString(query.approverId);
  const minAmount = cashbookQueryString(query.minAmount);
  const maxAmount = cashbookQueryString(query.maxAmount);

  if (!['ALL', 'INCOME', 'EXPENSE'].includes(type)) return { error: 'Invalid transaction type filter.' } as const;
  if (!['ALL', 'DRAFT', 'POSTED', 'REVERSED', 'VOIDED'].includes(status)) return { error: 'Invalid transaction status filter.' } as const;
  if (search.length > 100) return { error: 'Search text cannot exceed 100 characters.' } as const;

  const dateRange = buildSchoolDateRange({ startDate: startDate || undefined, endDate: endDate || undefined, timeZone });
  if (!dateRange) return { error: 'Invalid date range.' } as const;
  const minAmountMinor = minAmount ? parseCashbookAmountMinor(minAmount) : null;
  const maxAmountMinor = maxAmount ? parseCashbookAmountMinor(maxAmount) : null;
  if ((minAmount && minAmountMinor === null) || (maxAmount && maxAmountMinor === null)) return { error: 'Amount filters must be valid decimal currency amounts.' } as const;
  if (minAmountMinor !== null && maxAmountMinor !== null && minAmountMinor > maxAmountMinor) return { error: 'Minimum amount must not exceed maximum amount.' } as const;

  const where: Prisma.FinancialTransactionWhereInput = { schoolId };
  if (status !== 'ALL') where.status = status as 'DRAFT' | 'POSTED' | 'REVERSED' | 'VOIDED';
  if (type !== 'ALL') where.type = type as 'INCOME' | 'EXPENSE';
  if (categoryId) where.categoryId = categoryId;
  if (creatorId) where.createdBy = creatorId;
  if (approverId) where.postedBy = approverId;
  if (dateRange.start || dateRange.endExclusive) {
    where.transactionDate = {};
    if (dateRange.start) where.transactionDate.gte = dateRange.start;
    if (dateRange.endExclusive) where.transactionDate.lt = dateRange.endExclusive;
  }
  if (minAmountMinor !== null || maxAmountMinor !== null) {
    where.amount = {};
    if (minAmountMinor !== null) where.amount.gte = minAmountMinor;
    if (maxAmountMinor !== null) where.amount.lte = maxAmountMinor;
  }
  if (search) {
    where.OR = [
      { id: { contains: search } },
      { description: { contains: search } },
      { referenceNumber: { contains: search } },
      { category: { name: { contains: search } } },
      { createdByUser: { name: { contains: search } } },
      { createdByUser: { email: { contains: search } } },
      { postedByUser: { is: { name: { contains: search } } } },
      { postedByUser: { is: { email: { contains: search } } } },
    ];
  }

  return {
    where,
    filters: { type, status, startDate: startDate || null, endDate: endDate || null, search: search || null, categoryId: categoryId || null, creatorId: creatorId || null, approverId: approverId || null, minAmountMinor, maxAmountMinor },
  } as const;
}

function parseCashbookPagination(query: Record<string, unknown>) {
  const skipValue = cashbookQueryString(query.skip) || '0';
  const takeValue = cashbookQueryString(query.take) || '50';
  if (!/^\d+$/.test(skipValue) || !/^\d+$/.test(takeValue)) return null;
  const skip = Number(skipValue);
  const take = Number(takeValue);
  if (!Number.isSafeInteger(skip) || skip < 0 || skip > 1_000_000 || !Number.isSafeInteger(take) || take < 1 || take > 100) return null;
  return { skip, take };
}

router.get('/cashbook/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    const actorId = req.user?.userId;
    if (!schoolId || !actorId) return res.status(400).json({ error: 'Missing required auth data' });
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
    const filterResult = buildCashbookWhere({ schoolId, timeZone: school?.timezone || 'Africa/Lagos', query: req.query as Record<string, unknown> });
    if ('error' in filterResult) return res.status(400).json({ error: filterResult.error });

    const total = await prisma.financialTransaction.count({ where: filterResult.where });
    if (total > 5000) return res.status(413).json({ error: 'CSV export is limited to 5,000 rows. Narrow the filters and try again.', total, limit: 5000 });
    const transactions = await prisma.financialTransaction.findMany({
      where: filterResult.where,
      include: {
        category: { select: { name: true } },
        createdByUser: { select: { name: true } },
        postedByUser: { select: { name: true } },
      },
      orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
      take: 5000,
    });
    await prisma.cashbookExportAudit.create({
      data: { schoolId, actorId, filters: JSON.stringify(filterResult.filters), rowCount: transactions.length },
    });
    const csv = buildCashbookCsv(transactions.map((transaction) => ({
      id: transaction.id,
      transactionDate: transaction.transactionDate,
      type: transaction.type,
      amount: transaction.amount,
      currency: transaction.currency,
      status: transaction.status,
      categoryName: transaction.category.name,
      description: transaction.description,
      referenceNumber: transaction.referenceNumber,
      createdByName: transaction.createdByUser.name,
      postedByName: transaction.postedByUser?.name,
    })));
    res.status(200).type('text/csv').set('Content-Disposition', `attachment; filename="cashbook-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  } catch (error) {
    console.error('Cashbook export error:', error);
    res.status(500).json({ error: 'Failed to export cashbook' });
  }
});

router.get('/cashbook', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) return res.status(400).json({ error: 'School ID required' });
    const pagination = parseCashbookPagination(req.query as Record<string, unknown>);
    if (!pagination) return res.status(400).json({ error: 'Pagination requires skip from 0 to 1,000,000 and take from 1 to 100.' });

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
    const filterResult = buildCashbookWhere({ schoolId, timeZone: school?.timezone || 'Africa/Lagos', query: req.query as Record<string, unknown> });
    if ('error' in filterResult) return res.status(400).json({ error: filterResult.error });
    const [transactions, total, categories, users] = await Promise.all([
      prisma.financialTransaction.findMany({
        where: filterResult.where,
        include: {
          category: { select: { id: true, name: true } },
          createdByUser: { select: { id: true, name: true, email: true } },
          postedByUser: { select: { id: true, name: true, email: true } },
        },
        orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.financialTransaction.count({ where: filterResult.where }),
      prisma.accountCategory.findMany({ where: { schoolId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.user.findMany({ where: { schoolId, role: { in: ['BURSAR', 'SCHOOL_ADMIN'] } }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } }),
    ]);

    res.json({
      transactions,
      total,
      skip: pagination.skip,
      take: pagination.take,
      filters: filterResult.filters,
      filterOptions: { categories, users },
    });
  } catch (error) {
    console.error('Cashbook fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch cashbook' });
  }
});

/**
 * GET /api/bursar/reports/income-expense
 * Income vs Expense report
 */
router.get('/reports/income-expense', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: 'School ID required' });
    }

    const { startDate, endDate } = req.query;

    const where: any = {
      schoolId,
      status: 'POSTED',
    };

    if (startDate && endDate) {
      where.transactionDate = {
        gte: new Date(startDate as string),
        lte: new Date(endDate as string),
      };
    }

    const transactions = await prisma.financialTransaction.findMany({
      where,
      include: {
        category: true,
      },
    });

    // Group by category and calculate totals
    const incomeByCategory: Record<string, number> = {};
    const expenseByCategory: Record<string, number> = {};
    let totalIncome = 0;
    let totalExpenses = 0;

    transactions.forEach(t => {
      const categoryName = t.category.name;
      if (t.type === 'INCOME') {
        incomeByCategory[categoryName] = (incomeByCategory[categoryName] || 0) + t.amount;
        totalIncome += t.amount;
      } else {
        expenseByCategory[categoryName] = (expenseByCategory[categoryName] || 0) + t.amount;
        totalExpenses += t.amount;
      }
    });

    res.json({
      incomeByCategory,
      expenseByCategory,
      totalIncome,
      totalExpenses,
      netPosition: totalIncome - totalExpenses,
    });
  } catch (error) {
    console.error('Report generation error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

export default router;
