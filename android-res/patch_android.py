#!/usr/bin/env python3
"""يُشغَّل في GitHub Actions بعد `npx cap add android` و`npx cap sync android`.

1) يضبط اسم التطبيق (من capacitor.config.json) في strings.xml.
2) يستبدل أيقونات التطبيق بأيقونة فالكون (android-res/res).
3) يسمح بـ HTTP نحو 127.0.0.1 وlocalhost فقط (جسر Termux) ويمنعه لغيرهما.
يفشل صراحةً (exit 1) إن لم ينجح أي تحقق، حتى لا يُبنى APK بإعداد ناقص.
"""
import glob, json, os, re, shutil, sys
import xml.etree.ElementTree as ET

ANDROID = 'android/app/src/main'
RES = f'{ANDROID}/res'
MANIFEST = f'{ANDROID}/AndroidManifest.xml'
NS = 'http://schemas.android.com/apk/res/android'

def fail(msg):
    print('ERROR:', msg); sys.exit(1)

cfg = json.load(open('capacitor.config.json', encoding='utf-8'))
app_name = cfg['appName']

# 1) اسم التطبيق
sp = f'{RES}/values/strings.xml'
if not os.path.isfile(sp): fail(f'{sp} not found (did cap add android run?)')
xml = open(sp, encoding='utf-8').read()
safe = app_name.replace('&', '&amp;').replace('<', '&lt;').replace("'", "\\'")
for key in ('app_name', 'title_activity_main'):
    pat = re.compile(r'(<string\s+name="%s"[^>]*>).*?(</string>)' % key, re.S)
    if pat.search(xml):
        xml = pat.sub(lambda m: m.group(1) + safe + m.group(2), xml)
    else:
        xml = xml.replace('</resources>', f'    <string name="{key}">{safe}</string>\n</resources>')
open(sp, 'w', encoding='utf-8').write(xml)
chk = open(sp, encoding='utf-8').read()
if chk.count(safe) < 2: fail('app name was not written to strings.xml')
print('app name ->', app_name)

# 2) الأيقونات: احذف أيقونات القالب ثم انسخ أيقونة فالكون
for f in glob.glob(f'{RES}/mipmap-*/ic_launcher*'):
    os.remove(f)
shutil.copytree('android-res/res', RES, dirs_exist_ok=True)
need = [f'{RES}/mipmap-{d}/{n}.png' for d in ('mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi')
        for n in ('ic_launcher','ic_launcher_round','ic_launcher_foreground')]
need += [f'{RES}/mipmap-anydpi-v26/ic_launcher.xml', f'{RES}/mipmap-anydpi-v26/ic_launcher_round.xml']
missing = [p for p in need if not os.path.isfile(p)]
if missing: fail('missing icon files: ' + ', '.join(missing))
print('icons ->', len(need), 'files')

# 3) السماح بـ HTTP للجسر المحلي فقط
ET.register_namespace('android', NS)
ET.register_namespace('tools', 'http://schemas.android.com/tools')
tree = ET.parse(MANIFEST)
app = tree.getroot().find('application')
if app is None: fail('<application> not found in AndroidManifest.xml')
app.set(f'{{{NS}}}networkSecurityConfig', '@xml/network_security_config')
app.set(f'{{{NS}}}usesCleartextTraffic', 'true')   # لـ API 23 فقط؛ من 24 فما فوق يسود networkSecurityConfig
tree.write(MANIFEST, encoding='utf-8', xml_declaration=True)
m = open(MANIFEST, encoding='utf-8').read()
if 'network_security_config' not in m: fail('manifest patch failed')
if not os.path.isfile(f'{RES}/xml/network_security_config.xml'): fail('network_security_config.xml missing')
print('manifest ->', 'networkSecurityConfig set (127.0.0.1/localhost only)')
print('OK')
