import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Shared look for every screen in this sprint — the Android equivalent of
 * `apps/web/src/ui/primitives.tsx`. Dark-first and large tap targets, same rationale as web: this
 * app gets used half-asleep, in the dark. Colors are hex approximations of web's `oklch()`
 * palette (`apps/web/src/index.css`) — RN's StyleSheet has no `oklch()` support, so this is a
 * deliberate visual approximation, not a pixel-exact port.
 */

export const colors = {
  background: '#0f172a',
  surface: '#1e293b',
  border: '#334155',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  safe: '#4ade80',
  locked: '#f87171',
  capped: '#94a3b8',
  primary: '#38bdf8',
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 16 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 14, color: colors.textMuted },
  label: { fontSize: 13, color: colors.textMuted, marginBottom: 4 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  errorText: { color: colors.locked, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return <View style={[cardStyles.card, style]}>{children}</View>;
}

const cardStyles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    gap: 10,
    backgroundColor: colors.surface,
  },
});

export type BadgeTone = 'safe' | 'locked' | 'capped' | 'neutral';

const badgeToneColor: Record<BadgeTone, { bg: string; text: string }> = {
  safe: { bg: 'rgba(74, 222, 128, 0.15)', text: colors.safe },
  locked: { bg: 'rgba(248, 113, 113, 0.15)', text: colors.locked },
  capped: { bg: 'rgba(148, 163, 184, 0.2)', text: colors.text },
  neutral: { bg: colors.surface, text: colors.textMuted },
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }): React.JSX.Element {
  const { bg, text } = badgeToneColor[tone];
  return (
    <View style={[badgeStyles.badge, { backgroundColor: bg }]}>
      <Text style={[badgeStyles.text, { color: text }]}>{children}</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  badge: { borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, alignSelf: 'flex-start' },
  text: { fontSize: 12, fontWeight: '600' },
});

export type ButtonVariant = 'default' | 'primary' | 'danger';

const buttonVariantColor: Record<ButtonVariant, { bg: string; text: string; border?: string }> = {
  default: { bg: colors.surface, text: colors.text, border: colors.border },
  primary: { bg: colors.primary, text: '#04202e' },
  danger: { bg: 'rgba(248, 113, 113, 0.12)', text: colors.locked, border: colors.locked },
};

export function Button({
  label,
  onPress,
  disabled,
  variant = 'default',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
}): React.JSX.Element {
  const { bg, text, border } = buttonVariantColor[variant];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        buttonStyles.button,
        { backgroundColor: bg, borderColor: border ?? 'transparent' },
        disabled ? buttonStyles.disabled : null,
        pressed && !disabled ? buttonStyles.pressed : null,
      ]}
    >
      <Text style={[buttonStyles.label, { color: text }]}>{label}</Text>
    </Pressable>
  );
}

const buttonStyles = StyleSheet.create({
  button: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
  label: { fontSize: 14, fontWeight: '600' },
});
