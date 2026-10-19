UPDATE `Invoice` AS invoice
INNER JOIN (
  SELECT `pupilId`, `feeScheduleId`, MIN(`id`) AS `representativeId`
  FROM `Invoice`
  WHERE `status` <> 'VOIDED'
  GROUP BY `pupilId`, `feeScheduleId`
) AS representatives
  ON representatives.`representativeId` = invoice.`id`
SET invoice.`issuanceKey` = SHA2(CONCAT(invoice.`pupilId`, ':', invoice.`feeScheduleId`), 256)
WHERE invoice.`issuanceKey` IS NULL;
