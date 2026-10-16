ALTER TABLE `Payment`
  ADD COLUMN `idempotencyKey` VARCHAR(191) NULL,
  ADD UNIQUE INDEX `Payment_invoiceId_idempotencyKey_key` (`invoiceId`, `idempotencyKey`),
  ADD INDEX `Payment_idempotencyKey_idx` (`idempotencyKey`);
