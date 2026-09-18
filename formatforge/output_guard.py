"""FF-M-protocol/audit: `--output-file` 的写入边界。

旧实现 `mkdir(parents=True, exist_ok=True)` + `write_text` 接受任意路径：
`--output-file ../../.dsh/config.json` 这类目标可被模型驱动的工具调用写入
（与 H11 同类的无沙箱写原语）。这里把可写范围收敛到**用户声明的根**：

  1. `FF_OUTPUT_ROOT` 环境变量（可多个，用 `os.pathsep` 分隔）——显式声明优先；
  2. 未声明时退回 CLI 进程 CWD（工具调用方 spawn 时的工作目录）；
  3. 再加上源文件所在目录（用户自己给出的那个路径所在处）。

越界即抛 `OutputPathError`，由调用方转成 `bad_request` 协议错误——不再
「静默警告 + ok:true」。
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path


class OutputPathError(ValueError):
    """目标路径不在任何允许根内（协议层应报 bad_request）。"""


def _absolute(path: Path) -> Path:
    """尽量 resolve；失败也不抛（只保证绝对化）。"""
    try:
        return path.expanduser().resolve()
    except OSError:  # pragma: no cover - 平台相关防御
        return path.expanduser().absolute()


def allowed_output_roots(*, source: Path | None = None) -> list[Path]:
    """当前允许写入的根目录列表（已绝对化、去重、顺序稳定）。"""
    roots: list[Path] = []
    declared = os.environ.get("FF_OUTPUT_ROOT")
    if declared:
        roots.extend(Path(chunk.strip()) for chunk in declared.split(os.pathsep) if chunk.strip())
    if not roots:
        roots.append(Path.cwd())
    if source is not None:
        src = Path(source)
        with contextlib.suppress(OSError):  # pragma: no cover - 防御
            roots.append(src if src.is_dir() else src.parent)

    resolved: list[Path] = []
    for root in roots:
        root_abs = _absolute(root)
        if root_abs not in resolved:
            resolved.append(root_abs)
    return resolved


def resolve_output_path(
    target: str | Path,
    *,
    source: Path | None = None,
    label: str = "--output-file",
) -> Path:
    """校验目标路径并返回可写绝对路径；越界抛 OutputPathError。"""
    resolved = _absolute(Path(target))
    roots = allowed_output_roots(source=source)
    for root in roots:
        if resolved.is_relative_to(root):
            return resolved
    raise OutputPathError(
        f"{label} 目标越界：{resolved} 不在任何允许根内；"
        f"允许根 = {', '.join(str(r) for r in roots)}。"
        f"如需写入其他位置，请用 FF_OUTPUT_ROOT 声明（多个用 '{os.pathsep}' 分隔）。"
    )
