import { MTProtoState } from 'telegram/network/MTProtoState';
import { sha256, toSignedLittleBuffer } from 'telegram/Helpers';
import { helpers } from 'telegram';
import { Buffer } from 'buffer';

const generateRandomBytes = helpers.generateRandomBytes;
const mod = helpers.mod;
const readBufferFromBigInt = helpers.readBufferFromBigInt;

async function igeEncryptWebCrypto(keyBytes: Uint8Array, ivBytes: Uint8Array, p: Uint8Array): Promise<Uint8Array> {
  const n = p.length;
  const y0 = ivBytes.subarray(0, 16);
  const x0 = ivBytes.subarray(16, 32);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as any,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );

  const X = new Uint8Array(n);
  X.set(p.subarray(0, 16));
  for (let j = 16; j < Math.min(32, n); j++) X[j] = p[j] ^ x0[j - 16];
  for (let j = 32; j < n; j++) X[j] = p[j] ^ p[j - 32];

  const cBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: y0 as any }, cryptoKey, X as any);
  const c = new Uint8Array(cBuf);

  const y = new Uint8Array(n);
  for (let j = 0; j < 16; j++) y[j] = c[j] ^ x0[j];
  for (let j = 16; j < n; j++) y[j] = c[j] ^ p[j - 16];

  return y;
}

export function applyWebCryptoPatch() {
  if (!crypto.subtle) {
    console.warn("WebCrypto not available, falling back to JS AES");
    return;
  }

  MTProtoState.prototype.encryptMessageData = async function(data: Buffer) {
    const self = this as any;
    if (!self.authKey) throw new Error("Auth key unset");
    await self.authKey.waitForKey();
    const authKey = self.authKey.getKey();
    if (!authKey) throw new Error("Auth key unset");
    if (!self.salt || !self.id || !authKey || !self.authKey.keyId) {
      throw new Error("Unset params");
    }

    const s = toSignedLittleBuffer(self.salt, 8);
    const i = toSignedLittleBuffer(self.id, 8);
    data = Buffer.concat([Buffer.concat([s, i]), data]);
    
    const padding = generateRandomBytes(mod(-(data.length + 12), 16) + 12);
    
    const msgKeyLarge = await sha256(Buffer.concat([authKey.slice(88, 88 + 32), data, padding]));
    const msgKey = msgKeyLarge.slice(8, 24);
    
    const { iv, key } = await self._calcKey(authKey, msgKey, true);
    const keyId = readBufferFromBigInt(self.authKey.keyId, 8);
    
    const payloadBuffer = Buffer.concat([data, padding]);
    const encryptedBytes = await igeEncryptWebCrypto(key, iv, payloadBuffer);
    const encryptedBuffer = Buffer.from(encryptedBytes);

    return Buffer.concat([
      keyId,
      msgKey,
      encryptedBuffer,
    ]);
  };

  console.log("✅ WebCrypto AES-IGE patch applied to MTProtoState!");
}
