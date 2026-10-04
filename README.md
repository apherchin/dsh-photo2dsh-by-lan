# dsh-photo2dsh-by-lan

English | [中文](README.zh.md)

**Phone camera → LAN → a folder on this PC → directly readable by the DSH agent.**

One tap on the phone (iOS **Shortcuts**, Android **HTTP Shortcuts**) POSTs a photo to this PC.
The plugin receives it, writes it into **a folder you choose**, and raises a Windows toast.
**No cloud, no IM app, no mobile app, no `app.asar` patching.**

Its configuration UI lives in the DSH sidebar: **Plugins → this package's page**.

---

## Features

- **One tap on the phone** — iOS Shortcuts or Android HTTP Shortcuts POST a photo; nothing to install on the phone beyond that.
- **You choose the landing folder** — configured in the panel; files appear there immediately.
- **Agent-readable** — the folder is a normal directory, so DSH agents can read/analyse the photos right away.
- **Toast on arrival** — a Windows notification confirms each photo (with a click-through).
- **No cloud, no IM app, no mobile app, no `app.asar` patching.**
- **Optional token gate** — off by default; when off, the LAN is the trust boundary (see §6).
- **Offline test bench** — 50 assertions including every real-device failure mode we hit.
## 1. Install

```powershell
# preferred (migratable)
dsh plugin --profile desktop add dsh-photo2dsh-by-lan

# or from a local checkout
dsh plugin --profile desktop add file:D:\path\to\dsh-photo2dsh-by-lan
```

Then allow the port through the firewall **once** (the only step needing admin):

```powershell
netsh advfirewall firewall add rule name="DSH Photo2DSH" dir=in action=allow protocol=TCP localport=8787 profile=any
```

> ⚠️ **Do not omit `profile=any`.** A rule that only covers the `public` profile silently drops
> inbound packets when Windows classifies your network as *private* — the phone then reports
> "the server stopped responding", which is very hard to diagnose.
>
> Do not try to reuse an already-open port either: on the machine this was developed on, the only
> "any program, any profile" TCP port was held exclusively by `http.sys` (`EACCES`).

**Restart DSH** afterwards (the client half is assembled at boot).

---

## 2. Configure it in the plugin panel

Sidebar **Plugins** → this package → the config card:

| Field | Meaning |
|---|---|
| **Landing directory** | Where photos land. A `<date>\` subfolder is created automatically |
| **Port** | default 8787 — changing it needs a new firewall rule |
| **Max file size (MB)** | default 64 |
| **Toast on arrival** | default on |
| **Require token** | default on; **keep it on** |
| Upload URL / token | read-only, one-click copy |

Prefer a directory inside your current session workspace, so the file sandbox lets the agent read it.

---

## 3. Phone side

### iPad / iPhone (Shortcuts) — four steps, **step 3 is the one people miss**

1. Add **Select Photos** (or **Take Photo**).
2. Add **Convert Image** → **JPEG**, quality 80%.
   Without it the same 8 MP photo arrives as a ~12 MB lossless PNG instead of ~1.5 MB.
3. Add **Get Contents of URL**: paste the URL from the config card, expand **Show More**,
   set **Method = POST**, **Request Body = File**, then ⚠️ **point the File field at "Converted Image"**
   (leaving it on the original photo makes step 2 pointless). Finish with **Quick Look**.
4. Run it. The response is a short human-readable message, not JSON:

```text
✅ 照片已收到

格式：JPEG（1.63 MB）
文件：20261003232612-4d2b993e-image.jpg
时间：2026-10-03 23:26:12

已存入 PC 的收件箱文件夹
```

> On first LAN access iPadOS asks **"allow access to local network devices"** — you must allow it.
> That is an iOS gate, unrelated to the firewall.

To send only selected photos: **ⓘ → Show in Share Sheet → accept Images**, then share from Photos.

### Android

Same URL, same POST + file body. The wire protocol is identical.

---

## 4. What lands on disk

```text
<your directory>\
  └─ 2026-10-03\
       ├─ 20261003232612-4d2b993e-image.jpg     ← local timestamp - sha256[0:8] - sanitized name
       └─ 20261003232612-4d2b993e-image.json    ← sidecar: original name, note, bytes, sha256, format, source
```

- Same-second, same-name uploads **never overwrite each other** (`link()` + `-1`/`-2` suffixes).
- Format is decided by **magic bytes**, never by `Content-Type`: a real device sent `image/jpeg`
  in the header while the body was actually PNG.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "server stopped responding" (timeout) | inbound dropped by the firewall | add the rule, **with `profile=any`** |
| `❌ ... 地址里缺少正确的 token` | URL missing the `/u/<token>` part | re-copy the full URL from the config card |
| `❌ 这不是一张能识别的图片` | the body really is not an image | check the File field in your shortcut |
| response says "仍是 PNG" | Convert Image is not wired to the File field | see step 3 above |
| the package page does not appear | its loader row is disabled, or profile not restarted | the client half attaches to the row whose specifier is exactly the package name |
| port failed to start | port already in use | change the port and open the firewall for the new one |

Log: `$DSH_HOME\photo2dsh-by-lan.log` · Config: `$DSH_HOME\photo2dsh-by-lan.json`

---

## 6. Security

- Listens on the LAN only; never exposed to the internet.
- 128-bit token in the URL path, generated and persisted on first run (so the install is portable).
- A `401` **never echoes the correct token**.
- The setup page (`GET /`) is served **only to `127.0.0.1`**.
- Turning **Require token** off lets anyone on the LAN — including a web page you visit — write files here.

---

## 7. Limitations

- **Windows only** (`os: ["win32"]`; toasts use the Windows PowerShell 5.1 WinRT projection).
- The toast shows **Windows PowerShell** as the app name unless you register an AUMID.
- Not included: cloud relay, IM channels, an in-app photo browser, message injection, auto-cleanup.
- Uninstalling does not delete photos you already received.

---

## 8. Development

```powershell
node test/photo2dsh.test.mjs   # 50 offline assertions, including every real-device failure case
```
