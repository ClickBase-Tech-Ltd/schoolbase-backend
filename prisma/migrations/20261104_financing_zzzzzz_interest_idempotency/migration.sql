ALTER TABLE `FinancingApplication`
  ADD COLUMN `interestKey` CHAR(64) NULL,
  ADD UNIQUE INDEX `fin_application_interest_key` (`interestKey`);
