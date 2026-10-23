# dsh-plugin-zt-remote

DeepSeek Harness के लिए केवल-ZeroTier आधारित एक remote surface। यह एक HTTP listener को
उस मशीन के ZeroTier interface से बाँधता है जिस पर Harness Host चल रहा है, और एक फ़ोन
पेज परोसता है जो ये काम कर सकता है:

- workspaces की सूची दिखाना और किसी host path से एक नया workspace बनाना;
- sessions की सूची दिखाना, किसी workspace में session शुरू करना, और मौजूदा conversation को फिर से खोलना;
- ऐसा prompt भेजना जो मौजूदा conversation को आगे बढ़ाता है, या उसके चल रहे turn को cancel करना;
- streaming output का अनुसरण करना और tool activity देखना;
- किसी device को one-time code के ज़रिए pair करना और बाद में उसे revoke करना।

Configuration plane जान-बूझकर शामिल नहीं है। कोई settings page नहीं है, कोई credential route
नहीं है, कोई model-provider route नहीं है, और कोई directory picker नहीं है: plugin केवल उन्हीं
Remote methods तक पहुँचता है जिनकी ऊपर बताए गए actions को ज़रूरत है, इसलिए paired device,
Harness को फिर से configure नहीं कर सकता, भले ही वह tasks चला सकता हो।

## Why the interface is narrow

Harness Host पहले से ही अपने `/api` route को loopback authorities तक सीमित रखता है और
launch token या signed session cookie की माँग करता है। यह plugin उस route को छूता नहीं,
webserver bind नहीं बदलता, और Harness session cookie नहीं पढ़ता। यह अपना अलग listener खोलता है,
उसे अपने device tokens से authenticate करता है, और operator के रूप में in-process Remote methods
को call करता है।

## Sidebar panel

पैनल साइडबार में रहता है। DSH ब्राउज़र बंडल स्टार्टअप पर बनाता है, इसलिए क्लाइंट बदलाव के लिए **कोल्ड रीस्टार्ट** ज़रूरी है; पैनल वर्कस्पेस सूची, टाइप किए पथ से नया वर्कस्पेस, और डिवाइस सूची/रद्दीकरण दिखाता है। फ़ोन पैनल इस प्लगइन के listener से लोड करता है, इसलिए रूट same-origin हैं; Host पेज उन्हें नहीं देता और पैनल यह इनलाइन बताता है।

## Configuration

सब कुछ profile की `cordis.patch.yml` से configure किया जा सकता है:

```yaml
- id: zt-remote
  config:
    listenPort: 8790
    interfaceHint: zerotier
    pairCodeTtlSeconds: 600
    deviceTokenDays: 30
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | plugin लोड रहने के दौरान serve करें। |
| `listenAddress` | `''` | स्पष्ट IPv4 bind। खाली छोड़ने पर स्वतः पता लगता है। |
| `listenPort` | `8790` | TCP port। |
| `interfaceHint` | `zerotier` | स्वतः पहचान के लिए interface नाम का case-insensitive substring। |
| `pairCodeTtlSeconds` | `600` | एक pairing code का जीवनकाल। |
| `deviceTokenDays` | `30` | जारी किए गए device token का जीवनकाल। |
| `bodyLimitBytes` | `1048576` | अधिकतम request body। |
| `historyPageLimit` | `60` | प्रति history page messages। |
| `stateDir` | `''` | paired-device directory; खाली होने पर `$DSH_HOME/plugin-data/dsh-plugin-zt-remote` का उपयोग होता है। |

Auto-detection तब शुरू होने से इनकार कर देता है जब कोई interface मेल न खाए, या जब कई मेल खाएँ:
जो surface shell commands चला सकता है, उसे detection विफल होने की वजह से कभी भी हर interface
तक नहीं फैलना चाहिए।

## Access

डिफ़ॉल्ट `autoAccess` के साथ फ़ोन सीधे `http://<ZeroTier पता>:8790/` खोलता है और आधिकारिक UI में पहुँचता है — कोई पेयरिंग कोड या URL token नहीं। जो भी डिवाइस पोर्ट तक पहुँचता है उसे स्वीकार कर डिवाइस सूची में दर्ज किया जाता है, इसलिए **ZeroTier नेटवर्क ही एकमात्र सीमा है**; `autoAccess: false` पेयरिंग गेट लौटाता है।

## Pairing (with `autoAccess: false`)

Startup के बाद plugin pairing URL को log करता है और उसे `<stateDir>/pairing.txt` में लिखता है।
इसे फ़ोन पर एक बार खोलें; पेज code और secret को `/pair` पर post करता है और लौटाए गए token को
`localStorage` में रखता है। हर pairing code single-use है और समाप्त हो जाता है। Device tokens
केवल SHA-256 digests के रूप में संग्रहित होते हैं, और `/operator/revoke` (operator key आवश्यक; loopback बिना key)
एक device या उन सभी को revoke करता है।

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | फ़ोन पेज। |
| GET | `/hello` | पहचान और capabilities। |
| POST | `/pair` | code और secret के बदले device token लें। |
| GET | `/workspaces` | Workspace roster। |
| POST | `/workspaces` | `{ path }` से एक workspace बनाएँ। |
| GET | `/sessions` | Session roster। |
| POST | `/sessions` | `{ workspaceId?, cwd?, agentPreset? }` से एक session बनाएँ। |
| GET | `/sessions/:id/messages` | Message-aligned history page। |
| POST | `/sessions/:id/prompt` | `{ text, mode? }` के साथ conversation को आगे बढ़ाएँ। |
| POST | `/sessions/:id/cancel` | चल रहे turn को cancel करें। |
| GET | `/sessions/:id/events` | Server-sent events: history snapshot के साथ frames। |
| GET | `/operator/code`, `/operator/devices` | operator key आवश्यक (loopback बिना key): pairing और roster। |
| POST | `/operator/revoke` | operator key आवश्यक (loopback बिना key): revocation। |

## Approvals

Host `approval/request` waterfall से भेजता है; प्लगइन फ़ोन उत्तर तक निर्णय 60 सेकंड तक खुला रखता है। `POST /answers` में `allow: true` → `allowed-once`, `false` → `rejected`; समय समाप्त, रद्द डिवाइस या प्लगइन अनलोड पर निर्णय डेस्कटॉप को लौट जाता है।

## Security notes

ZeroTier interface से bind करने का अर्थ है कि उस virtual network का हर device port खोल सकता है;
ऐसे agent के सामने device token ही एकमात्र बाड़ है जो shell commands चला सकता है और files edit
कर सकता है। ZeroTier network membership सीमित रखें, tokens को revoke करके और फिर से pair करके
rotate करें, और `pairing.txt` को एक credential मानें।

## Verification status

`lib/tests/all.test.js` में 78 यूनिट टेस्ट हैं और चार acceptance स्क्रिप्ट चालू Host पर चलकर पास होती हैं। `/hello` में `build` और `hostBase` पुराने संस्करण और गलत पोर्ट में भेद करते हैं; क्लाइंट बदलाव के लिए कोल्ड रीस्टार्ट आवश्यक है।

## License

MIT
