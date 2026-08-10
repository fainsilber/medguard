/**
 * A throwaway RSA keypair and service account, generated solely for tests.
 *
 * Lives in its own file because two places need it: `fcm.test.ts` verifies the assertion it
 * signs, and `vitest.config.ts` binds it as `FCM_SERVICE_ACCOUNT` so the push path is exercised
 * in CI, where no `.dev.vars` exists. It authenticates nothing — outbound `fetch` is stubbed in
 * every test that uses it, so no request ever leaves the runtime.
 */

export const TEST_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDkAC7+phfNN9kw\n' +
  'Btmf8qVBrj+H3ZvKGfkdx0xt7TRdriVXD+nfB2m7ZDu6mlGe/9ihlGgASX0ye2dv\n' +
  'kXt8LCIVRfPHMo2yTBBb2r9O/BGQkN6obIz/C+dbe+zvwPJo+zhUkOZi8lPysV1a\n' +
  'DMESF7ehzqtypLiwSZTXpZE0xBNzaK36YPze+/qId0WxH0eL7N9Qe7jihE5ON10s\n' +
  'BXmw8uj6E/GXA3BIMiswImGVBWQ8F9PWORKVzN3K8KTwqGIDj3hpNdD6cgkcYDzt\n' +
  '7VCcv7Fsw+kUNHrtXKjq+SZyGarcZXx//J6SHDW2XjAoQ7P+NTcZAZIgOY4l+2Le\n' +
  'RlDSwsudAgMBAAECggEAKYrTBTj0G0MywmptGpSWgboi/zlkmlVTK5bVmS3gHbWO\n' +
  'Pie7IBT0sd0YeO6HMqZBLWeh73N0aU9M0Go8iqpr515ghYnzgWoUjPf1ZYnOFX4f\n' +
  '46Yrpojfta6FxEVupawoXlgschjfLNgePzsVrps9rTC/0lqrAAvYH9ad93RGav9u\n' +
  'rJHKl/5FumdbCzP/VodqebOVQs4DgZDdpVqI5e09NueB1yjKeFFe3D6twoZLMQN1\n' +
  'enbRxS3gFK5rIjU3iKNBXYUaOlBV7ffaJClq/pe7zfECHUDsKNa0RhZqHnGTWkcb\n' +
  'ZKPEl+5JPx2Sjd2RLMCADNi4LtJu7ctI5p7dJvY3QQKBgQD2tWY5vhPhJzZNX4Vq\n' +
  'Gxgu/F9XIUCN1Pq2dR/pn8puXFTgEi3mkDbYg09rgAvpPc5T7lLiSAXWgMIXmE2D\n' +
  'XOyq70kazxYhp9m+s001xDDNYXGqeVhs7qUonsOjbq997uIVcU7ZX28E8bSwY6ZT\n' +
  '6Mij0dNM/8n2hsPAXnI6pYHErQKBgQDslmpTb/RCyPj9lKkYqinM7OHP4J+nL1Rh\n' +
  'Hp0NMe9c9p2sHuwZdo3aWQIrVNbiaD6vGBvHz7mqpBtN2gJKV0C4aCRUP+2YucF3\n' +
  '/XLdo1pg+Yf4BeGIvKVBH0e1djRN51m7kwRFR4n7+jhPQ6L9zTm0lh+FAKaGDwmG\n' +
  'zXEWX5sQsQKBgA/f4kEK6wqM1GCsKdCHB8pWMOhRWm8F6k/9P11wC72IMWntoYh5\n' +
  'dR3/bQfUyG9sq68Y4bpvufhwdozAHxS50Py6wvB3rMvjmg48SVaRVjaQ85htkHQJ\n' +
  '8xSnCp2kjKREz8VjchhonKMrzl2fO9+gVfC8mqUUvHEhgM0LBryhU7VNAoGAVPx7\n' +
  'WVmgDtWOy9i5HYkS1vBI9ZmlADN6RiDvHaxQZb6ZSRkaitMRhdvvcY1aW55C1jb8\n' +
  '07wE4A1vWXn01KufLh8K3dDREsm3e9jpiECD2M4KT8gdCjdpzYjlA4RgqZNvonff\n' +
  'Utut73wk+iQ7ypwMHJjI3cgsCYAhVfE6rGTPmSECgYEA9k8yScl1ZlvPLkPUSbrJ\n' +
  'DpLgILGdSz2lAVsWVM2sAUgqYIik+1k+NPgICbA773kBP2HWDnBAYxA47WwOm0Dl\n' +
  '8NM2731OSDoZgQ/QqPqNcFvWvxZdGmrPjQL39C/NoknQYpC+fsCs1DxXbCWyrt/e\n' +
  '8gOudz4a2RKbI07N3QAPMrg=\n' +
  '-----END PRIVATE KEY-----\n';

export const TEST_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5AAu/qYXzTfZMAbZn/Kl\n' +
  'Qa4/h92byhn5HcdMbe00Xa4lVw/p3wdpu2Q7uppRnv/YoZRoAEl9Mntnb5F7fCwi\n' +
  'FUXzxzKNskwQW9q/TvwRkJDeqGyM/wvnW3vs78DyaPs4VJDmYvJT8rFdWgzBEhe3\n' +
  'oc6rcqS4sEmU16WRNMQTc2it+mD83vv6iHdFsR9Hi+zfUHu44oROTjddLAV5sPLo\n' +
  '+hPxlwNwSDIrMCJhlQVkPBfT1jkSlczdyvCk8KhiA494aTXQ+nIJHGA87e1QnL+x\n' +
  'bMPpFDR67Vyo6vkmchmq3GV8f/yekhw1tl4wKEOz/jU3GQGSIDmOJfti3kZQ0sLL\n' +
  'nQIDAQAB\n' +
  '-----END PUBLIC KEY-----\n';

export const TEST_PROJECT_ID = 'medguard-test';

export const TEST_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: TEST_PROJECT_ID,
  client_email: 'medguard@medguard-test.iam.gserviceaccount.invalid',
  private_key: TEST_PRIVATE_KEY_PEM,
});
