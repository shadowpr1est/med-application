import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile, type User } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, onSnapshot, runTransaction, setDoc, writeBatch, type DocumentData } from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref } from 'firebase/storage';
import { auth, firebaseReady, firestore, storage } from './firebaseClient';
import type { AppData, ScheduledDose } from '../domain/types';
import { defaultData } from '../storage/localStore';
import { utcTimestampForLocalSchedule } from '../domain/schedule';

function requireFirebase() {
  if (!auth || !firestore || !storage) throw new Error('Firebase ещё не настроен. Добавьте VITE_FIREBASE_* в окружение.');
  return { auth, firestore, storage };
}

function userPath(uid: string, collectionName: string): string { return `users/${uid}/${collectionName}`; }

async function readCollection<T extends DocumentData>(uid: string, name: string): Promise<T[]> {
  const { firestore: db } = requireFirebase();
  const result = await getDocs(collection(db, userPath(uid, name)));
  return result.docs.map(item => ({ ...item.data(), id: item.id } as unknown as T));
}

async function writeCollection(uid: string, name: string, records: Array<{ id: string; [key: string]: unknown }>): Promise<void> {
  const { firestore: db } = requireFirebase();
  const previous = await getDocs(collection(db, userPath(uid, name)));
  const previousById = new Map(previous.docs.map(item => [item.id, item.data()]));
  const nextIds = new Set(records.map(record => record.id));
  const writes: Array<{ type: 'set' | 'delete'; id: string; payload?: Record<string, unknown> }> = [];
  for (const record of records) {
    const { id, ...payload } = record;
    const next = { ...payload, userId: uid };
    if (JSON.stringify(sortKeys(next)) !== JSON.stringify(sortKeys(previousById.get(id) || {}))) writes.push({ type: 'set', id, payload: next });
  }
  for (const old of previous.docs) if (!nextIds.has(old.id)) writes.push({ type: 'delete', id: old.id });
  for (let offset = 0; offset < writes.length; offset += 450) {
    const batch = writeBatch(db);
    for (const operation of writes.slice(offset, offset + 450)) {
      const target = doc(db, userPath(uid, name), operation.id);
      if (operation.type === 'delete') batch.delete(target);
      else batch.set(target, operation.payload!);
    }
    await batch.commit();
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sortKeys(item)]));
  return value;
}

function doseForCloud(dose: ScheduledDose): { id: string; [key: string]: unknown } {
  const { photo, ...fields } = dose;
  return { ...fields, id: dose.id, scheduledAt: dose.scheduledAt || utcTimestampForLocalSchedule(dose.day,dose.time) };
}

export async function readCloudData(uid: string): Promise<AppData | null> {
  const { firestore: db } = requireFirebase();
  const profileDoc = await getDoc(doc(db, 'users', uid));
  if (!profileDoc.exists()) return null;
  const [meds, doses, settingDoc, contactDoc] = await Promise.all([
    readCollection<AppData['meds'][number]>(uid, 'medications'),
    readCollection<AppData['doses'][number]>(uid, 'scheduledDoses'),
    getDoc(doc(db, userPath(uid, 'settings'), 'current')),
    getDoc(doc(db, userPath(uid, 'trustedContacts'), 'current'))
  ]);
  const profileData=profileDoc.data()||{};
  const { schemaVersion, syncRevision, updatedAt, cloudWriteId, cloudWriteUntil, deletionInProgress, ...profileFields }=profileData;
  return {
    version: 2,
    cloudRevision: Number(syncRevision || 0),
    profile: { ...defaultData.profile, ...profileFields, id: uid },
    meds,
    doses,
    settings: { ...defaultData.settings, ...(settingDoc.data() || {}) },
    contact: { ...defaultData.contact, ...(contactDoc.data() || {}) }
  };
}

