export type AccountingLedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
};

export type AccountingLedgerLine = {
  accountId: string;
  accountCode?: string;
  side: 'DEBIT' | 'CREDIT';
  amount: number;
};

export type AccountingBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountingLedgerAccount['type'];
  debitTotal: number;
  creditTotal: number;
  balanceMinor: number;
};

export function calculateAccountingBalances({
  accounts,
  journalLines,
}: {
  accounts: AccountingLedgerAccount[];
  journalLines: AccountingLedgerLine[];
}) {
  const rows = new Map<string, AccountingBalanceRow>();

  for (const account of accounts) {
    rows.set(account.id, {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      debitTotal: 0,
      creditTotal: 0,
      balanceMinor: 0,
    });
  }

  for (const line of journalLines) {
    const targetAccount = accounts.find((account) => account.id === line.accountId || account.code === line.accountCode);
    if (!targetAccount) continue;

    const row = rows.get(targetAccount.id) ?? {
      accountId: targetAccount.id,
      code: targetAccount.code,
      name: targetAccount.name,
      type: targetAccount.type,
      debitTotal: 0,
      creditTotal: 0,
      balanceMinor: 0,
    };

    if (line.side === 'DEBIT') {
      row.debitTotal += Number(line.amount) || 0;
    } else {
      row.creditTotal += Number(line.amount) || 0;
    }

    row.balanceMinor = row.debitTotal - row.creditTotal;
    rows.set(targetAccount.id, row);
  }

  return Array.from(rows.values()).sort((left, right) => left.code.localeCompare(right.code));
}
