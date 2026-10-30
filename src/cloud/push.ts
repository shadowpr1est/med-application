import { getToken, getMessaging, isSupported } from 'firebase/messaging';
import { collection, doc, setDoc } from 'firebase/firestore';
import { auth, firestore } from './firebaseClient';
import { firebaseVapidKey } from './firebaseConfig';

export async function registerPushDevice(userId: string): Promise<void> {
  if (!auth?.currentUser || auth.currentUser.uid !== userId || !firestore || !firebaseVapidKey) throw new Error('Firebase Push ещё не настроен. Добавьте VITE_FIREBASE_VAPID_KEY.');
  if (!('Notification' in window) || Notification.permission === 'denied') throw new Error('Разрешите уведомления в настройках браузера.');
  if (!(await isSupported())) throw new Error('Этот браузер не поддерживает Firebase Web Push.');
  if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') throw new Error('Разрешение на уведомления не предоставлено.');
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(), { vapidKey: firebaseVapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error('Браузер не выдал push-токен.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const deviceId = Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,40);
  await setDoc(doc(collection(firestore, `users/${userId}/devices`), deviceId), {
    fcmToken: token,
    platform: 'web',
    userAgent: navigator.userAgent.slice(0,200),
    updatedAt: new Date().toISOString()
  }, { merge: true });
}
