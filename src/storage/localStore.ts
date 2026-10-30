import type { AppData, Medication, ScheduledDose } from '../domain/types';
import { utcTimestampForLocalSchedule } from '../domain/schedule';

export const STORAGE_KEY = 'smartmed.v1';

export const defaultData: AppData = {
  version: 2,
  profile: { name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local' },
  meds: [],
  doses: [],
  settings: { repeatMinutes: 5, repeats: 2, contactAfter: 10, allowNoPhoto: true, notifications: false },
  contact: { name: '', method: 'email', value: '', consent: false, enabled: false }
};

export function loadData(): AppData {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<AppData>;
    const medications = (raw.meds || []).map((medication: Medication) => ({
      ...medication,
      days: Array.isArray(medication.days) ? medication.days : [0, 1, 2, 3, 4, 5, 6],
      times: Array.isArray(medication.times) ? medication.times : []
    }));
    const doses = (raw.doses || []).map((dose: ScheduledDose) => ({
      ...dose,
      scheduledAt: dose.scheduledAt || utcTimestampForLocalSchedule(dose.day, dose.time),
      status: dose.status || 'scheduled',
      notifications: dose.notifications || {},
      createdAt: dose.createdAt || new Date().toISOString()
    }));
    const profile = { ...defaultData.profile, ...raw.profile };
    if (profile.name === 'Саша') profile.name = '';
    return {
      ...defaultData,
      ...raw,
      version: 2,
      profile,
      settings: { ...defaultData.settings, ...raw.settings },
      contact: { ...defaultData.contact, ...raw.contact },
      meds: medications,
      doses
    };
  } catch {
    return structuredClone(defaultData);
  }
}

export function saveData(data: AppData): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
