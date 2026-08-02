import { decodeBase64Url } from './base64url.js';

/**
 * Subscribes to push, reusing an existing subscription if its key already matches.
 *
 * The mismatch check matters: if the browser already holds a subscription registered against
 * a previous VAPID key (e.g. a dev key from an earlier run), silently reusing it means every
 * push the server signs with the new key gets rejected by the push service — and nothing about
 * that failure is visible from the client side.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  const registration = await navigator.serviceWorker.ready;
  const desiredKey = decodeBase64Url(vapidPublicKey);

  let subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    const existingKeyBuffer = subscription.options.applicationServerKey;
    const existingKey = existingKeyBuffer ? new Uint8Array(existingKeyBuffer) : null;
    const matches =
      existingKey !== null &&
      existingKey.length === desiredKey.length &&
      existingKey.every((byte, index) => byte === desiredKey[index]);

    if (!matches) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }

  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: desiredKey as BufferSource,
  });

  return subscription.toJSON();
}

export async function unsubscribeFromPush(): Promise<boolean> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? subscription.unsubscribe() : false;
}

export async function getCurrentSubscription(): Promise<PushSubscriptionJSON | null> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? subscription.toJSON() : null;
}
