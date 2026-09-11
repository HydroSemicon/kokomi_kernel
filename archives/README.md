# Archive Index

Files under this directory are retained for design history, reproducibility, or one-off maintenance. They are not loaded by the active Kernel runtime unless explicitly stated.

| Directory | Contents |
| --- | --- |
| `docs/` | Superseded architecture notes, phase specifications, protocol examples, and the original project roadmap |
| `experiments/` | Standalone ASR, TTS, and Bluesky experiments replaced by the integrated runtime |
| `legacy-browser/` | Earlier Puppeteer, Tampermonkey, and browser-automation prototypes |
| `logs/` | Historical empty process-log placeholders previously tracked at repository root |
| `notes/` | Local setup notes that do not define the Kernel specification |
| `prompts/` | Past implementation prompts used during protocol migration |
| `tools/` | Non-runtime maintenance utilities, including filler-clip generation |

The active system specification is maintained in the repository root `README.md`. Runtime code lives in `alice.js`, `src/`, and `dashboard/`; executable policy remains in `control_prompt.md` and `config.json`.
