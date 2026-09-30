import { useState } from 'react';
import { Linking, Pressable, Text } from 'react-native';
import { PRIVACY_POLICY_URL } from '@medguard/shared';
import { colors, styles as sharedStyles } from './primitives.js';

/**
 * Opens the privacy policy in the device's browser.
 *
 * The policy is a web page (served by the web app, see `PRIVACY_POLICY_URL`) rather than a screen
 * in this app, so there is exactly one copy to keep accurate. If the phone has no browser to hand
 * the link to, `openURL` rejects; the address is shown instead of the tap silently doing nothing.
 */
export function PrivacyPolicyLink(): React.JSX.Element {
  const [failed, setFailed] = useState(false);

  const open = () => {
    setFailed(false);
    Linking.openURL(PRIVACY_POLICY_URL).catch(() => setFailed(true));
  };

  return (
    <>
      <Pressable onPress={open} accessibilityRole="link">
        <Text style={{ fontSize: 13, color: colors.textMuted, textDecorationLine: 'underline' }}>
          Privacy policy
        </Text>
      </Pressable>
      {failed ? (
        <Text style={sharedStyles.errorText} accessibilityRole="alert">
          Couldn&rsquo;t open the link. The privacy policy is at {PRIVACY_POLICY_URL}
        </Text>
      ) : null}
    </>
  );
}
