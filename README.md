# CAC Goodworks Audio Translator

A free, open-source web app for **CAC Goodworks Assembly** that turns spoken audio or video into text, translates it into another language (Yoruba is the priority), and speaks the translation. It installs like an app, works offline once its AI models are downloaded, and keeps recordings on the device.

**Listen • Translate • Understand**

There is no server, no account, no build step and no paid service. It is a folder of static files.

---

## What it does

1. **Input**: upload audio or video, record with the microphone, drop a file, or type/paste text.
2. **Transcribe**: speech to text with Whisper, running on the device.
3. **Translate**: text to the target language. Bible references (for example `John 3:16`, `1 John 4:8-10`, `Psalm 23`) and church terms are protected so they are not translated.
4. **Speak**: the translation is played with a browser voice, or turned into a downloadable audio file with an on-device voice model.
5. **Save**: download the original, the transcript, the translation and the translated audio. A text-only history is kept on the device.

The app asks before it downloads any AI model and shows the size first.

---

## Important limits (read before publishing)

These are stated plainly in the app too. Nothing is faked.

- **YouTube links are never downloaded or extracted.** The app only recognises the link and asks the person to save the file legally and upload it.
- **A video is not re-dubbed.** The app makes a separate translated audio file. It does not replace the sound inside a video.
- **Igbo speech cannot be recognised.** Whisper does not cover Igbo. Igbo can be a *target* language, and Igbo text can be typed or pasted and translated.
- **Six languages have no downloadable voice:** Hausa, Igbo, Italian, Chinese, Japanese, Korean. They can only be spoken if the person's browser or device has a voice for them. Otherwise the app says the voice is unavailable and still gives the text.
- **Browser voices can be played but not saved.** Browsers do not allow recording their built-in voices. Only the downloadable voice models produce an audio file.
- **Automatic translation and recognition make mistakes**, especially for Yoruba, names and scripture. Whisper's small models are noticeably weaker for Yoruba than for English. The app lets the person **review and edit the transcript before translating** (Settings → "Let me review the transcript before it is translated") and edit the translation afterwards. Treat the output as a draft.
- **Large downloads.** The translation model that covers Yoruba (NLLB-200) is about 900 MB and needs a device with roughly 4 GB of memory. Compact models (about 100 MB) exist only for English to French, Spanish, Arabic and Hindi.
- **The first use needs internet** to download models. After that, everything already downloaded works offline.
- **Recording needs HTTPS** (GitHub Pages provides it). It will not work from a plain `http://` address other than `localhost`.

---

## Language coverage

| Language | Recognise speech | Translate to/from | Downloadable voice | Compact model (from English) |
|---|:-:|:-:|:-:|:-:|
| English | yes | yes | yes | n/a |
| **Yoruba** | yes | yes | yes | no |
| Hausa | yes | yes | no | no |
| Igbo | **no** | yes | no | no |
| French | yes | yes | yes | yes |
| Spanish | yes | yes | yes | yes |
| Portuguese | yes | yes | yes | no |
| Arabic | yes | yes | yes | yes |
| German | yes | yes | yes | no |
| Italian | yes | yes | no | no |
| Chinese | yes | yes | no | no |
| Japanese | yes | yes | no | no |
| Korean | yes | yes | no | no |
| Russian | yes | yes | yes | no |
| Hindi | yes | yes | yes | yes |

"Translate" uses NLLB-200 for every pair. A compact Opus-MT model is used instead when one exists for the pair and NLLB has not been downloaded.

---

## How translation is chosen ("Automatic")

1. The browser's own Translator (Chrome), if it reports the language pair as ready. It covers only a limited set of languages, so it is often not an option.
2. A compact Opus-MT model for the pair, or NLLB-200 if that is already on the device.
3. NLLB-200 (downloaded once).
4. The optional online service (MyMemory), **only if the person turned it on** in Settings. Only text is sent, never audio. It can be removed completely by setting `enableOnlineTranslation: false` in `settings.js`.

If none of these can handle the pair, the app says so and suggests what to do.

---

## Files

Everything is in **one flat folder**. There are no sub-folders anywhere.

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `theme-init.js` | App shell, design system, no-flash theme setup |
| `app.js` | Start-up, router, install prompt, offline and update handling |
| `view-translate.js`, `view-history.js`, `view-models.js`, `view-settings.js`, `common.js` | The screens and shared helpers |
| `pipeline.js`, `speech.js`, `translator.js`, `tts.js`, `audio.js`, `youtube.js` | The six-stage pipeline and its parts |
| `ml-client.js`, `ml-worker.js`, `engine.js`, `models.js` | The AI worker (a Web Worker keeps the page responsive) and the model registry |
| `languages.js`, `settings.js`, `storage.js`, `errors.js`, `util.js`, `ui.js`, `player.js` | Language table, settings, IndexedDB, errors, helpers, UI toolkit, player |
| `manifest.json`, `service-worker.js`, `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | Installable app and offline support |

---

## Before you publish

1. **Add contact details** in `settings.js` (`APP_CONFIG.contact`: email, phone, website, address). Empty fields are hidden, so nothing is invented.
2. **Set the version** in two places, and keep them equal: `APP_CONFIG.version` in `settings.js` and `VERSION` in `service-worker.js`. Changing the version is what tells installed copies to update.
3. Check the licences below are acceptable for how you will use the app.

---

## Deploy on GitHub Pages

1. Create a new public repository on GitHub.
2. Upload **every file in this folder** to the repository root (drag and drop works on github.com). Do not put them inside another folder.
3. Open **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick the `main` branch and the `/ (root)` folder, then **Save**.
4. After a minute the app is live at `https://YOUR-NAME.github.io/YOUR-REPO/`. All paths in the app are relative, so it works in a sub-path like this.

