#!/bin/bash
# WEA launcher (macOS): finds Python 3.10+, installs the dependencies once into .venv (PyPI, then a China mirror),
# starts the local server; the server opens the browser itself when it is ready. Log: logs/wea.log
cd "$(dirname "$0")" || exit 1
mkdir -p logs
PY=""
for c in python3.12 python3.11 python3.10 /Library/Frameworks/Python.framework/Versions/3.1[0-2]/bin/python3 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo '未找到 Python 3.10 或更新版本。请从 https://www.python.org/downloads/ 安装 Python 3.11 后重新双击本文件。'
  echo "$(date) no python >= 3.10" >> logs/wea.log; read -r; exit 1
fi
if [ ! -f .venv/.wea-ok ]; then
  echo '首次运行：正在安装几何内核等组件（需要联网，约 3–5 分钟）…'
  [ -x .venv/bin/python ] || "$PY" -m venv .venv || { echo '创建 .venv 失败'; read -r; exit 1; }
  if .venv/bin/python -m pip install -r requirements.txt >> logs/install.log 2>&1 \
     || .venv/bin/python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple >> logs/install.log 2>&1; then
    touch .venv/.wea-ok; echo '安装完成。'
  else
    echo '部分组件安装失败（详见 logs/install.log）。仍可查看模型；下次启动会继续安装。'
  fi
fi
exec .venv/bin/python server.py
