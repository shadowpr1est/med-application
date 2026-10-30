import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type DocumentData, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { getFunctions } from 'firebase-admin/functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { localDoseAsUtc } from './doseTime.js';

initializeApp();
const db = getFirestore();
const queue = getFunctions().taskQueue<TaskPayload>('dispatchDoseNotification');
const resendApiKey = defineSecret('RESEND_API_KEY');
const resendFrom = defineString('RESEND_FROM');
const MAX_TASK_HORIZON_MS = 29 * 24 * 60 * 60 * 1000;
const TASK_KINDS: TaskKind[] = ['reminder', 'contact', 'repeat'];

type TaskKind = 'reminder' | 'repeat' | 'contact';
interface TaskPayload { userId: string; doseId: string; kind: TaskKind; sequence: number; version: number }
interface DoseRecord extends DocumentData { id?: string; medId?: string; day?: string; time?: string; scheduledAt?: string; status?: string; notificationVersion?: number; notifications?: Record<string, unknown> }

const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90);
const taskId = (task: TaskPayload) => `sm_${safeId(task.userId)}_${safeId(task.doseId)}_v${task.version}_${task.kind}_${task.sequence}`.slice(0, 480);
const doseRef = (userId: string, doseId: string) => db.doc(`users/${userId}/scheduledDoses/${doseId}`);
const userRef = (userId: string) => db.doc(`users/${userId}`);
const tasksForDose = (userId: string, doseId: string, version: number): TaskPayload[] => TASK_KINDS.flatMap(kind => Array.from({ length: 12 }, (_, index) => ({ userId, doseId, kind, sequence: index, version })));

function notificationEventRef(task: TaskPayload) {
  return db.doc(`users/${task.userId}/notificationEvents/${taskId(task)}`);
}

async function enqueue(task: TaskPayload, when: Date): Promise<void> {
  const scheduleTime = when.getTime() < Date.now() ? new Date(Date.now() + 1000) : when;
  if (scheduleTime.getTime() - Date.now() > MAX_TASK_HORIZON_MS) return;
  try {
    await queue.enqueue(task, { id: taskId(task), scheduleTime, dispatchDeadlineSeconds: 60 });
  } catch (error) {
    const code = String((error as { code?: string }).code || '');
    if (code.includes('already-exists') || code.includes('ALREADY_EXISTS')) return;
    throw error;
  }
}

async function cancelDoseTasks(userId: string, doseId: string, version: number): Promise<void> {
  await Promise.all(tasksForDose(userId, doseId, version).map(task => queue.delete(taskId(task)).catch(() => undefined)));
}

async function cancelDoseFollowUps(userId: string, doseId: string, version: number): Promise<void> {
  await Promise.all(tasksForDose(userId, doseId, version).filter(task => task.kind !== 'reminder').map(task => queue.delete(taskId(task)).catch(() => undefined)));
}

async function advanceDoseVersion(userId: string, doseId: string, expectedVersion: number): Promise<DoseRecord | null> {
  const ref = doseRef(userId, doseId);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const dose = snapshot.data() as DoseRecord | undefined;
    if (!dose || !['scheduled', 'reminded'].includes(dose.status || '')) return null;
    const currentVersion = Number(dose.notificationVersion || 0);
    if (currentVersion <= expectedVersion) {
      dose.notificationVersion = expectedVersion + 1;
      transaction.set(ref, { notificationVersion: dose.notificationVersion }, { merge: true });
    }
    return dose;
  });
}

async function scheduleDose(userId: string, doseId: string, dose: DoseRecord): Promise<void> {
  if (!dose.day || !dose.time || dose.status !== 'scheduled') return;
  const profile = (await userRef(userId).get()).data() || {};
  const scheduledAt = dose.scheduledAt ? new Date(dose.scheduledAt) : localDoseAsUtc(dose.day, dose.time, profile.timezone || 'UTC');
  if (scheduledAt.getTime() - Date.now() > MAX_TASK_HORIZON_MS) return;
  await enqueue({ userId, doseId, kind: 'reminder', sequence: 0, version: Number(dose.notificationVersion || 0) }, scheduledAt);
}

async function rescheduleUserDoses(userId: string): Promise<void> {
  const pending = await db.collection(`users/${userId}/scheduledDoses`).where('status', 'in', ['scheduled', 'reminded']).get();
  await Promise.all(pending.docs.map(async snapshot => {
    const dose=snapshot.data() as DoseRecord;
    if(dose.status==='reminded'){
      const version=Number(dose.notificationVersion||0);
      const current=await advanceDoseVersion(userId,snapshot.id,version);
      if(current){await cancelDoseFollowUps(userId,snapshot.id,version);await scheduleFollowUps(userId,snapshot.id,current,'reminder',0);}
    }
  }));
}

