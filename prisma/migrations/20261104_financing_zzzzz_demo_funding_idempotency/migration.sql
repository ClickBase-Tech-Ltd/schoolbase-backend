ALTER TABLE `FinancingApplicationEvent`
  ADD COLUMN `demoActionKey` CHAR(64) NULL,
  ADD UNIQUE INDEX `fin_app_event_demo_action_key` (`demoActionKey`);
