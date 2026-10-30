const formatterCache = new Map<string, Intl.DateTimeFormat>();

function asLocalNumber(timestamp: number, timeZone: string): number {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

export function localDoseAsUtc(day: string, time: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const normalizedDate = new Date(Date.UTC(year, month - 1, date));
  if (!year || month < 1 || month > 12 || date < 1 || date > 31 || normalizedDate.getUTCFullYear() !== year || normalizedDate.getUTCMonth() !== month - 1 || normalizedDate.getUTCDate() !== date || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new RangeError('Invalid local dose date or time.');
  }
  const desired = Date.UTC(year, month - 1, date, hour, minute);
  const seen = new Set<number>();
  let instant = desired;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (seen.has(instant)) break;
    seen.add(instant);
    const adjustment = desired - asLocalNumber(instant, timeZone);
    if (adjustment === 0) return new Date(instant);
    instant += adjustment;
  }
  const candidates = [...seen].map(candidate => ({ candidate, difference: asLocalNumber(candidate, timeZone) - desired }));
  const exact = candidates.filter(candidate => candidate.difference === 0).sort((a,b)=>a.candidate-b.candidate);
  if (exact.length) return new Date(exact[0].candidate); // Ambiguous fall-back time resolves to the earlier occurrence.
  const afterGap = candidates.filter(candidate => candidate.difference > 0).sort((a,b)=>a.difference-b.difference||a.candidate-b.candidate);
  if (afterGap.length) return new Date(afterGap[0].candidate); // A nonexistent spring-forward time moves to the first local time after the gap.
  throw new RangeError(`Could not resolve ${day} ${time} in ${timeZone}.`);
}