Any other static host (Netlify, Cloudflare Pages, a school or church web server) also works. Serve it over **HTTPS**.

### Publishing an update

Upload the changed files, raise the version in both places (see above), and commit. People who have the app installed will see an **"New version available"** bar with an **Update** button. Pressing it swaps in the new files.

### Run it on your own computer

```
cd cac-goodworks-audio-translator
python3 -m http.server 8000
```

Open `http://localhost:8000`. (`localhost` is treated as secure, so recording and offline mode work.)

---

## Install on a device

- **Android (Chrome):** press **Install app** in the app, or use the browser menu, then **Install app / Add to Home screen**.
- **iPhone / iPad (Safari):** tap **Share**, then **Add to Home Screen**. (Only Safari can do this on iOS.)
- **Windows / Mac / Linux (Chrome or Edge):** use the install icon at the right of the address bar, or press **Install app** in the sidebar.
- **Firefox on desktop** does not install web apps. It still runs the app in a normal tab.

---

## What works offline

| Works offline | Needs internet |
|---|---|
| Opening the app and every screen | The **first** download of each AI model |
| Recording, playing, editing, history, settings | The optional online translation service (if turned on) |
| Transcribing, translating and speaking with models already downloaded | Browser voices marked "needs internet" |
| Downloading transcripts, translations and audio | |

The app's own files are cached by the service worker. The AI **model files are not** cached by the service worker. They live in the browser's own storage (`transformers-cache`), and the person can see and remove them under **AI models**. The small pinned AI engine code that comes from jsDelivr is cached separately so the engine can start offline.

---

## Adding more languages

Open `languages.js` and add one entry to `LANGUAGES` (or call `addLanguage({...})`):

```js
{ code: 'sw', name: 'Swahili', native: 'Kiswahili',
  nllb: 'swh_Latn',        // NLLB-200 code, or null if not covered
  whisper: 'swahili',      // Whisper language name, or null if not covered
  mms: null,               // Hugging Face id of a working local voice model, or null
  mymemory: 'sw',          // code for the optional online service
  dir: 'ltr' }             // 'rtl' for Arabic-script languages
```

Rules that keep the app honest:

- Leave `nllb` as `null` if NLLB does not cover the language, and the app will say translation is unavailable.
- Only fill `mms` with a voice model **you have tested** in the browser. If it is `null`, the app tells the person the voice is unavailable. A wrong id would produce a broken download.
- The menus, the coverage checks, file names and the voice screen all update from this one table.

## Improving Yoruba voice quality later

Today Yoruba speech comes from the Meta MMS-TTS Yoruba model, or from a Yoruba voice if the person's device has one installed. To improve it:

1. Test a better open-source Yoruba text-to-speech model that runs in the browser (ONNX, usable with Transformers.js).
2. Put its Hugging Face id in the `mms` field of the Yoruba entry in `languages.js`.
3. Check the voice screen (AI models → Voices) shows the new size and licence, and listen to a long paragraph and to Bible references before shipping.

The voice engine itself lives in `tts.js` (`generateLocalAudio`) and the model runner in `ml-worker.js`.

---

## Privacy

- Audio is processed on the device. It is not uploaded to any server.
- Model files come from Hugging Face and the engine code from jsDelivr. These downloads never contain the person's audio or text.
- The online translation service is **off by default**. When on, only text is sent.
- History (text only by default), settings and models are stored in the browser. **Settings → Clear all data** removes them.
- A strict Content-Security-Policy in `index.html` blocks inline scripts. All text is inserted with `textContent`, never `innerHTML`, and uploaded file names are sanitised before they are used for downloads. No keys or secrets exist anywhere in the app.

## Licences of the parts

| Part | Licence |
|---|---|
| This app's own code | Choose one before publishing (MIT or Apache-2.0 are common) |
| Transformers.js | Apache-2.0 |
| ONNX Runtime Web | MIT |
| Whisper speech models (OpenAI) | MIT |
| Opus-MT translation models (Helsinki-NLP) | CC-BY-4.0 |
| **NLLB-200 translation model (Meta)** | **CC-BY-NC-4.0, non-commercial** |
| **MMS-TTS voice models (Meta)** | **CC-BY-NC-4.0, non-commercial** |

The NLLB and MMS-TTS licences forbid commercial use. That suits church and community work. Do not sell access to the app or run it as a paid service while it depends on them.

---

## Manual test checklist

Before each release, on a real phone and a desktop:

- [ ] Home opens, language menus work, Swap works.
- [ ] Upload MP3, M4A, WAV, WhatsApp voice note (`.opus`/`.ogg`), MP4 and WEBM. A `.txt` file is refused politely.
- [ ] Record, pause, resume, stop, play back, use the recording.
- [ ] The download-size dialog appears before any model downloads. Cancel downloads nothing.
- [ ] Transcript appears, can be edited and saved. Review-before-translate works.
- [ ] Translation keeps `John 3:16` and the protected church terms exactly.
- [ ] Translated audio plays, seeks, changes speed, mutes. Download gives a `.wav` for languages with a voice model, and a clear message for others.
- [ ] Airplane mode: the app opens and every screen works; translation works with models already downloaded and explains itself when they are not.
- [ ] History opens, deletes, clears. Clear all data works.
- [ ] Dark theme, high contrast, larger text. Screen reader and keyboard-only use.
- [ ] Install the app; publish a version bump and confirm the Update bar appears.
