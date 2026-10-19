export type SignupReminderResult = 'sent' | 'not-found' | 'conflict';

export async function deliverPendingSignupReminder(input: {
  generateCode: () => string;
  send: (code: string) => Promise<void>;
  replace: (code: string) => Promise<boolean>;
}): Promise<SignupReminderResult> {
  const code = input.generateCode();
  await input.send(code);
  const replaced = await input.replace(code);
  return replaced ? 'sent' : 'conflict';
}