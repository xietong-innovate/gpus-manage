// 公共工具：IP 校验、行解析、虚拟环境识别（PRD 6.2 唯一口径）、Cookie 解析

export function isValidIPv4(ip) {
  const m = String(ip || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((s) => Number(s) <= 255);
}

// 支持 "1.2.3.4" 或 "1.2.3.4:22"，返回 {ip, port} 或 null
export function parseIpLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const idx = s.lastIndexOf(':');
  if (idx > 0) {
    const ip = s.slice(0, idx);
    const port = Number(s.slice(idx + 1));
    if (!isValidIPv4(ip) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { ip, port };
  }
  return isValidIPv4(s) ? { ip: s, port: 22 } : null;
}

// 虚拟环境识别（PRD 6.2）：依据进程可执行路径，返回 {kind, label}
// kind ∈ conda | venv | system | nonpython | unknown，label 为全系统统一徽章文案
export function resolveEnvName(exePath) {
  if (!exePath) return { kind: 'unknown', label: '未知' };
  const seg = String(exePath).split(/[\/\\]/).filter(Boolean);
  const base = seg[seg.length - 1] || '';
  if (/^python(\d+(\.\d+)*)?(\.exe)?$/.test(base) || /^pythonw(\.exe)?$/.test(base)) {
    // conda：.../envs/<名称>/bin|Scripts/python(.exe)（Windows: C:\...\anaconda3\envs\llm\python.exe）
    const i = seg.findIndex((x) => x === 'envs');
    if (i >= 0 && seg[i + 1]) return { kind: 'conda', label: `conda:${seg[i + 1]}` };
    // venv 根目录：名为 venv/.venv/env，或以 -venv/_venv/.venv 结尾的自定义目录（Windows: proj\.venv\Scripts\python.exe → venv:proj）
    const vi = seg.findIndex((x) => ['venv', '.venv', 'env', '.virtualenvs'].includes(x) || /[-_.]?venv$/.test(x));
    if (vi >= 0) {
      const dir = seg[vi];
      const label = ['venv', '.venv', 'env'].includes(dir) ? seg[vi - 1] || dir : dir;
      return { kind: 'venv', label: `venv:${label}` };
    }
    return { kind: 'system', label: 'system-python' };
  }
  return { kind: 'nonpython', label: `非Python:${base}` };
}

export function nowISO() {
  return new Date().toISOString();
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    out[s.slice(0, eq)] = decodeURIComponent(s.slice(eq + 1));
  }
  return out;
}

export function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function unb64url(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}
