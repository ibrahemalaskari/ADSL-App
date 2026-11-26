# بناء APK «مبيعات فالكون» عبر GitHub Actions

الاسم: **مبيعات فالكون** (يظهر تحت أيقونة التطبيق). الأيقونة: شعار Falcon WiFi على خلفية `#050A1B` (ملفات `android-res/res`).

## طريقة العمل
- الـAPK غلاف WebView (Capacitor) يفتح `http://127.0.0.1:8787/adsl-app.html` (`server.url` في `capacitor.config.json`).
- **الجسر لا يعمل داخل الـAPK.** شغّل الجسر في Termux أولاً: `node bridge/server.js` ثم افتح التطبيق. بدونه تظهر صفحة خطأ اتصال.
- قاعدة SQLite وكل البيانات تبقى في Termux كما هي؛ الـAPK لا يخزّن بياناتك.
- HTTP مسموح نحو `127.0.0.1` و`localhost` فقط (`android-res/res/xml/network_security_config.xml`).

## البناء
1. ارفع المشروع إلى GitHub (يشمل `.github/workflows/android-apk.yml` و`android-res/` و`capacitor.config.json`).
2. GitHub -> Actions -> Build Android APK -> Run workflow (أو دفعة إلى main تلمس core/www/android-res/الإعدادات).
3. بعد نجاح البناء: افتح التشغيل -> Artifacts -> `Falcon-Sales-APK` -> نزّل `Falcon-Sales-debug.apk`.
4. ثبّته على الهاتف (يلزم السماح بالتثبيت من مصدر غير معروف). الـAPK موقّع بمفتاح debug.

## ما يقوم به `android-res/patch_android.py` بعد `cap add android`
يضبط اسم التطبيق، ويستبدل أيقونات القالب، ويضيف إعداد الشبكة المحلي، ويفشل صراحةً إن لم ينجح أي تحقق.

## حدود
- لم يُشغَّل البناء على GitHub بعد من جهة من أعدّ الملفات؛ تحقق منه عند أول تشغيل.
- لا يوجد تطبيق أندرويد مستقل: اعتماد التطبيق على جسر Termux قائم. النقل الأصلي لـTCP وقاعدة البيانات داخل أندرويد غير منفّذ.
- شاشة البدء المؤقتة قد تظهر بشعار Capacitor الافتراضي على بعض الأجهزة؛ لم تُعدَّل.
