// Live meeting-intelligence verification (M17 prove-it; rerun on staging at
// M21/M23). Exercises the REAL adapters against the running containers:
//   whisper transcription + ollama summarization on a sample recording.
// The pipeline orchestration around them is covered by the test suite.
//
// Usage: node scripts/live-intel-check.ts <path-to-audio.wav>
// Requires: docker compose --profile intel up -d
//           docker compose exec ollama ollama pull llama3.2:3b

import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { makeSummarizer, makeTranscriber } from '../src/modules/meetings/adapters.ts';

const audioPath = process.argv[2];
if (!audioPath) {
  console.error('Usage: node scripts/live-intel-check.ts <path-to-audio.wav>');
  process.exit(1);
}

const config = loadConfig({ TRANSCRIBER_MODE: 'whisper', SUMMARIZER_MODE: 'ollama' });
const transcriber = makeTranscriber(config);
const summarizer = makeSummarizer(config);
const audio = readFileSync(audioPath);

console.log(`audio: ${audioPath} (${(audio.length / 1024).toFixed(0)} KB)`);
console.log(`transcriber: ${transcriber.mode} @ ${config.WHISPER_URL}`);
console.log(`summarizer:  ${summarizer.mode} @ ${config.OLLAMA_URL} (${config.OLLAMA_MODEL})`);

const t0 = Date.now();
const transcript = await transcriber.transcribe(audio, 'sample-session.wav', 'audio/wav');
const t1 = Date.now();
console.log(`\n─ TRANSCRIPT (${((t1 - t0) / 1000).toFixed(1)}s) ─\n${transcript.text}\n`);

const summary = await summarizer.summarize(transcript.text, {
  contactName: 'Maria (synthetic)',
  meetingType: 'in_person',
});
const t2 = Date.now();
console.log(`─ SUMMARY (${((t2 - t1) / 1000).toFixed(1)}s) ─`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\ntotal: ${((t2 - t0) / 1000).toFixed(1)}s — now run: docker stats --no-stream`);
