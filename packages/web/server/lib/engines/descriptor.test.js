import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_OPENCODE_DESCRIPTOR,
  EngineDescriptorError,
  describeEngineForApi,
  normalizeEngineDescriptor,
  parseEngineDescriptor,
} from './descriptor.js';

const valid = (overrides = {}) => ({
  apiVersion: 1,
  id: 'fake-engine',
  name: 'Fake Engine',
  protocol: 'opencode-v1',
  endpoint: { healthPath: '/global/health' },
  capabilities: ['sessions', 'streaming'],
  ...overrides,
});

describe('engine descriptor — 接受的形状', () => {
  test('最小合法描述符', () => {
    const { descriptor, warnings } = normalizeEngineDescriptor(valid());
    expect(descriptor.id).toBe('fake-engine');
    expect(descriptor.protocol).toBe('opencode-v1');
    expect(warnings).toEqual([]);
  });

  test('内置描述符自己能过校验（把内置的契约也钉住）', () => {
    const { descriptor } = normalizeEngineDescriptor({ ...BUILTIN_OPENCODE_DESCRIPTOR });
    expect(descriptor.id).toBe('opencode');
    expect(descriptor.capabilities).toContain('sessions');
    expect(descriptor.capabilities).toContain('diffs');
  });

  test('不认识的字段被忽略（与 guests 的 extra keys drop 一致）', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ 未来字段: { a: 1 }, whatever: true }));
    expect(descriptor.id).toBe('fake-engine');
    expect(descriptor['未来字段']).toBeUndefined();
  });

  test('surface 默认按 capabilities 推：能进聊天流就是 chat', () => {
    const { descriptor } = normalizeEngineDescriptor(valid());
    expect(descriptor.surface).toBe('chat');
  });

  test('surface 默认按 capabilities 推：不能进就是 panel', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ capabilities: ['tools'] }));
    expect(descriptor.surface).toBe('panel');
  });

  test('auth 缺省是 none；写了 basic 才带 username/passwordEnv', () => {
    expect(normalizeEngineDescriptor(valid()).descriptor.auth).toEqual({ type: 'none' });
    expect(normalizeEngineDescriptor(valid({ auth: { type: 'basic' } })).descriptor.auth).toEqual({
      type: 'basic', username: 'opencode', passwordEnv: 'OPENCODE_SERVER_PASSWORD',
    });
  });

  test('endpoint.url 是这个引擎自己的地址（多引擎并存的前提）', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096' } }));
    expect(descriptor.endpoint.url).toBe('http://codex-engine:4096');
    expect(describeEngineForApi(descriptor).endpointUrl).toBe('http://codex-engine:4096');
  });

  test('endpoint.url 末尾的斜杠被归一化（免得拼出 //global/health）', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ endpoint: { healthPath: '/h', url: 'http://x:1///' } }));
    expect(descriptor.endpoint.url).toBe('http://x:1');
  });

  test('不写 endpoint.url 时它缺席（= 用宿主那一个引擎的地址，向后兼容）', () => {
    const { descriptor } = normalizeEngineDescriptor(valid());
    expect(descriptor.endpoint.url).toBeUndefined();
    expect(describeEngineForApi(descriptor).endpointUrl).toBe(null);
  });
});

describe('engine descriptor — 拒绝的形状（每一条都要说清哪不对）', () => {
  const rejects = (input, fragment) => {
    let error = null;
    try {
      normalizeEngineDescriptor(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EngineDescriptorError);
    if (fragment) expect(`${error.code} ${error.message}`).toContain(fragment);
    return error;
  };

  test('不是对象', () => rejects([1, 2, 3]));
  test('apiVersion 不是 1', () => rejects(valid({ apiVersion: 2 }), 'apiVersion'));
  test('缺 id', () => rejects(valid({ id: '' }), 'id'));
  test('id 不是 kebab-case', () => rejects(valid({ id: 'Fake_Engine' }), 'kebab-case'));
  test('未知协议被拒绝（不是忽略）', () => rejects(valid({ protocol: 'codex-jsonrpc' }), 'protocol'));
  test('opencode-v1 缺 healthPath', () => rejects(valid({ endpoint: {} }), 'healthPath'));
  test('healthPath 不以 / 开头', () => rejects(valid({ endpoint: { healthPath: 'global/health' } }), 'healthPath'));
  test('未知 surface', () => rejects(valid({ surface: 'inline' }), 'surface'));
  test('endpoint.url 不是 URL', () => rejects(valid({ endpoint: { healthPath: '/h', url: 'codex-engine:4096' } }), 'endpoint.url'));
  test('endpoint.url 不是 http(s)', () => rejects(valid({ endpoint: { healthPath: '/h', url: 'ftp://x:1' } }), 'http'));

  test('capabilities 里混进非字符串 → 整个描述符拒绝（schema 在边界上把关）', () => {
    rejects(valid({ capabilities: ['sessions', 42] }), 'capabilities');
  });

  test('未知能力不是错误，而是 warning + 丢弃', () => {
    const { descriptor, warnings } = normalizeEngineDescriptor(valid({ capabilities: ['sessions', 'streaming', 'telepathy'] }));
    expect(descriptor.capabilities).toEqual(['sessions', 'streaming']);
    expect(warnings.join(' ')).toContain('telepathy');
  });

  test('完全没声明 capabilities → warning', () => {
    const { warnings } = normalizeEngineDescriptor(valid({ capabilities: undefined }));
    expect(warnings.join(' ')).toContain('capabilities');
  });

  test('声明 surface=chat 但能力不够 → 保留声明、但给出 warning', () => {
    const { descriptor, warnings } = normalizeEngineDescriptor(valid({ surface: 'chat', capabilities: ['tools'] }));
    expect(descriptor.surface).toBe('chat');
    expect(warnings.join(' ')).toContain('sessions');
  });
});

describe('engine descriptor — JSON 文本入口', () => {
  test('JSON 语法错误包成带文件名的 EngineDescriptorError', () => {
    let error = null;
    try {
      parseEngineDescriptor('{ not json', { source: '/etc/oc-engines/broken.json' });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe('INVALID_JSON');
    expect(error?.source).toBe('/etc/oc-engines/broken.json');
  });
});

describe('engine descriptor — 给 API 的公开形状', () => {
  test('带上 canServeChat / missingForChat / healthPath，且不泄露密码本身', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ auth: { type: 'basic', passwordEnv: 'MY_SECRET_ENV' } }));
    const api = describeEngineForApi(descriptor);
    expect(api.canServeChat).toBe(true);
    expect(api.missingForChat).toEqual([]);
    expect(api.healthPath).toBe('/global/health');
    expect(api.authType).toBe('basic');
    // 只暴露"去哪个环境变量取"，绝不把值带出来
    expect(JSON.stringify(api)).not.toContain('MY_SECRET_ENV=');
  });

  test('能力不够时 missingForChat 说得出缺什么', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ capabilities: ['streaming'] }));
    expect(describeEngineForApi(descriptor).canServeChat).toBe(false);
    expect(describeEngineForApi(descriptor).missingForChat).toEqual(['sessions']);
  });
});
