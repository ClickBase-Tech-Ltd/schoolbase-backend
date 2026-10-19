ALTER TABLE `Invoice`
  ADD COLUMN `issuanceKey` VARCHAR(191) NULL;

UPDATE `Invoice` AS invoice
INNER JOIN (
  SELECT `pupilId`, `feeScheduleId`
  FROM `Invoice`
  GROUP BY `pupilId`, `feeScheduleId`
  HAVING COUNT(*) = 1
) AS unique_invoices
  ON unique_invoices.`pupilId` = invoice.`pupilId`
  AND unique_invoices.`feeScheduleId` = invoice.`feeScheduleId`
SET invoice.`issuanceKey` = SHA2(CONCAT(invoice.`pupilId`, ':', invoice.`feeScheduleId`), 256);

CREATE UNIQUE INDEX `Invoice_issuanceKey_key` ON `Invoice`(`issuanceKey`);