export async function writeCloudData(uid: string, data: AppData): Promise<void> {
  const { firestore: db } = requireFirebase();
  const profileRef=doc(db, 'users', uid);
  const writerId=`${Date.now()}_${Math.random().toString(36).slice(2)}`, now=Date.now();
  await runTransaction(db,async transaction=>{
    const snapshot=await transaction.get(profileRef), profile=snapshot.data()||{};
    const revision=Number(profile.syncRevision||0), expected=data.cloudRevision;
    if(expected!==undefined&&expected!==revision)throw new Error('Облачные данные изменились на другом устройстве. Обновите страницу и повторите изменение.');
    if(Number(profile.cloudWriteUntil||0)>now&&profile.cloudWriteId!==writerId)throw new Error('Данные сейчас синхронизируются с другого устройства. Повторите через несколько секунд.');
    transaction.set(profileRef,{cloudWriteId:writerId,cloudWriteUntil:now+120_000},{merge:true});
  });
  try {
    await setDoc(profileRef, { ...data.profile, id: uid, schemaVersion: 2 }, { merge: true });
    const cloudDoses = data.doses.map(doseForCloud);
    await Promise.all([
      writeCollection(uid, 'medications', data.meds.map(med => ({ ...med, id: med.id, userId: uid }))),
      writeCollection(uid, 'scheduledDoses', cloudDoses.map(dose => ({ ...dose, userId: uid })))
    ]);
    await Promise.all([
      setDocumentIfChanged(db, userPath(uid, 'settings'), 'current', data.settings),
      setDocumentIfChanged(db, userPath(uid, 'trustedContacts'), 'current', { ...data.contact, userId: uid })
    ]);
    data.cloudRevision=await runTransaction(db,async transaction=>{
      const snapshot=await transaction.get(profileRef);
      if(snapshot.get('cloudWriteId')!==writerId)throw new Error('Облачная блокировка истекла; повторите синхронизацию.');
      const next=Number(snapshot.get('syncRevision')||0)+1;
      transaction.set(profileRef,{syncRevision:next,cloudWriteId:'',cloudWriteUntil:0,updatedAt:new Date().toISOString()},{merge:true});
      return next;
    });
  } catch(error) {
    await runTransaction(db,async transaction=>{
      const snapshot=await transaction.get(profileRef);
      if(snapshot.get('cloudWriteId')===writerId)transaction.set(profileRef,{cloudWriteId:'',cloudWriteUntil:0},{merge:true});
    }).catch(()=>undefined);
    throw error;
  }
}

export async function getDosePhotoUrl(uid: string, photoPath: string): Promise<string> {
  const { storage: cloudStorage } = requireFirebase();
  if (auth?.currentUser?.uid !== uid || !photoPath.startsWith(`users/${uid}/dose-photos/`)) throw new Error('Нет доступа к этому фото.');
  return getDownloadURL(ref(cloudStorage, photoPath));
}

export async function deleteDosePhoto(uid: string, photoPath: string): Promise<void> {
  const { storage: cloudStorage } = requireFirebase();
  if (auth?.currentUser?.uid !== uid || !photoPath.startsWith(`users/${uid}/dose-photos/`)) throw new Error('Нет доступа к этому фото.');
  await deleteObject(ref(cloudStorage, photoPath));
}

async function setDocumentIfChanged(db: NonNullable<typeof firestore>, collectionName: string, id: string, payload: object): Promise<void> {
  const target=doc(db, collectionName, id), before=await getDoc(target);
  if(JSON.stringify(sortKeys(before.data()||{}))!==JSON.stringify(sortKeys(payload))) await setDoc(target,payload as DocumentData);
}

export function watchCloudRevision(uid: string, onChange: () => void, onError: (error: Error) => void): () => void {
  const { firestore: db } = requireFirebase();
  let first=true,lastRevision=-1;
  return onSnapshot(doc(db,'users',uid),snapshot=>{
    const revision=Number(snapshot.data()?.syncRevision||0);
    if(first){first=false;lastRevision=revision;return;}
    if(revision===lastRevision)return;
    lastRevision=revision;onChange();
  },error=>onError(error));
}

export async function registerAndUpload(email: string, password: string, displayName: string, data: AppData): Promise<User> {
  const { auth: firebaseAuth } = requireFirebase();
  const credential = await createUserWithEmailAndPassword(firebaseAuth, email, password);
  if (displayName.trim()) await updateProfile(credential.user, { displayName: displayName.trim() });
  data.cloudRevision=0;
  data.profile = { ...data.profile, id: credential.user.uid, name: displayName.trim() || data.profile.name, email, createdAt: new Date().toISOString() };
  await writeCloudData(credential.user.uid, data);
  return credential.user;
}

export async function signInAndDownload(email: string, password: string, localData: AppData): Promise<{ user: User; data: AppData; importedLocal: boolean }> {
  const { auth: firebaseAuth } = requireFirebase();
  const credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
  const cloudData = await readCloudData(credential.user.uid);
  if (!cloudData) {
    localData.cloudRevision=0;
    localData.profile={...localData.profile,id:credential.user.uid,email:credential.user.email||email,createdAt:new Date().toISOString()};
    await writeCloudData(credential.user.uid,localData);
    return { user: credential.user, data: localData, importedLocal: true };
  }
  return { user: credential.user, data: cloudData, importedLocal: false };
}

export async function signOutCloud(): Promise<void> {
  const { auth: firebaseAuth } = requireFirebase();
  await signOut(firebaseAuth);
}

export { firebaseReady };
