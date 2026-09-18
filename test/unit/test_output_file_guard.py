"""
FF-M-protocol/audit 回归测试：`--help` 的 stdout 协议 + `--output-file` 写入边界。

1. `--help` 曾把 usage print 到 **stdout** 再 SystemExit(0)：stdout 唯一 JSON 出口
   被污染，JS 侧 python-runner 首行 parse 直接失败。现在 usage 走 stderr，
   stdout 只发一条协议 JSON（data.help 带全文）。
2. `--output-file` 曾 `mkdir(parents=True)` + 直接写任意路径（无沙箱写原语），
   且写入失败只 `logger.warning` 后照样 `ok:true`。现在收敛到用户声明的根
   （FF_OUTPUT_ROOT / CWD / 源文件目录），越界报 bad_request，失败报
   permission_denied。
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import pytest

from formatforge.__main__ import main


def _payload(captured) -> dict:
    lines = [line for line in captured.out.splitlines() if line.strip()]
    assert len(lines) == 1, f"stdout 必须只有一条协议 JSON，实际 {len(lines)} 行: {lines}"
    return json.loads(lines[0])


def _make_source(tmp_path: Path) -> Path:
    src = tmp_path / "src" / "note.txt"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text("hello formatforge\n", encoding="utf-8")
    return src


class TestHelpProtocol:
    def test_top_level_help_is_json_and_usage_goes_to_stderr(self, capsys):
        rc = main(["--help"])
        captured = capsys.readouterr()
        assert rc == 0
        payload = _payload(captured)
        assert payload["ok"] is True
        assert payload["code"] == 200
        assert "usage" in payload["data"]["help"].lower()
        # 人类可读的 usage 仍在 stderr（终端体验不丢）
        assert "usage" in captured.err.lower()
        assert "translate" in captured.err

    def test_subcommand_help_is_json(self, capsys):
        rc = main(["translate", "--help"])
        captured = capsys.readouterr()
        assert rc == 0
        payload = _payload(captured)
        assert payload["ok"] is True
        assert "output-file" in payload["data"]["help"]

    def test_help_short_flag(self, capsys):
        rc = main(["-h"])
        assert rc == 0
        assert _payload(capsys.readouterr())["ok"] is True

    def test_bad_args_still_single_json_error(self, capsys):
        """回归：argparse 错误路径不得因为 stdout 捕获而改变形状。"""
        rc = main(["nonexistent_subcmd"])
        captured = capsys.readouterr()
        assert rc != 0
        assert _payload(captured)["ok"] is False


class TestOutputFileGuard:
    def test_writes_next_to_source(self, tmp_path, capsys):
        src = _make_source(tmp_path)
        dst = tmp_path / "src" / "note.md"
        rc = main(["translate", str(src), "--format", "markdown", "--output-file", str(dst)])
        payload = _payload(capsys.readouterr())
        assert rc == 0 and payload["ok"] is True, payload
        assert dst.exists()
        assert payload["data"]["meta"]["output_file"] == str(dst.resolve())

    def test_outside_declared_roots_is_bad_request(self, tmp_path, capsys):
        """越界（既不在 CWD 也不在源文件目录）→ bad_request，且不建目录。"""
        src = _make_source(tmp_path)
        outside = tmp_path.parent / "elsewhere" / "leak.md"
        rc = main(["translate", str(src), "--output-file", str(outside)])
        payload = _payload(capsys.readouterr())
        assert payload["ok"] is False, payload
        assert payload["error"]["kind"] == "bad_request"
        assert rc == 7
        assert "FF_OUTPUT_ROOT" in payload["error"]["message"]
        assert not outside.exists()
        assert not outside.parent.exists(), "越界目标不应产生目录副作用"

    def test_ff_output_root_declaration_allows_outside(self, tmp_path, capsys, monkeypatch):
        src = _make_source(tmp_path)
        declared = tmp_path.parent / "declared_root"
        declared.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("FF_OUTPUT_ROOT", str(declared))
        dst = declared / "nested" / "ok.md"

        rc = main(["translate", str(src), "--format", "markdown", "--output-file", str(dst)])
        payload = _payload(capsys.readouterr())
        assert rc == 0 and payload["ok"] is True, payload
        assert dst.exists()

    def test_multiple_roots_use_pathsep(self, tmp_path, capsys, monkeypatch):
        import os

        src = _make_source(tmp_path)
        first = tmp_path.parent / "root_one"
        second = tmp_path.parent / "root_two"
        first.mkdir(parents=True, exist_ok=True)
        second.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("FF_OUTPUT_ROOT", os.pathsep.join([str(first), str(second)]))
        dst = second / "multi.md"

        rc = main(["translate", str(src), "--format", "markdown", "--output-file", str(dst)])
        assert _payload(capsys.readouterr())["ok"] is True
        assert rc == 0
        assert dst.exists()

    def test_write_failure_is_reported_not_swallowed(self, tmp_path, capsys):
        """父路径是文件 → mkdir 失败：必须 ok:false + permission_denied（不是 warn+ok）。"""
        src = _make_source(tmp_path)
        blocker = tmp_path / "src" / "blocker.txt"
        blocker.write_text("x", encoding="utf-8")
        dst = blocker / "cannot.md"

        rc = main(["translate", str(src), "--output-file", str(dst)])
        payload = _payload(capsys.readouterr())
        assert payload["ok"] is False, payload
        assert payload["error"]["kind"] == "permission_denied"
        assert rc == 2
        assert "写入失败" in payload["error"]["message"]


class TestOutputGuardUnit:
    def test_relative_path_resolves_under_cwd(self, monkeypatch, tmp_path):
        from formatforge.output_guard import allowed_output_roots, resolve_output_path

        monkeypatch.delenv("FF_OUTPUT_ROOT", raising=False)
        monkeypatch.chdir(tmp_path)
        resolved = resolve_output_path("sub/out.md")
        assert resolved == (tmp_path / "sub" / "out.md").resolve()
        assert allowed_output_roots() == [tmp_path.resolve()]

    def test_traversal_escape_is_denied(self, monkeypatch, tmp_path):
        from formatforge.output_guard import OutputPathError, resolve_output_path

        monkeypatch.delenv("FF_OUTPUT_ROOT", raising=False)
        inner = tmp_path / "inner"
        inner.mkdir(parents=True, exist_ok=True)
        monkeypatch.chdir(inner)
        with pytest.raises(OutputPathError):
            resolve_output_path("../escaped.md")

    def test_source_dir_root_is_included(self, tmp_path, monkeypatch):
        from formatforge.output_guard import allowed_output_roots

        monkeypatch.delenv("FF_OUTPUT_ROOT", raising=False)
        src = _make_source(tmp_path)
        roots = allowed_output_roots(source=src)
        assert (tmp_path / "src").resolve() in roots
