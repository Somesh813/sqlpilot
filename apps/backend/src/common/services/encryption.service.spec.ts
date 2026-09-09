import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

const KEY = '0'.repeat(64);

function makeService(key = KEY): EncryptionService {
  return new EncryptionService({ get: () => key } as unknown as ConfigService);
}

describe('EncryptionService', () => {
  it('round-trips a secret', () => {
    const svc = makeService();
    const cipher = svc.encrypt('super-secret-password');
    expect(cipher).not.toContain('super-secret-password');
    expect(svc.decrypt(cipher)).toBe('super-secret-password');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const svc = makeService();
    expect(svc.encrypt('x')).not.toBe(svc.encrypt('x'));
  });

  it('round-trips JSON', () => {
    const svc = makeService();
    const payload = { username: 'u', password: 'p', port: 5432 };
    expect(svc.decryptJson(svc.encryptJson(payload))).toEqual(payload);
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const svc = makeService();
    const cipher = Buffer.from(svc.encrypt('data'), 'base64');
    cipher[cipher.length - 1] ^= 0xff;
    expect(() => svc.decrypt(cipher.toString('base64'))).toThrow();
  });

  it('rejects an invalid key', () => {
    expect(() => makeService('not-hex')).toThrow();
  });
});
