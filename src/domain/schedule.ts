import type { AppData, Medication, ScheduledDose } from './types';

export function dateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function scheduledAt(day: string, time: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, date, hour, minute);
}

export function utcTimestampForLocalSchedule(day: string, time: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, date, hour, minute).toISOString();
}

export function isMedicationScheduled(medication: Medication, date: Date): boolean {
  const key = dateKey(date);
  return medication.active && key >= medication.start && (!medication.end || key <= medication.end) && medication.days.includes(date.getDay());
}

export function removeFutureOpenDoses(data: AppData, medicationId: string, today = dateKey()): void {
  const now = new Date();
  data.doses = data.doses.filter(dose => dose.medId !== medicationId || dose.day < today || (dose.day === today && scheduledAt(dose.day, dose.time) <= now) || dose.status === 'confirmed' || dose.status === 'skipped');
}

export function ensureScheduledDoses(data: AppData, today = new Date(), horizonDays = 60): boolean {
  const existing = new Set(data.doses.map(dose => `${dose.medId}|${dose.day}|${dose.time}`));
  let changed = false;
  for (let offset = -30; offset <= horizonDays; offset++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const key = dateKey(date);
    for (const medication of data.meds) {
      if (!isMedicationScheduled(medication, date)) continue;
      for (const time of medication.times) {
        const occurrence = `${medication.id}|${key}|${time}`;
        if (existing.has(occurrence)) continue;
        const dose: ScheduledDose = {
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, medId: medication.id, day: key, time,
          status: 'scheduled', scheduledAt: utcTimestampForLocalSchedule(key, time), notifications: {}, createdAt: new Date().toISOString()
        };
        data.doses.push(dose);
        existing.add(occurrence);
        changed = true;
      }
    }
  }
  return changed;
}
