// Meeting-intelligence adapters (MP Meeting Intelligence + stack rules):
//   Transcriber — stub | whisper (self-hosted faster-whisper webservice)
//   Summarizer  — stub | ollama (self-hosted local LLM) | api (Claude
//                 fallback, CLEANED TEXT ONLY — never audio, per MP)
// Stubs are deterministic for tests; live adapters are thin HTTP clients.

import { z } from 'zod';
import type { Config } from '../../config.ts';
import { AppError } from '../../types.ts';

export interface Transcriber {
  readonly mode: 'stub' | 'whisper';
  transcribe(audio: Buffer, filename: string, mimeType: string): Promise<{ text: string; language: 'en' | 'es' | null }>;
}

export interface SummaryResult {
  summary: string;
  decisions: string[];
  actionItems: Array<{ owner: string | null; due: string | null; text: string }>;
  taxNeed: boolean;
  taxNeedDescription: string | null;
  referralHiloToSoto: boolean;
  referralSotoToHilo: boolean;
}

export interface Summarizer {
  readonly mode: 'stub' | 'ollama' | 'api';
  summarize(transcript: string, context: { contactName: string | null; meetingType: string }): Promise<SummaryResult>;
}

// ── Transcribers ─────────────────────────────────────────────────────────────

function stubTranscriber(): Transcriber {
  return {
    mode: 'stub',
    async transcribe(_audio, filename) {
      // Deterministic synthetic transcript; filename hints steer test paths.
      const wantsSoto = filename.includes('sotoreferral');
      return {
        text:
          'Synthetic session transcript. We reviewed the food truck operations and pricing. ' +
          'The client asked about bookkeeping cleanup and mentioned they have not filed taxes for last year. ' +
          (wantsSoto
            ? 'This Soto client would benefit from Hilo advisory sessions on operations. '
            : 'This entrepreneur is ready for professional tax help. ') +
          'Action item: send the licensing checklist by Friday. Action item: schedule a follow-up session.',
        language: 'en',
      };
    },
  };
}

/*
 * Whisper on CPU is slow — minutes for a long recording — so the ceiling is generous.
 * But it is a CEILING, which it did not have (finding #18): an un-timed fetch to a
 * hung Whisper leaves the meeting at `transcribing` forever, and because the promise
 * never settles the catch block never runs, so nothing is marked failed and nobody is
 * told. A timeout converts a silent permanent stall into a loud failure with an alert.
 */
const WHISPER_TIMEOUT_MS = 20 * 60 * 1000;

function whisperTranscriber(config: Config): Transcriber {
  const base = config.WHISPER_URL.replace(/\/$/, '');
  return {
    mode: 'whisper',
    async transcribe(audio, filename, mimeType) {
      const form = new FormData();
      form.append('audio_file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
      let res: Response;
      try {
        res = await fetch(`${base}/asr?output=json&task=transcribe`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new AppError(
          502,
          'whisper_error',
          timedOut
            ? `Whisper did not respond within ${WHISPER_TIMEOUT_MS / 60000} minutes.`
            : 'Whisper could not be reached.'
        );
      }
      if (!res.ok) throw new AppError(502, 'whisper_error', `Whisper transcription failed (${res.status}).`);
      const body = (await res.json()) as { text?: string; language?: string };
      return {
        text: (body.text ?? '').trim(),
        language: body.language === 'es' ? 'es' : body.language === 'en' ? 'en' : null,
      };
    },
  };
}

// ── Summarizers ──────────────────────────────────────────────────────────────

const SummarySchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  action_items: z.array(z.object({ owner: z.string().nullish(), due: z.string().nullish(), text: z.string() })).default([]),
  tax_need: z.boolean().default(false),
  tax_need_description: z.string().nullish(),
  referral_hilo_to_soto: z.boolean().default(false),
  referral_soto_to_hilo: z.boolean().default(false),
});

function toResult(parsed: z.infer<typeof SummarySchema>): SummaryResult {
  return {
    summary: parsed.summary,
    decisions: parsed.decisions,
    actionItems: parsed.action_items.map((a) => ({ owner: a.owner ?? null, due: a.due ?? null, text: a.text })),
    taxNeed: parsed.tax_need,
    taxNeedDescription: parsed.tax_need_description ?? null,
    referralHiloToSoto: parsed.referral_hilo_to_soto,
    referralSotoToHilo: parsed.referral_soto_to_hilo,
  };
}

