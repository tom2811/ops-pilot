import nodemailer, { type Transporter } from "nodemailer";

export type MailerConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  replyTo?: string;
};

export type Mailer = {
  send(input: { to: string; subject: string; text: string; messageId?: string }): Promise<string | undefined>;
};

export function createMailer(config: MailerConfig | null): Mailer | null {
  if (!config) return null;
  const transport: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return {
    async send(input) {
      const info = await transport.sendMail({
        from: config.from,
        replyTo: config.replyTo,
        to: input.to,
        subject: input.subject,
        text: input.text,
        messageId: input.messageId,
      });
      return info.messageId;
    },
  };
}
