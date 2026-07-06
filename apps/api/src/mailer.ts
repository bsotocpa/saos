// Outbound mail behind a single interface (M4 deliverable).
//
// Vendor rule (CLAUDE.md): approved external vendors ONLY. The smtp transport
// points at the Amazon SES smart host in production (SES sees routing
// metadata, never stored documents) and will point at self-hosted Postal when
// it lands in Phase 2 — same interface, zero code change. The console
// transport is for development: it prints instead of sending.

import nodemailer from 'nodemailer';
import type { Config } from './config.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly transport: 'console' | 'smtp';
  send(msg: MailMessage): Promise<{ id: string }>;
}

function consoleMailer(from: string): Mailer {
  return {
    transport: 'console',
    async send(msg) {
      const id = `console-${Date.now()}`;
      // Dev-only output; never enabled in production (config refuses it).
      console.log(
        `\n─── MAIL (console transport, not sent) ───\nFrom: ${from}\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n───────────────────────────────────────────\n`
      );
      return { id };
    },
  };
}

function smtpMailer(config: Config): Mailer {
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? 587,
    secure: (config.SMTP_PORT ?? 587) === 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } : undefined,
  });
  return {
    transport: 'smtp',
    async send(msg) {
      const info = await transporter.sendMail({
        from: config.MAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html !== undefined ? { html: msg.html } : {}),
      });
      return { id: info.messageId };
    },
  };
}

export function createMailer(config: Config): Mailer {
  return config.MAIL_TRANSPORT === 'smtp' ? smtpMailer(config) : consoleMailer(config.MAIL_FROM);
}
