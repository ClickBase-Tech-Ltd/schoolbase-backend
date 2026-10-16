ALTER TABLE `BankStatementReconciliationEvent`
  MODIFY `action` ENUM('PREPARED', 'APPROVED', 'REOPENED', 'VOIDED', 'BANK_CHARGE_RECORDED') NOT NULL;

-- Extend the enum only after the review-controls migration creates this table.