async function scheduleFollowUps(userId: string, doseId: string, dose: DoseRecord, kind: TaskKind, sequence: number): Promise<void> {
  if (!dose.day || !dose.time) return;
  const profile = (await userRef(userId).get()).data() || {};
  const scheduledAt = dose.scheduledAt ? new Date(dose.scheduledAt) : localDoseAsUtc(dose.day, dose.time, profile.timezone || 'UTC');
  if (kind === 'reminder' || kind === 'repeat') {
    const settingsSnapshot = await db.doc(`users/${userId}/settings/current`).get();
    const settings = settingsSnapshot.data() || {};
    const repeats = Math.max(0, Math.min(10, Number(settings.repeats ?? 2)));
    const repeatMinutes = Math.max(1, Math.min(1440, Number(settings.repeatMinutes ?? 5)));
    const nextRepeat = kind === 'reminder' ? 1 : sequence + 1;
    if (nextRepeat <= repeats) await enqueue({ userId, doseId, kind: 'repeat', sequence: nextRepeat, version: Number(dose.notificationVersion || 0) }, new Date(scheduledAt.getTime() + repeatMinutes * nextRepeat * 60_000));
    if (kind === 'reminder') {
      const contactSnapshot = await db.doc(`users/${userId}/trustedContacts/current`).get();
      const contact = contactSnapshot.data() || {};
      if (contact.enabled && contact.consent && contact.value) {
        const afterMinutes = Math.max(1, Math.min(7 * 24 * 60, Number(settings.contactAfter ?? 10)));
        await enqueue({ userId, doseId, kind: 'contact', sequence: 0, version: Number(dose.notificationVersion || 0) }, new Date(scheduledAt.getTime() + afterMinutes * 60_000));
      }
    }
  }
}

async function claimEvent(task: TaskPayload): Promise<'claimed' | 'finished' | 'busy' | 'obsolete'> {
  const ref = notificationEventRef(task);
  return db.runTransaction(async transaction => {
    const [doseSnapshot, ownerSnapshot] = await Promise.all([
      transaction.get(doseRef(task.userId, task.doseId)), transaction.get(userRef(task.userId))
    ]);
    if (ownerSnapshot.get('deletionInProgress') === true) return 'obsolete';
    if (!doseSnapshot.exists) return 'obsolete';
    if (!['scheduled', 'reminded'].includes(String(doseSnapshot.get('status') || '')) || Number(doseSnapshot.get('notificationVersion') || 0) !== task.version) {
      transaction.set(ref, { id: taskId(task), userId: task.userId, scheduledDoseId: task.doseId, status: 'cancelled', updatedAt: new Date().toISOString() }, { merge: true });
      return 'obsolete';
    }
    const snapshot = await transaction.get(ref);
    const current = snapshot.data();
    if (current?.status === 'sent' || current?.status === 'cancelled') return 'finished';
    if (current?.status === 'processing' && Number(current.leaseUntil || 0) > Date.now()) return 'busy';
    transaction.set(ref, {
      id: taskId(task), userId: task.userId, scheduledDoseId: task.doseId,
      recipientId: task.kind === 'contact' ? 'trusted-contact' : task.userId,
      type: task.kind === 'contact' ? 'trusted_contact_alert' : task.kind === 'repeat' ? 'repeat_reminder' : 'dose_reminder',
      status: 'processing', sequence: task.sequence, leaseUntil: Date.now() + 120_000,
      retryCount: Number(current?.retryCount || 0), updatedAt: new Date().toISOString(),
      createdAt: current?.createdAt || new Date().toISOString()
    }, { merge: true });
    return 'claimed';
  });
}

async function taskStillCurrent(task: TaskPayload): Promise<boolean> {
  return db.runTransaction(async transaction => {
    const [snapshot, owner] = await Promise.all([
      transaction.get(doseRef(task.userId, task.doseId)), transaction.get(userRef(task.userId))
    ]);
    return snapshot.exists && owner.exists && owner.get('deletionInProgress') !== true
      && ['scheduled', 'reminded'].includes(String(snapshot.get('status') || ''))
      && Number(snapshot.get('notificationVersion') || 0) === task.version;
  });
}

