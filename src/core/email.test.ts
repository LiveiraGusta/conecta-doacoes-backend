import { describe, expect, it, vi } from 'vitest';
import { createResendMailer, passwordResetEmail } from './email';

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

describe('passwordResetEmail', () => {
  it('escapa o link no HTML e mantém o link original no texto', () => {
    expect(message.html).toContain('token=x&amp;y=1');
    expect(message.text).toContain('https://app.test/r?token=x&y=1');
  });
});
