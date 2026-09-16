/** @module infra/auth — production adapters for the auth ports: Argon2id hasher, CSPRNG, credentials file. */

export {
  ARGON2_PARAMS,
  createBunPasswordHasher,
  parseArgon2Params,
} from './bun-password-hasher.ts';
export {
  ADMIN_DIR_MODE,
  CREDENTIALS_FILE_MODE,
  CREDENTIALS_FILE_NAME,
  type CredentialsFileOptions,
  type CredentialsFs,
  createCredentialsFile,
  nodeCredentialsFs,
} from './credentials-file.ts';
export { createWebCryptoRandom, rejectionLimit, sampleUnbiased } from './web-crypto-random.ts';