async function finishEvent(task: TaskPayload, status: 'sent' | 'failed' | 'cancelled', errorMessage?: string): Promise<void> {
  const ref=notificationEventRef(task), previous=await ref.get(), retryCount=Number(previous.data()?.retryCount||0)+(status==='failed'?1:0);
  await ref.set({
    status,
    sentAt: status === 'sent' ? new Date().toISOString() : null,
    retryCount,
    errorMessage: errorMessage || null,
    leaseUntil: 0,
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

async function sendPush(userId: string, doseId: string, task: TaskPayload): Promise<boolean> {
  if (!(await taskStillCurrent(task))) return false;
  const devices = await db.collection(`users/${userId}/devices`).get();
  const tokens = devices.docs.map(device => ({ id: device.id, token: device.get('fcmToken') as string | undefined })).filter((item): item is { id: string; token: string } => Boolean(item.token));
  if (!tokens.length) throw new Error('No registered push device for this account.');
  const response = await getMessaging().sendEachForMulticast({
    tokens: tokens.map(item => item.token),
    notification: { title: task.kind === 'repeat' ? 'Напоминание SmartMed' : 'Время приёма лекарства', body: 'Запланированный приём пока не отмечен в приложении.' },
    data: { doseId, kind: task.kind },
    webpush: { notification: { icon: '/icon.svg', tag: taskId(task), renotify: false } }
  });
  const invalid = response.responses.flatMap((result, index) => result.error?.code === 'messaging/registration-token-not-registered' ? [tokens[index].id] : []);
  await Promise.all(invalid.map(deviceId => db.doc(`users/${userId}/devices/${deviceId}`).delete()));
  if (response.successCount === 0) throw new Error('Push delivery failed for all registered devices.');
  return true;
}

async function sendTrustedEmail(userId: string, dose: DoseRecord, task: TaskPayload): Promise<boolean> {
  const contactSnapshot = await db.doc(`users/${userId}/trustedContacts/current`).get();
  const contact = contactSnapshot.data() || {};
  if (!(await taskStillCurrent(task))) return false;
  if (!contact.enabled || !contact.consent || !contact.value) throw new Error('Trusted contact is disabled or has not consented.');
  if (contact.method !== 'email') throw new Error('This backend currently delivers trusted-contact alerts by email only.');
  if (typeof resendApiKey.value() !== 'string' || !resendApiKey.value()) throw new Error('RESEND_API_KEY is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendApiKey.value()}`, 'Content-Type': 'application/json', 'Idempotency-Key': taskId(task) },
    body: JSON.stringify({
      from: resendFrom.value(), to: [String(contact.value)],
      subject: 'SmartMed: приём пока не подтверждён',
      text: `SmartMed: запланированный на ${String(dose.time || '')} приём пока не отмечен в приложении. Пожалуйста, свяжитесь с пользователем, если это необходимо.`,
      tags: [{ name: 'source', value: 'smartmed' }]
    })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
  return true;
}

async function markDoseReminded(task: TaskPayload): Promise<boolean> {
  const ref = doseRef(task.userId, task.doseId), ownerRef = userRef(task.userId);
  return db.runTransaction(async transaction => {
    const [snapshot, owner] = await Promise.all([transaction.get(ref), transaction.get(ownerRef)]);
    if (!snapshot.exists || !owner.exists || owner.get('deletionInProgress') === true || snapshot.get('status') !== 'scheduled' || Number(snapshot.get('notificationVersion') || 0) !== task.version) return false;
    transaction.set(ref, { status: 'reminded', updatedAt: new Date().toISOString() }, { merge: true });
    transaction.set(ownerRef, { syncRevision: Number(owner.get('syncRevision') || 0) + 1, updatedAt: new Date().toISOString() }, { merge: true });
    return true;
  });
}

export const scheduleDoseOnChange = onDocumentWritten('users/{userId}/scheduledDoses/{doseId}', async event => {
  const { userId, doseId } = event.params;
  const before = event.data?.before.data() as DoseRecord | undefined;
  const after = event.data?.after.data() as DoseRecord | undefined;
  if (!after || ['confirmed', 'skipped', 'missed'].includes(after.status || '')) {
    await cancelDoseTasks(userId, doseId, Number((after || before)?.notificationVersion || 0));
    return;
  }
  const changed = !before || before.day !== after.day || before.time !== after.time || before.medId !== after.medId || ['confirmed', 'skipped', 'missed'].includes(before.status || '');
  if (!changed) return;
  if (before) await cancelDoseTasks(userId, doseId, Number(before.notificationVersion || 0));
  const current = await advanceDoseVersion(userId, doseId, Number(before?.notificationVersion || 0));
  if (current) await scheduleDose(userId, doseId, current);
});

export const rescheduleOnSettingsChange = onDocumentWritten('users/{userId}/settings/current', async event => {
  if (event.data?.before.exists && JSON.stringify(event.data.before.data()) === JSON.stringify(event.data.after.data())) return;
  await rescheduleUserDoses(event.params.userId);
});

export const rescheduleOnContactChange = onDocumentWritten('users/{userId}/trustedContacts/current', async event => {
  if (event.data?.before.exists && JSON.stringify(event.data.before.data()) === JSON.stringify(event.data.after.data())) return;
  await rescheduleUserDoses(event.params.userId);
});

export const expandDoseScheduleWindow = onSchedule('every day 00:20', async () => {
  const now = new Date();
  const day = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const until = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const snapshot = await db.collectionGroup('scheduledDoses').where('day', '>=', day(from)).where('day', '<=', day(until)).get();
  const tasks: Promise<void>[] = [];
  for (const item of snapshot.docs as QueryDocumentSnapshot<DoseRecord>[]) {
    const dose = item.data();
    const userId = String(item.ref.parent.parent?.id || '');
    if (dose.userId && dose.userId !== userId) {
      logger.warn('Skipped dose with mismatched owner field', { dosePath: item.ref.path });
      continue;
    }
    if (!userId || !['scheduled', 'reminded'].includes(dose.status || '')) continue;
    const profile = (await userRef(userId).get()).data() || {};
    const due = dose.scheduledAt ? new Date(dose.scheduledAt) : dose.day && dose.time ? localDoseAsUtc(dose.day, dose.time, profile.timezone || 'UTC') : null;
    if (due && due.getTime() - now.getTime() <= MAX_TASK_HORIZON_MS) tasks.push(scheduleDose(userId, item.id, dose));
  }
  await Promise.all(tasks);
  logger.info('Expanded scheduled-dose window', { inspected: snapshot.size, queued: tasks.length });
});

export const dispatchDoseNotification = onTaskDispatched({
  retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 600, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 20 },
  secrets: [resendApiKey],
  timeoutSeconds: 60
}, async request => {
  const task = request.data as TaskPayload;
  if (typeof task?.userId !== 'string' || typeof task.doseId !== 'string' || !task.userId || !task.doseId || !Number.isInteger(task.version) || task.version < 0 || !Number.isInteger(task.sequence) || task.sequence < 0 || task.sequence > 12 || !['reminder', 'repeat', 'contact'].includes(task.kind)) throw new Error('Invalid task payload.');
  const doseSnapshot = await doseRef(task.userId, task.doseId).get();
  if (!doseSnapshot.exists) return;
  const dose = doseSnapshot.data() as DoseRecord | undefined;
  if (!dose || !['scheduled', 'reminded'].includes(dose.status || '') || Number(dose.notificationVersion || 0) !== task.version) {
    await finishEvent(task, 'cancelled', 'Dose no longer needs a reminder.');
    return;
  }
  const claim = await claimEvent(task);
  if (claim === 'finished' || claim === 'obsolete') return;
  if (claim === 'busy') throw new Error('Notification event is already being processed; retry after the active lease.');
  try {
    if (task.kind !== 'contact') await scheduleFollowUps(task.userId, task.doseId, dose, task.kind, task.sequence);
    const delivered = task.kind === 'contact'
      ? await sendTrustedEmail(task.userId, dose, task)
      : await sendPush(task.userId, task.doseId, task);
    if (!delivered) { await finishEvent(task, 'cancelled', 'Dose changed before delivery.'); return; }
    await finishEvent(task, 'sent');
    if (task.kind === 'reminder') {
      await markDoseReminded(task);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Notification delivery failed.';
    await finishEvent(task, 'failed', message);
    logger.error('SmartMed notification failed', { taskId: taskId(task), message });
    if (message.includes('disabled') || message.includes('has not consented') || message.includes('currently delivers')) return;
    throw error;
  }
});

export const deleteMyAccount = onCall({ timeoutSeconds: 540 }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Войдите в аккаунт, чтобы удалить его.');
  const authTime = Number(request.auth.token.auth_time || 0) * 1000;
  if (!authTime || Date.now() - authTime > 5 * 60_000) throw new HttpsError('failed-precondition', 'Для удаления аккаунта войдите в него повторно.');
  const userId = request.auth.uid;
  const user = userRef(userId);
  await user.set({ deletionInProgress: true, updatedAt: new Date().toISOString() }, { merge: true });
  const doses = await db.collection(`users/${userId}/scheduledDoses`).get();
  await Promise.all(doses.docs.map(snapshot => cancelDoseTasks(userId, snapshot.id, Number(snapshot.get('notificationVersion') || 0))));
  await getStorage().bucket().deleteFiles({ prefix: `users/${userId}/` });
  await db.recursiveDelete(user);
  await getAuth().deleteUser(userId);
  return { deleted: true };
});