function stubSummarizer(): Summarizer {
  return {
    mode: 'stub',
    async summarize(transcript) {
      const lower = transcript.toLowerCase();
      const actionItems = [...transcript.matchAll(/action item: ([^.]+)\./gi)].map((m) => ({
        owner: null,
        due: null,
        text: m[1]!.trim(),
      }));
      return {
        summary: 'Synthetic summary: session covered operations, pricing, and financial readiness.',
        decisions: ['Proceed with licensing checklist'],
        actionItems,
        taxNeed: lower.includes('tax'),
        taxNeedDescription: lower.includes('tax') ? 'Mentioned unfiled prior-year taxes.' : null,
        referralHiloToSoto: lower.includes('ready for professional tax help'),
        referralSotoToHilo: lower.includes('benefit from hilo'),
      };
    },
  };
}

const SUMMARY_PROMPT = (transcript: string, contactName: string | null, meetingType: string) => `You are the meeting-intelligence assistant for a CPA firm (Soto Accounting) and its partner nonprofit (Hilo NFP, entrepreneur advisory).
Analyze this ${meetingType} session transcript${contactName ? ` with ${contactName}` : ''} and answer with ONLY a JSON object, no prose, matching exactly:
{"summary": "3-5 sentence summary", "decisions": ["..."], "action_items": [{"owner": null, "due": null, "text": "..."}], "tax_need": false, "tax_need_description": null, "referral_hilo_to_soto": false, "referral_soto_to_hilo": false}
Rules: tax_need=true when tax/accounting work is needed; referral_hilo_to_soto=true when a Hilo entrepreneur should be introduced to the CPA firm; referral_soto_to_hilo=true when a CPA client would benefit from the nonprofit's advisory.
TRANSCRIPT:
${transcript}`;

function ollamaSummarizer(config: Config): Summarizer {
  const base = config.OLLAMA_URL.replace(/\/$/, '');
  return {
    mode: 'ollama',
    async summarize(transcript, context) {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.OLLAMA_MODEL,
          prompt: SUMMARY_PROMPT(transcript.slice(0, 24000), context.contactName, context.meetingType),
          format: 'json',
          stream: false,
          options: { temperature: 0.2 },
        }),
      });
      if (!res.ok) throw new AppError(502, 'ollama_error', `Ollama summarization failed (${res.status}).`);
      const body = (await res.json()) as { response?: string };
      const parsed = SummarySchema.safeParse(JSON.parse(body.response ?? '{}'));
      if (!parsed.success) throw new AppError(502, 'ollama_parse_error', 'Local LLM returned unusable JSON.');
      return toResult(parsed.data);
    },
  };
}

/** Claude API fallback — CLEANED TEXT ONLY crosses the boundary (MP rule). */
function apiSummarizer(config: Config): Summarizer {
  return {
    mode: 'api',
    async summarize(transcript, context) {
      if (!config.ANTHROPIC_API_KEY) {
        throw new AppError(503, 'summarizer_not_configured', 'API fallback needs ANTHROPIC_API_KEY.');
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1200,
          messages: [{ role: 'user', content: SUMMARY_PROMPT(transcript.slice(0, 24000), context.contactName, context.meetingType) }],
        }),
      });
      if (!res.ok) throw new AppError(502, 'api_summarizer_error', `API fallback failed (${res.status}).`);
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = body.content?.[0]?.text ?? '{}';
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const parsed = SummarySchema.safeParse(JSON.parse(json));
      if (!parsed.success) throw new AppError(502, 'api_parse_error', 'API fallback returned unusable JSON.');
      return toResult(parsed.data);
    },
  };
}

export function makeTranscriber(config: Config): Transcriber {
  return config.TRANSCRIBER_MODE === 'whisper' ? whisperTranscriber(config) : stubTranscriber();
}

export function makeSummarizer(config: Config): Summarizer {
  if (config.SUMMARIZER_MODE === 'ollama') return ollamaSummarizer(config);
  if (config.SUMMARIZER_MODE === 'api') return apiSummarizer(config);
  return stubSummarizer();
}
