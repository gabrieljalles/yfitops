// Gera o par de chaves de escrow (recuperação de conta por e-mail).
const ECDH = { name: "ECDH", namedCurve: "P-256" };
const kp = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
const b64 = (buf) => Buffer.from(buf).toString("base64url");
console.log(`ESCROW_PRIVATE_KEY=${b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey))}`);
console.log(`ESCROW_PUBLIC_KEY=${b64(await crypto.subtle.exportKey("spki", kp.publicKey))}`);
