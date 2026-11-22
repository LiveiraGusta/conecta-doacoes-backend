import { describe, expect, it, vi } from 'vitest';
import { createBrevoMailer, createResendMailer, parseAddress, passwordResetEmail } from './email';

const message = passwordResetEmail({ to: 'a@b.dev', name: 'Ana', link: 'https://app.test/r?token=x&y=1', minutes: 30 });

describe('createResendMailer', () => {
  it('faz POST na API do Resend com a chave e o remetente', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    await createResendMailer({ apiKey: 're_test', from: 'App <no-reply@app.dev>', fetch }).send(message);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ authorization: 'Bearer re_test' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: 'App <no-reply@app.dev>',
      to: ['a@b.dev'],
      subject: message.subject,
    });
  });

  it('resposta de erro vira exceção com o status', async () => {
    const fetch = vi.fn(async () => new Response('{"message":"domain not verified"}', { status: 403 }));
    await expect(createResendMailer({ apiKey: 're_x', from: 'a@b.dev', fetch }).send(message)).rejects.toThrow(
      /403.*domain not verified/,
    );
  });
});

describe('createBrevoMailer', () => {
  it('faz POST na API do Brevo com a chave, o remetente separado e os dois corpos', async () => {
    const fetch = vi.fn(async () => new Response('{"messageId":"1"}', { status: 201 }));
    await createBrevoMailer({ apiKey: 'xkeysib-test', from: 'Conecta Doações <eu@gmail.com>', fetch }).send(message);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers).toMatchObject({ 'api-key': 'xkeysib-test' });
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: 'Conecta Doações', email: 'eu@gmail.com' },
      to: [{ email: 'a@b.dev' }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
    });
  });

  it('resposta de erro vira exceção com o status', async () => {
    const fetch = vi.fn(async () => new Response('{"code":"unauthorized"}', { status: 401 }));
    await expect(createBrevoMailer({ apiKey: 'xkeysib-x', from: 'eu@gmail.com', fetch }).send(message)).rejects.toThrow(
      /401.*unauthorized/,
    );
  });

  it('recusa remetente inválido já na criação', () => {
    expect(() => createBrevoMailer({ apiKey: 'xkeysib-x', from: 'Conecta Doações' })).toThrow(/Remetente inválido/);
  });
});

describe('parseAddress', () => {
  it('separa nome e e-mail', () => {
    expect(parseAddress('Conecta Doações <eu@gmail.com>')).toEqual({ name: 'Conecta Doações', email: 'eu@gmail.com' });
    expect(parseAddress('"Conecta" <eu@gmail.com>')).toEqual({ name: 'Conecta', email: 'eu@gmail.com' });
  });

  it('aceita só o e-mail', () => {
    expect(parseAddress(' eu@gmail.com ')).toEqual({ email: 'eu@gmail.com' });
    expect(parseAddress('<eu@gmail.com>')).toEqual({ email: 'eu@gmail.com' });
  });

  it('recusa texto sem e-mail', () => {
    expect(parseAddress('Conecta Doações')).toBeUndefined();
    expect(parseAddress('a b@c.dev')).toBeUndefined();
  });
});

describe('passwordResetEmail', () => {
  it('escapa o link no HTML e mantém o link original no texto', () => {
    expect(message.html).toContain('token=x&amp;y=1');
    expect(message.text).toContain('https://app.test/r?token=x&y=1');
  });
});
