type DateParts = { year: number; month: number; day: number };

function parseDateOnly(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function nextDate({ year, month, day }: DateParts): DateParts {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function zonedMidnightUtc(date: DateParts, timeZone: string): Date {
  const targetUtc = Date.UTC(date.year, date.month - 1, date.day);
  let guess = targetUtc;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, Number(part.value)]));
    const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += targetUtc - representedUtc;
  }
  return new Date(guess);
}

export function buildSchoolDateRange({
  startDate,
  endDate,
  timeZone,
}: {
  startDate?: string;
  endDate?: string;
  timeZone: string;
}): { start: Date | null; endExclusive: Date | null } | null {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    return null;
  }

  const startParts = startDate ? parseDateOnly(startDate) : null;
  const endParts = endDate ? parseDateOnly(endDate) : null;
  if ((startDate && !startParts) || (endDate && !endParts)) return null;
  if (startParts && endParts && Date.UTC(startParts.year, startParts.month - 1, startParts.day) > Date.UTC(endParts.year, endParts.month - 1, endParts.day)) return null;

  return {
    start: startParts ? zonedMidnightUtc(startParts, timeZone) : null,
    endExclusive: endParts ? zonedMidnightUtc(nextDate(endParts), timeZone) : null,
  };
}