/**
 * The composer's prompt-enhancement action.
 *
 * Two orderings are load-bearing, and both exist because the request outlives
 * the click:
 *
 * - One rewrite at a time. A second click while a request is in flight would
 *   race two replacements into the same composer, so the button is disabled for
 *   the duration and the hook refuses re-entry on its own.
 * - The draft is only replaced when it is still the text that was sent. The
 *   model takes seconds, and typing during them is the user's newest intent;
 *   a stale rewrite that overwrote it would be the worst possible outcome of a
 *   convenience button. When the draft moved, the result is dropped and said so.
 *
 * The replacement is applied through the composer's controlled value, so it
 * lands in the draft persistence, the mention bookkeeping and the editor's own
 * undo history (Ctrl+Z restores the original) without a second code path.
 */

import React from 'react';
import { toast } from 'sonner';

import { useI18n } from '@/lib/i18n';
import {
  PromptEnhanceError,
  requestPromptEnhancement,
  resolvePromptEnhanceModel,
} from '@/lib/promptEnhance';

export type PromptEnhanceController = {
  isEnhancing: boolean;
  enhance: () => void;
};

export type PromptEnhanceOptions = {
  sessionId: string | null;
  directory?: string;
  /** The live composer text, read when the button is pressed. */
  readDraft: () => string;
  /** Replace the composer text, the same way a restored draft does. */
  writeDraft: (text: string) => void;
};

export function usePromptEnhance(options: PromptEnhanceOptions): PromptEnhanceController {
  const { t } = useI18n();
  const [isEnhancing, setIsEnhancing] = React.useState(false);
  const inFlightRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(true);

  // The callbacks reach the request through a ref: a caller passing inline
  // functions must not restart an in-flight rewrite on the next render.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, []);

  const enhance = React.useCallback(() => {
    if (inFlightRef.current) return;

    const { sessionId, directory, readDraft, writeDraft } = optionsRef.current;
    const draft = readDraft();
    if (!draft.trim()) return;

    const controller = new AbortController();
    inFlightRef.current = controller;
    setIsEnhancing(true);

    const failureDescription = (reason: PromptEnhanceError['reason'] | 'failed'): string => {
      if (reason === 'tooLong') return t('chat.promptEnhance.errorTooLong');
      if (reason === 'unavailable') return t('chat.promptEnhance.errorUnavailable');
      return t('chat.promptEnhance.errorGeneric');
    };

    void (async () => {
      try {
        const result = await requestPromptEnhancement({
          text: draft,
          model: resolvePromptEnhanceModel(sessionId),
          sessionID: sessionId,
          directory,
          signal: controller.signal,
        });
        if (controller.signal.aborted || !mountedRef.current) return;

        if (readDraft() !== draft) {
          toast.info(t('chat.promptEnhance.draftChanged'));
          return;
        }

        writeDraft(result.text);
        toast.success(t('chat.promptEnhance.applied', { model: result.modelID }), {
          action: {
            label: t('chat.promptEnhance.undo'),
            // Only while the composer still holds the rewrite: an undo that
            // discarded edits made after it would be its own surprise.
            onClick: () => {
              if (readDraft() === result.text) writeDraft(draft);
            },
          },
        });
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current) return;
        const reason = error instanceof PromptEnhanceError ? error.reason : 'failed';
        toast.error(t('chat.promptEnhance.failed'), { description: failureDescription(reason) });
      } finally {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
          if (mountedRef.current) setIsEnhancing(false);
        }
      }
    })();
  }, [t]);

  return { isEnhancing, enhance };
}
