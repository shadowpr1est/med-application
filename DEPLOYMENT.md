# Подготовка SmartMed к запуску

Сейчас приложение можно использовать локально. Этот файл описывает подключение собственных Firebase/Netlify-проектов. В проекте пока нет привязанных облачных аккаунтов и реальных ключей; ничего не публикуйте, пока не настроите отдельное тестовое окружение.

## 1. Локальная проверка

```powershell
npm install
npm install --prefix functions
npm start
```

Для локальных тестов серверных функций с Firebase Emulator Suite:

```powershell
npm install -g firebase-tools
firebase login
firebase emulators:start --only auth,firestore,storage,functions
```

Переменные Web App разместите в `.env.local`, скопировав `.env.example`. Этот файл игнорируется Git. Создайте Firebase Web App и включите Email/Password в Authentication. В Firebase Console создайте Firestore и Storage bucket, затем укажите Web App config, VAPID key и разрешённый домен.

```dotenv
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_VAPID_KEY=...
```

Web config предназначена клиенту и не содержит Admin SDK credentials. Ограничьте API key доступными Firebase API и доменами. Не вставляйте service-account JSON в PWA, Netlify-переменные `VITE_*` или Git.

## 2. Настроить Firebase

1. Создайте отдельные Firebase-проекты для `staging` и `production`.
2. Для каждого создайте Web App, включите Email/Password, Firestore и Storage.
3. В Cloud Messaging создайте Web Push certificate/VAPID key; HTTPS-домен и service worker необходимы для Web Push.
4. В `.firebaserc` задайте project aliases (файл содержит только идентификаторы проектов, без ключей).
5. Проверьте `firestore.rules` и `storage.rules` на тестовых аккаунтах и разверните их:

```powershell
firebase use staging
firebase deploy --only firestore:rules,storage
```

6. Cloud Functions используют Cloud Tasks для индивидуальных запусков и ежедневную задачу для расписаний, выходящих за 30-дневный горизонт. Firebase Functions/Cloud Tasks требуют активного биллинга Google Cloud. Установите бюджетные оповещения до запуска.
7. Для email доверенному человеку создайте аккаунт Resend, подтвердите домен отправителя, настройте секрет и адрес:

```powershell
firebase functions:secrets:set RESEND_API_KEY
```

При deploy Firebase CLI запросит `RESEND_FROM`; укажите подтверждённый в Resend адрес (например `SmartMed <notifications@your-domain>`). Не используйте демонстрационный домен в production. Resend поддерживает `Idempotency-Key` для повторной отправки того же письма; ключи и одинаковый body позволяют безопасно повторять запросы в пределах окна провайдера. [Документация Resend по idempotency keys](https://resend.com/changelog/idempotency-keys).

8. Скомпилируйте и разверните серверные функции:

```powershell
npm run functions:build
firebase deploy --only functions
```

## 3. Публиковать на Netlify

1. Создайте приватный Git remote и отправьте ветку `main` после проверки.
2. В Netlify выберите **Add new site → Import an existing project** и подключите репозиторий.
3. `netlify.toml` задаёт команду сборки `npm run build` и папку публикации `dist`.
4. В Site configuration → Environment variables добавьте Firebase Web App config и `VITE_FIREBASE_VAPID_KEY`. Не добавляйте `RESEND_API_KEY` в Netlify: он принадлежит Firebase Functions.
5. Добавьте Netlify preview URL и production domain в Firebase Authentication authorized domains.
6. Запустите deploy preview, проверьте регистрацию, чтение/запись собственного расписания, Web Push, сервис-воркер и CSP/заголовки; затем сделайте production deploy.

## 4. Текущее поведение и оставшиеся ограничения

- Без Firebase config профиль и лекарства остаются локальными.
- При регистрации локальный набор переносится в новый Firebase аккаунт; при входе загружается cloud snapshot. Revision/lease останавливает незаметную перезапись, а пользователю показывается выбор версии; большие частичные sync и офлайн-восстановление ещё нужно проверить в Emulator Suite.
- Серверные задачи повторно проверяют статус приёма. Доставка внешнему провайдеру не может быть строго exactly-once при сетевом обрыве после фактической отправки; задача использует транзакционный event claim, а Resend получает idempotency key. Firebase Emulator и реальные тестовые доставки обязательны до production.
- Поддерживается email доверенному человеку и удаление аккаунта с каскадной очисткой Firestore/Storage. SMS, push контактам-не-пользователям и нативная упаковка Android/iOS ещё не сделаны.
- Уведомление подтверждает событие пользователя, но не доказывает, что препарат был проглочен.
