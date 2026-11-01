#!/usr/bin/env python3
"""WEA AI proxy: forwards the designer agent's chat requests to the LLM provider.

The API key never reaches the browser. Configuration (first found wins):
  1. environment: OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL (default https://api.openai.com/v1)
  2. config/ai.local.json  {"openai": {"apiKey": "...", "model": "...", "baseUrl": "..."}}   (git-ignored)
The browser sends provider-neutral requests already converted to the OpenAI Chat Completions shape
(web/ai/providers/openai.js); this module only adds the model and credentials, forwards, and returns
the response (or a readable error). Nothing is logged except status codes.
"""
import json, os, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / 'config' / 'ai.local.json'


def settings():
    cfg = {}
    if CONFIG.exists():
        try:
            cfg = json.loads(CONFIG.read_text('utf-8')).get('openai', {}) or {}
        except (ValueError, OSError) as e:
            return {'error': f'config/ai.local.json 无法读取：{e}'}
    key = os.environ.get('OPENAI_API_KEY') or cfg.get('apiKey') or ''
    if key.startswith('在此填写') or key.startswith('sk-...'):
        key = ''
    return {'apiKey': key, 'model': os.environ.get('OPENAI_MODEL') or cfg.get('model') or '',
            'baseUrl': (os.environ.get('OPENAI_BASE_URL') or cfg.get('baseUrl') or 'https://api.openai.com/v1').rstrip('/')}


def status():
    s = settings()
    if s.get('error'):
        return {'openai': {'configured': False, 'reason': s['error']}}
    reason = None if s['apiKey'] and s['model'] else ('未设置 API Key' if not s['apiKey'] else '未设置模型（model）')
    return {'openai': {'configured': reason is None, 'model': s['model'] or None, 'baseUrl': s['baseUrl'], 'reason': reason},
            'configFile': str(CONFIG.relative_to(ROOT))}


def chat(payload, timeout=180):
    """payload: {messages, tools, tool_choice?, temperature?} in Chat Completions shape. Returns (status, body)."""
    s = settings()
    if s.get('error') or not s['apiKey'] or not s['model']:
        return 503, {'error': 'OpenAI 尚未配置：' + (s.get('error') or ('请在 config/ai.local.json 填写 apiKey' if not s['apiKey'] else '请在 config/ai.local.json 填写 model')) + '，或使用“离线演示”'}
    body = {k: payload[k] for k in ('messages', 'tools', 'tool_choice', 'temperature', 'parallel_tool_calls') if k in payload}
    body['model'] = s['model']
    req = urllib.request.Request(s['baseUrl'] + '/chat/completions', data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s['apiKey']})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get('error', {}).get('message', '')
        except ValueError:
            detail = ''
        return e.code, {'error': f'OpenAI 返回 {e.code}：{detail or e.reason}'}
    except (urllib.error.URLError, TimeoutError) as e:
        return 502, {'error': f'无法连接 OpenAI：{getattr(e, "reason", e)}'}
