import { EmailAuthProvider, reauthenticateWithCredential, sendPasswordResetEmail, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, firebaseReady } from './firebaseClient';

export async function reauthenticateAndDeleteAccount(password: string): Promise<void> {
  const firebaseAuth = auth;
  const user = firebaseAuth?.currentUser;
  if (!firebaseReady || !firebaseAuth || !user?.email) throw new Error('Нужен аккаунт с электронной почтой.');
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  const removeAccount = httpsCallable(getFunctions(firebaseAuth.app), 'deleteMyAccount');
  await removeAccount();
  await signOut(firebaseAuth);
}

export async function sendPasswordReset(email: string): Promise<void> {
  if (!firebaseReady || !auth) throw new Error('Firebase ещё не настроен.');
  await sendPasswordResetEmail(auth, email);
}
