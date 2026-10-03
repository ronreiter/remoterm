// Prints a fresh Ed25519 key pair for the Worker.
//   npm run gen-jwt-key
// Then: wrangler secret put JWT_PRIVATE_KEY   (paste the private JWK line)
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
console.log('# JWT_PRIVATE_KEY (Worker secret, keep private):');
console.log(JSON.stringify(privateKey.export({ format: 'jwk' })));
console.log('\n# Public JWK (informational; served automatically at /.well-known/jwks.json):');
console.log(JSON.stringify(publicKey.export({ format: 'jwk' })));
