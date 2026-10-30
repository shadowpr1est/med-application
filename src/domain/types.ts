export type DoseStatus = 'scheduled' | 'reminded' | 'confirmed' | 'snoozed' | 'missed' | 'unconfirmed' | 'skipped';
export type ConfirmationType = 'photo' | 'manual';
export type ContactMethod = 'email' | 'sms' | 'push';
export type DeliveryStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';

export interface UserProfile {
  id?: string;
  name: string;
  email?: string;
  timezone: string;
  createdAt?: string;
}

export interface Medication {
  id: string;
  userId?: string;
  name: string;
  dosage: string;
  unit: string;
  instructions: string;
  times: string[];
  days: number[];
  start: string;
  end: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledDose {
  id: string;
  userId?: string;
  medId: string;
  day: string;
  time: string;
  scheduledAt?: string;
  status: DoseStatus;
  notificationVersion?: number;
  confirmedAt?: string;
  confirmationType?: ConfirmationType;
  photo?: string | null;
  photoPath?: string;
  skipReason?: string;
  notifications: {
    first?: string;
    repeatIndex?: number;
    contactPrompted?: boolean;
    cancelled?: boolean;
  };
  createdAt: string;
  updatedAt?: string;
}

export interface TrustedContact {
  id?: string;
  userId?: string;
  name: string;
  method: ContactMethod;
  value: string;
  consent: boolean;
  consentAt?: string;
  enabled: boolean;
  createdAt?: string;
}

export interface ReminderSettings {
  repeatMinutes: number;
  repeats: number;
  contactAfter: number;
  allowNoPhoto: boolean;
  notifications: boolean;
}

export interface NotificationEvent {
  id: string;
  userId: string;
  scheduledDoseId: string;
  recipientId: string;
  type: 'dose_reminder' | 'repeat_reminder' | 'trusted_contact_alert';
  scheduledSendAt: string;
  sentAt?: string;
  status: DeliveryStatus;
  retryCount: number;
  errorMessage?: string;
  createdAt: string;
}

export interface AppData {
  version: number;
  cloudRevision?: number;
  profile: UserProfile;
  meds: Medication[];
  doses: ScheduledDose[];
  settings: ReminderSettings;
  contact: TrustedContact;
}
