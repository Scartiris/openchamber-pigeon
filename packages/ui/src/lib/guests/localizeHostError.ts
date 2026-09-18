/**
 * Host-side localization for guest HostRequestError outcomes.
 * Protocol `message` fields sent to guest panels stay English; this helper is
 * for host toasts/UI that must read as the product locale (zh-CN on this fork).
 */
import type { I18nKey } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { localizeServerMessage } from '../i18n/serverMessage';

type HostErrorCodeLike = string;

const HOST_ERROR_KEYS = {
  NOT_GRANTED: 'guests.host.notGranted',
  DISABLED: 'guests.host.extensionDisabled',
  HOST_REJECTED: 'guests.host.requestFailed',
  NO_DIRECTORY: 'guests.host.noProject',
  HOST_UNAVAILABLE: 'guests.service.noService',
  NOT_FOUND: 'guests.host.extensionUnavailable',
  DISCONNECTED: 'guests.host.requestFailed',
} as const satisfies Record<string, I18nKey>;

export function localizeGuestHostError(code?: HostErrorCodeLike | null, message?: string | null): string {
  const dictionary = useI18nStore.getState().dictionary;
  type HostCodeKey = keyof typeof HOST_ERROR_KEYS;
  const isHostCodeKey = (value: string): value is HostCodeKey =>
    Object.hasOwn(HOST_ERROR_KEYS, value);
  if (code && isHostCodeKey(code)) {
    return formatMessage(dictionary, HOST_ERROR_KEYS[code]);
  }
  return localizeServerMessage(dictionary, message) ?? message ?? formatMessage(dictionary, 'guests.host.operationFailed');
}
