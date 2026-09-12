import { toast } from 'sonner';
import { runtimeFetch } from '@/lib/runtime-fetch';

const SMALL_MODEL_TOAST_ID = 'small-model-unavailable';

const notifySmallModelUnavailable = (): void => {
  toast.error('小模型不可用', {
    id: SMALL_MODEL_TOAST_ID,
    description: '请到「设置 → 会话 → 小模型」中改选其他模型后重试。',
  });
};

export async function requestSmallModel(
  init: RequestInit,
  options: { silentStatuses?: number[] } = {},
): Promise<Response> {
  try {
    const response = await runtimeFetch('/api/small-model/generate', init);
    if (!response.ok && !options.silentStatuses?.includes(response.status)) {
      notifySmallModelUnavailable();
    }
    return response;
  } catch (error) {
    notifySmallModelUnavailable();
    throw error;
  }
}
