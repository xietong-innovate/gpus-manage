// 解析器与虚拟环境识别的 fixture 自测（node test/parser-fixture.mjs）
import assert from 'node:assert';
import { parseGpuScriptOutput, parseProcessLines } from '../server/collector.js';
import { resolveEnvName, parseIpLine } from '../server/util.js';

// fixture：真实 nvidia-smi 输出样例
const gpuScriptOut = [
  '==GPU==',
  '0, GPU-abc-123, NVIDIA GeForce RTX 3090, 24576, 22300, 97, 71, [Not Supported]',
  '1, GPU-def-456, NVIDIA A100 80GB PCIe, 81920, 4300, 35, 52, 1',
  '==APPS==',
  'GPU-abc-123, 8412, 18600',
  'GPU-abc-123, 8455, 2100',
  'GPU-def-456, 9014, 3900',
  '==DRV==',
  '550.54.15',
  '==END==',
].join('\n');

const p = parseGpuScriptOutput(gpuScriptOut);
assert.strictEqual(p.error, null);
assert.strictEqual(p.gpus.length, 2);
assert.strictEqual(p.gpus[0].uuid, 'GPU-abc-123');
assert.strictEqual(p.gpus[0].totalMemMB, 24576);
assert.strictEqual(p.gpus[0].usedMemMB, 22300);
assert.strictEqual(p.gpus[0].eccErr, null); // [Not Supported] → null
assert.strictEqual(p.gpus[1].eccErr, '1');
assert.strictEqual(p.apps.length, 3);
assert.strictEqual(p.driver, '550.54.15');

// fixture：无 GPU / NVML 报错
const bad = parseGpuScriptOutput('==GPU==\nNVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.\n==APPS==\n==DRV==\n==END==');
assert.ok(bad.error && bad.error.includes('GPU 清单采集失败'));

// fixture：进程信息行（cmdline 含 | 不应截断错乱）
const procOut = '8412|zhang|/home/zhang/miniconda3/envs/llm-ft/bin/python|275040|train_llm.py --steps 120000\n8455|zhang|/home/zhang/proj/rag-eval/.venv/bin/python|22320|evaluate.py --data a|b';
const procs = parseProcessLines(procOut);
assert.strictEqual(procs.get(8412).user, 'zhang');
assert.strictEqual(procs.get(8412).etimes, 275040);
assert.strictEqual(procs.get(8455).cmd, 'evaluate.py --data a|b'); // 尾字段含 | 需完整还原
assert.strictEqual(procs.get(9999), undefined);

// 虚拟环境识别（PRD 6.2 五种口径）
assert.deepStrictEqual(resolveEnvName('/home/z/miniconda3/envs/llm-ft/bin/python'), { kind: 'conda', label: 'conda:llm-ft' });
assert.deepStrictEqual(resolveEnvName('/home/z/proj/rag-eval/.venv/bin/python'), { kind: 'venv', label: 'venv:rag-eval' });
assert.deepStrictEqual(resolveEnvName('/opt/shared-venv/bin/python'), { kind: 'venv', label: 'venv:shared-venv' });
assert.deepStrictEqual(resolveEnvName('/usr/bin/python3'), { kind: 'system', label: 'system-python' });
assert.deepStrictEqual(resolveEnvName('/usr/local/bin/srv_4096.bin'), { kind: 'nonpython', label: '非Python:srv_4096.bin' });
assert.deepStrictEqual(resolveEnvName(''), { kind: 'unknown', label: '未知' });

// IP 行解析
assert.deepStrictEqual(parseIpLine('192.168.1.20'), { ip: '192.168.1.20', port: 22 });
assert.deepStrictEqual(parseIpLine('192.168.1.21:22'), { ip: '192.168.1.21', port: 22 });
assert.strictEqual(parseIpLine('192.168.1.999'), null);
assert.strictEqual(parseIpLine('abc'), null);
assert.strictEqual(parseIpLine('192.168.1.20:0'), null);

console.log('parser fixtures: ALL PASS');
