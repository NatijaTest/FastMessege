# FastMessage — yangilanish

## O'rnatish
1. Hamma fayllarni loyihadagi eski fayllar o'rniga qo'ying (yangi fayl: filestore.js).
2. Firebase Console -> Realtime Database -> Rules -> database_rules.json ni qo'yib Publish qiling.
3. (Ixtiyoriy) Storage yoqilgan bo'lsa storage.rules ni ham Publish qiling.

## Nima o'zgardi
- Rasm/video/fayl/ovozli xabar: Storage ishlamasa, fayl Realtime Database'ga bo'laklab saqlanadi (15 MB gacha).
- Keys ochilishi: ~22 soniya, sekin to'xtab-to'xtab tushadi.

- 2 bosqichli tasdiq (Sozlamalar -> Maxfiylik): parol to'g'ri bo'lsa pochtaga Firebase xati keladi, havolani ochib "Ha, bu men / Yo'q" bosiladi. Fayl: twostep.js.
  SOZLASH: Firebase Console -> Authentication -> Sign-in method -> Email/Password -> "Email link (passwordless sign-in)" ni YOQING; sayt domeni Authorized domains'da bo'lsin.
  ESLATMA: bu brauzer tomonidagi "yumshoq" himoya; to'liq himoya uchun Cloud Function kerak.

## Hali QO'SHILMAGAN
- Guruh va kanallar (havola orqali kirish)
- Admin: akkauntga kirish (Cloud Function kerak)
- Parolni ko'rish: xavfsizlik sababli qilinmaydi
