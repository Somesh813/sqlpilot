import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTransport, Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailTransport = 'smtp' | 'file' | 'none';

/**
 * The only place that sends email. Three transports, chosen by MAIL_TRANSPORT:
 *
 *   smtp  real delivery (MAIL_SMTP_URL). The only transport allowed to carry real users' mail.
 *   file  DEVELOPMENT ONLY: writes each message to MAIL_OUTBOX_DIR so a developer can open it.
 *         Refused at boot when NODE_ENV=production, so dev behaviour cannot leak into prod.
 *   none  nothing is sent (default in production until SMTP is configured). The reset flow
 *         still answers generically; only a warning without any secret is logged.
 *
 * A reset link is a credential. It is delivered to the user's mailbox (or the dev outbox) and
 * never appears in an HTTP response or in application logs.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private smtp: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  get transport(): MailTransport {
    return this.config.get<MailTransport>('mail.transport') ?? 'none';
  }

  async send(message: MailMessage): Promise<void> {
    const from = this.config.get<string>('mail.from') ?? 'SQLPilot <no-reply@localhost>';
    switch (this.transport) {
      case 'smtp': {
        this.smtp ??= createTransport(this.config.get<string>('mail.smtpUrl'));
        await this.smtp.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
        this.logger.log(`Email "${message.subject}" sent`);
        return;
      }
      case 'file': {
        const dir = resolve(this.config.get<string>('mail.outboxDir') ?? './data/outbox');
        mkdirSync(dir, { recursive: true });
        const safe = message.to.replace(/[^a-z0-9@._-]/gi, '_');
        const file = join(dir, `${Date.now()}-${safe}.txt`);
        writeFileSync(file, `From: ${from}\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`, {
          mode: 0o600,
        });
        this.logger.log(`Development email written to the outbox (${dir})`);
        return;
      }
      default:
        this.logger.warn(
          `Email "${message.subject}" was not sent: no mail transport is configured (set MAIL_TRANSPORT=smtp and MAIL_SMTP_URL).`,
        );
    }
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.send({
      to,
      subject: 'Reset your SQLPilot password',
      text: [
        'We received a request to reset your SQLPilot password.',
        '',
        `Open this link within 1 hour to choose a new password:\n${link}`,
        '',
        'If you did not ask for this, you can ignore this email; your password will not change.',
      ].join('\n'),
    });
  }
}
